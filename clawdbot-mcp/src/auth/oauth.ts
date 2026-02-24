/**
 * OAuth 2.1 server implementation for MCP
 * Implements Authorization Code flow with PKCE + Refresh Tokens + TOTP
 */

import { randomBytes, createHash } from 'node:crypto';
import * as jose from 'jose';
import * as OTPAuth from 'otpauth';

interface OAuthClient {
  id: string;
  name: string;
  secret: string | null;
  redirectUris: string[];
  scopes: string[];
}

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope: string;
  expiresAt: number;
  userId: string;
}

interface RefreshTokenData {
  token: string;
  clientId: string;
  userId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export class OAuthServer {
  private clients: Map<string, OAuthClient> = new Map();
  private authCodes: Map<string, AuthorizationCode> = new Map();
  private refreshTokens: Map<string, RefreshTokenData> = new Map();
  private issuer: string;
  private tokenTtl: number;
  private refreshTokenTtl: number;
  private jwtSecret: Uint8Array;
  private totp: OTPAuth.TOTP | null = null;

  constructor(
    issuer: string, 
    tokenTtlSeconds: number, 
    clients: OAuthClient[],
    options?: {
      refreshTokenTtlSeconds?: number;
      totpSecret?: string;
      totpIssuer?: string;
      totpLabel?: string;
    }
  ) {
    this.issuer = issuer;
    this.tokenTtl = tokenTtlSeconds;
    this.refreshTokenTtl = options?.refreshTokenTtlSeconds || 30 * 24 * 60 * 60; // 30 days default
    
    // Generate a random secret for JWT signing (in production, use a persistent key)
    this.jwtSecret = new TextEncoder().encode(
      process.env.MCP_JWT_SECRET || randomBytes(32).toString('hex')
    );
    
    // Initialize TOTP if secret provided
    if (options?.totpSecret) {
      this.totp = new OTPAuth.TOTP({
        issuer: options.totpIssuer || 'Clawdbot MCP',
        label: options.totpLabel || 'MCP Auth',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(options.totpSecret),
      });
      console.log('[oauth] TOTP verification enabled');
    } else {
      console.warn('[oauth] Warning: TOTP not configured - authorization grants are unprotected');
    }
    
    for (const client of clients) {
      this.clients.set(client.id, client);
    }

    // Cleanup expired tokens periodically
    setInterval(() => this.cleanupExpiredTokens(), 60 * 60 * 1000); // Every hour
  }

  private cleanupExpiredTokens(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [token, data] of this.refreshTokens.entries()) {
      if (data.expiresAt < now) {
        this.refreshTokens.delete(token);
        cleaned++;
      }
    }
    
    for (const [code, data] of this.authCodes.entries()) {
      if (data.expiresAt < now) {
        this.authCodes.delete(code);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[oauth] Cleaned up ${cleaned} expired tokens/codes`);
    }
  }

  /**
   * Check if TOTP is required for authorization
   */
  isTotpRequired(): boolean {
    return this.totp !== null;
  }

  /**
   * Verify TOTP code
   */
  verifyTotp(code: string): boolean {
    if (!this.totp) {
      return true; // No TOTP configured, allow all
    }
    
    // Allow window of 1 period before/after for clock drift
    const delta = this.totp.validate({ token: code, window: 1 });
    return delta !== null;
  }

  /**
   * Get TOTP URI for adding to authenticator app (for setup)
   */
  getTotpUri(): string | null {
    return this.totp?.toString() || null;
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Register a new client dynamically (RFC 7591)
   */
  registerClient(registration: {
    client_name: string;
    redirect_uris: string[];
    scope?: string;
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }): Record<string, unknown> {
    const clientId = `dyn_${randomBytes(16).toString('hex')}`;
    const client: OAuthClient = {
      id: clientId,
      name: registration.client_name,
      secret: null, // Public client
      redirectUris: registration.redirect_uris,
      scopes: registration.scope?.split(' ') || ['*'],
    };
    this.clients.set(clientId, client);
    
    // RFC 7591 compliant response
    return {
      client_id: clientId,
      client_name: registration.client_name,
      redirect_uris: registration.redirect_uris,
      grant_types: registration.grant_types || ['authorization_code', 'refresh_token'],
      response_types: registration.response_types || ['code'],
      token_endpoint_auth_method: registration.token_endpoint_auth_method || 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Generate authorization code
   */
  generateAuthCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scope: string;
    userId: string;
  }): string {
    const code = randomBytes(32).toString('hex');
    const authCode: AuthorizationCode = {
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      scope: params.scope,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      userId: params.userId,
    };
    this.authCodes.set(code, authCode);
    return code;
  }

  /**
   * Generate refresh token
   */
  private generateRefreshToken(clientId: string, userId: string, scope: string): string {
    const token = randomBytes(48).toString('hex');
    const now = Date.now();
    
    this.refreshTokens.set(token, {
      token,
      clientId,
      userId,
      scope,
      createdAt: now,
      expiresAt: now + this.refreshTokenTtl * 1000,
    });
    
    return token;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<TokenData> {
    const authCode = this.authCodes.get(params.code);
    
    if (!authCode) {
      throw new Error('invalid_grant: Authorization code not found');
    }

    if (authCode.expiresAt < Date.now()) {
      this.authCodes.delete(params.code);
      throw new Error('invalid_grant: Authorization code expired');
    }

    if (authCode.clientId !== params.clientId) {
      throw new Error('invalid_grant: Client ID mismatch');
    }

    if (authCode.redirectUri !== params.redirectUri) {
      throw new Error('invalid_grant: Redirect URI mismatch');
    }

    // Verify PKCE
    if (authCode.codeChallenge) {
      if (!params.codeVerifier) {
        throw new Error('invalid_grant: Code verifier required');
      }

      let computedChallenge: string;
      if (authCode.codeChallengeMethod === 'S256') {
        computedChallenge = createHash('sha256')
          .update(params.codeVerifier)
          .digest('base64url');
      } else {
        computedChallenge = params.codeVerifier;
      }

      if (computedChallenge !== authCode.codeChallenge) {
        throw new Error('invalid_grant: Code verifier mismatch');
      }
    }

    // Delete used code
    this.authCodes.delete(params.code);

    // Generate tokens
    const accessToken = await this.generateAccessToken(authCode.userId, authCode.scope);
    const refreshToken = this.generateRefreshToken(authCode.clientId, authCode.userId, authCode.scope);

    console.log(`[oauth] Issued tokens for client ${authCode.clientId}, user ${authCode.userId}`);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.tokenTtl,
      tokenType: 'Bearer',
      scope: authCode.scope,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(params: {
    refreshToken: string;
    clientId: string;
    scope?: string;
  }): Promise<TokenData> {
    const tokenData = this.refreshTokens.get(params.refreshToken);
    
    if (!tokenData) {
      throw new Error('invalid_grant: Refresh token not found');
    }

    if (tokenData.expiresAt < Date.now()) {
      this.refreshTokens.delete(params.refreshToken);
      throw new Error('invalid_grant: Refresh token expired');
    }

    if (tokenData.clientId !== params.clientId) {
      throw new Error('invalid_grant: Client ID mismatch');
    }

    // Use requested scope or original scope
    const scope = params.scope || tokenData.scope;
    
    // Generate new access token
    const accessToken = await this.generateAccessToken(tokenData.userId, scope);
    
    // Rotate refresh token (issue new one, invalidate old)
    this.refreshTokens.delete(params.refreshToken);
    const newRefreshToken = this.generateRefreshToken(tokenData.clientId, tokenData.userId, scope);

    console.log(`[oauth] Refreshed tokens for client ${tokenData.clientId}, user ${tokenData.userId}`);

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: this.tokenTtl,
      tokenType: 'Bearer',
      scope,
    };
  }

  /**
   * Revoke a refresh token
   */
  revokeRefreshToken(token: string): boolean {
    return this.refreshTokens.delete(token);
  }

  /**
   * Generate JWT access token
   */
  private async generateAccessToken(userId: string, scope: string): Promise<string> {
    const jwt = await new jose.SignJWT({
      sub: userId,
      scope,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setAudience(this.issuer)
      .setExpirationTime(`${this.tokenTtl}s`)
      .sign(this.jwtSecret);

    return jwt;
  }

  /**
   * Verify access token
   */
  async verifyToken(token: string): Promise<{ userId: string; scope: string }> {
    try {
      const { payload } = await jose.jwtVerify(token, this.jwtSecret, {
        issuer: this.issuer,
        audience: this.issuer,
      });

      return {
        userId: payload.sub as string,
        scope: payload.scope as string,
      };
    } catch {
      throw new Error('invalid_token: Token verification failed');
    }
  }

  /**
   * Get OAuth metadata (RFC 8414)
   */
  getMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      revocation_endpoint: `${this.issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['*'],
    };
  }
}
