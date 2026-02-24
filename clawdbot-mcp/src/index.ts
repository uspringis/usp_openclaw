/**
 * Clawdbot MCP Server
 * Exposes Clawdbot tools to Claude.ai via MCP protocol
 * Uses Streamable HTTP transport in stateless mode
 * 
 * Features:
 * - Request deduplication: Same session+tool+args returns existing result
 * - Progress notifications: Sent every 3s during long-running operations
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { OAuthServer } from './auth/oauth.js';
import { GatewayClient } from './gateway/client.js';

// Configuration
const PORT = parseInt(process.env.MCP_PORT || '3000', 10);
const HOST = process.env.MCP_HOST || '127.0.0.1';
const BASE_URL = process.env.MCP_BASE_URL || `http://localhost:${PORT}`;
const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN || '';
const TOTP_SECRET = process.env.MCP_TOTP_SECRET || ''; // Base32 encoded secret
const ACCESS_TOKEN_TTL = parseInt(process.env.MCP_ACCESS_TOKEN_TTL || '3600', 10); // 1 hour default
const REFRESH_TOKEN_TTL = parseInt(process.env.MCP_REFRESH_TOKEN_TTL || '2592000', 10); // 30 days default

// Progress notification interval (ms)
const PROGRESS_INTERVAL_MS = 3000;
// Maximum time to wait for in-flight request (ms)
const MAX_WAIT_TIME_MS = 5 * 60 * 1000; // 5 minutes

// Initialize Gateway client
const gateway = new GatewayClient(GATEWAY_URL, GATEWAY_TOKEN);

// Initialize OAuth server with TOTP if configured
const oauth = new OAuthServer(
  BASE_URL, 
  ACCESS_TOKEN_TTL, 
  [
    {
      id: 'claude-web',
      name: 'Claude.ai',
      secret: null,
      redirectUris: ['https://claude.ai/oauth/callback'],
      scopes: ['*'],
    },
  ],
  {
    refreshTokenTtlSeconds: REFRESH_TOKEN_TTL,
    totpSecret: TOTP_SECRET || undefined,
    totpIssuer: 'Clawdbot MCP',
    totpLabel: 'MCP Authorization',
  }
);

// ============ Request Deduplication ============

interface InFlightRequest {
  promise: Promise<string>;
  startedAt: number;
  waiters: Array<{
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }>;
}

// Track in-flight requests: hash -> { promise, waiters }
const inFlightRequests = new Map<string, InFlightRequest>();

function computeRequestHash(sessionId: string, toolName: string, args: Record<string, unknown>): string {
  const data = JSON.stringify({ sessionId, toolName, args });
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// Cleanup stale in-flight requests periodically
setInterval(() => {
  const now = Date.now();
  for (const [hash, request] of inFlightRequests.entries()) {
    if (now - request.startedAt > MAX_WAIT_TIME_MS) {
      // Reject all waiters with timeout
      for (const waiter of request.waiters) {
        waiter.reject(new Error('Request timed out'));
      }
      inFlightRequests.delete(hash);
      console.log(`[cleanup] Removed stale in-flight request: ${hash}`);
    }
  }
}, 30000);

// ============ Progress Notification Helper ============

interface ProgressContext {
  server: Server;
  progressToken?: string | number;
  progressValue: number;
  startTime: number;
  intervalId?: ReturnType<typeof setInterval>;
}

function startProgressNotifications(ctx: ProgressContext): void {
  if (!ctx.progressToken) return;
  
  ctx.intervalId = setInterval(async () => {
    ctx.progressValue += 1;
    const elapsedSec = Math.round((Date.now() - ctx.startTime) / 1000);
    
    try {
      await ctx.server.notification({
        method: 'notifications/progress',
        params: {
          progressToken: ctx.progressToken!,
          progress: ctx.progressValue,
          message: `Processing... (${elapsedSec}s elapsed)`,
        },
      });
    } catch (err) {
      // Ignore notification errors - client may have disconnected
      console.log(`[progress] Failed to send notification: ${err}`);
    }
  }, PROGRESS_INTERVAL_MS);
}

function stopProgressNotifications(ctx: ProgressContext): void {
  if (ctx.intervalId) {
    clearInterval(ctx.intervalId);
    ctx.intervalId = undefined;
  }
}

// ============ Create Express App ============

const app = express();

// Request logging with response status
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms from ${req.headers['x-forwarded-for'] || req.ip}`);
  });
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id');
  res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============ OAuth Endpoints ============

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(oauth.getMetadata());
});

// RFC8414 path format: /.well-known/oauth-authorization-server/mcp-api
app.get('/oauth-authorization-server/mcp-api', (req, res) => {
  res.json(oauth.getMetadata());
});
app.get('/oauth-authorization-server/*', (req, res) => {
  res.json(oauth.getMetadata());
});

// OpenID Connect discovery (alias for OAuth metadata)
app.get('/.well-known/openid-configuration', (req, res) => {
  res.json(oauth.getMetadata());
});

// RFC8414 path format for openid-configuration
app.get('/openid-configuration/mcp-api', (req, res) => {
  res.json(oauth.getMetadata());
});
app.get('/openid-configuration/*', (req, res) => {
  res.json(oauth.getMetadata());
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['*'],
  });
});

// RFC9728 path format for protected resource
app.get('/oauth-protected-resource/mcp-api', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['*'],
  });
});
app.get('/oauth-protected-resource/*', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    scopes_supported: ['*'],
  });
});

app.post('/register', (req, res) => {
  try {
    const result = oauth.registerClient(req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: 'invalid_client_metadata' });
  }
});

app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('Unsupported response_type');
  }

  const client = oauth.getClient(client_id as string);
  if (!client) {
    return res.status(400).send('Unknown client');
  }

  const totpRequired = oauth.isTotpRequired();
  const totpField = totpRequired ? `
        <div class="totp-field">
          <label for="totp_code">Verification Code (TOTP)</label>
          <input type="text" id="totp_code" name="totp_code" 
                 placeholder="Enter 6-digit code" 
                 pattern="[0-9]{6}" 
                 inputmode="numeric"
                 autocomplete="one-time-code"
                 required>
        </div>` : '';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Clawdbot MCP - Authorize</title>
      <style>
        body { font-family: system-ui; max-width: 400px; margin: 100px auto; padding: 20px; }
        h1 { color: #333; }
        .client { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .totp-field { margin: 20px 0; }
        .totp-field label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
        .totp-field input { 
          width: 100%; padding: 12px; font-size: 18px; text-align: center;
          border: 2px solid #ddd; border-radius: 6px; box-sizing: border-box;
          letter-spacing: 8px; font-family: monospace;
        }
        .totp-field input:focus { border-color: #007bff; outline: none; }
        button { background: #007bff; color: white; border: none; padding: 12px 24px; 
                 border-radius: 6px; cursor: pointer; font-size: 16px; width: 100%; }
        button:hover { background: #0056b3; }
        .cancel { background: #6c757d; margin-top: 10px; }
        .error { background: #f8d7da; color: #721c24; padding: 10px; border-radius: 6px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>Clawdbot MCP</h1>
      <div class="client">
        <strong>${client.name}</strong> wants to access your Clawdbot instance.
      </div>
      <form method="POST" action="${BASE_URL}/authorize">
        <input type="hidden" name="client_id" value="${client_id}">
        <input type="hidden" name="redirect_uri" value="${redirect_uri}">
        <input type="hidden" name="scope" value="${scope || '*'}">
        <input type="hidden" name="state" value="${state || ''}">
        <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
        <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}">
        ${totpField}
        <button type="submit" name="action" value="approve">Authorize</button>
        <button type="submit" name="action" value="deny" class="cancel">Deny</button>
      </form>
    </body>
    </html>
  `);
});

app.post('/authorize', (req, res) => {
  const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, action, totp_code } = req.body;

  if (action === 'deny') {
    const url = new URL(redirect_uri);
    url.searchParams.set('error', 'access_denied');
    if (state) url.searchParams.set('state', state);
    return res.redirect(url.toString());
  }

  // Verify TOTP if required
  if (oauth.isTotpRequired()) {
    if (!totp_code || !oauth.verifyTotp(totp_code)) {
      const client = oauth.getClient(client_id);
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Clawdbot MCP - Authorization Failed</title>
          <style>
            body { font-family: system-ui; max-width: 400px; margin: 100px auto; padding: 20px; }
            h1 { color: #333; }
            .error { background: #f8d7da; color: #721c24; padding: 15px; border-radius: 8px; margin: 20px 0; }
            .client { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
            .totp-field { margin: 20px 0; }
            .totp-field label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
            .totp-field input { 
              width: 100%; padding: 12px; font-size: 18px; text-align: center;
              border: 2px solid #dc3545; border-radius: 6px; box-sizing: border-box;
              letter-spacing: 8px; font-family: monospace;
            }
            .totp-field input:focus { border-color: #007bff; outline: none; }
            button { background: #007bff; color: white; border: none; padding: 12px 24px; 
                     border-radius: 6px; cursor: pointer; font-size: 16px; width: 100%; }
            button:hover { background: #0056b3; }
            .cancel { background: #6c757d; margin-top: 10px; }
          </style>
        </head>
        <body>
          <h1>Clawdbot MCP</h1>
          <div class="error">Invalid verification code. Please try again.</div>
          <div class="client">
            <strong>${client?.name || 'Unknown'}</strong> wants to access your Clawdbot instance.
          </div>
          <form method="POST" action="${BASE_URL}/authorize">
            <input type="hidden" name="client_id" value="${client_id}">
            <input type="hidden" name="redirect_uri" value="${redirect_uri}">
            <input type="hidden" name="scope" value="${scope || '*'}">
            <input type="hidden" name="state" value="${state || ''}">
            <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
            <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}">
            <div class="totp-field">
              <label for="totp_code">Verification Code (TOTP)</label>
              <input type="text" id="totp_code" name="totp_code" 
                     placeholder="Enter 6-digit code" 
                     pattern="[0-9]{6}" 
                     inputmode="numeric"
                     autocomplete="one-time-code"
                     autofocus
                     required>
            </div>
            <button type="submit" name="action" value="approve">Authorize</button>
            <button type="submit" name="action" value="deny" class="cancel">Deny</button>
          </form>
        </body>
        </html>
      `);
    }
    console.log('[oauth] TOTP verification successful');
  }

  const code = oauth.generateAuthCode({
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    scope: scope || '*',
    userId: 'owner',
  });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/token', async (req, res) => {
  const { grant_type, code, client_id, redirect_uri, code_verifier, refresh_token, scope } = req.body;

  try {
    let tokens;
    
    if (grant_type === 'authorization_code') {
      tokens = await oauth.exchangeCode({
        code,
        clientId: client_id,
        redirectUri: redirect_uri,
        codeVerifier: code_verifier,
      });
    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
      }
      tokens = await oauth.refreshAccessToken({
        refreshToken: refresh_token,
        clientId: client_id,
        scope: scope,
      });
    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    res.json({
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      scope: tokens.scope,
      refresh_token: tokens.refreshToken,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const [errorCode] = message.split(':');
    res.status(400).json({ error: errorCode || 'invalid_grant', error_description: message });
  }
});

// Token revocation endpoint (RFC 7009)
app.post('/revoke', (req, res) => {
  const { token, token_type_hint } = req.body;
  
  if (token) {
    // Try to revoke as refresh token (we don't revoke access tokens as they're JWTs)
    oauth.revokeRefreshToken(token);
  }
  
  // Always return 200 per RFC 7009
  res.sendStatus(200);
});

// ============ Auth Middleware ============

async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const tokenData = await oauth.verifyToken(token);
    (req as any).auth = tokenData;
    next();
  } catch {
    res.setHeader('WWW-Authenticate', `Bearer error="invalid_token"`);
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// ============ MCP Tools ============

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List active Clawdbot conversations/sessions with their recent messages',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'send_message',
    description: 'Send a message to an existing Clawdbot conversation. The agent will process it and respond.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionKey: { type: 'string', description: 'The session key to send to (from list_sessions)' },
        message: { type: 'string', description: 'The message to send to the Clawdbot agent' },
      },
      required: ['sessionKey', 'message'],
    },
  },
  {
    name: 'get_history',
    description: 'Get message history from a Clawdbot conversation',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionKey: { type: 'string', description: 'The session key (from list_sessions)' },
        limit: { type: 'number', description: 'Max messages to return (default 20)' },
      },
      required: ['sessionKey'],
    },
  },
];

async function executeToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'list_sessions': {
      const sessions = await gateway.listSessions();
      return JSON.stringify(sessions, null, 2);
    }
    case 'send_message': {
      const { sessionKey, message } = args as { sessionKey: string; message: string };
      const result = await gateway.sendToSession(sessionKey, message);
      return JSON.stringify(result, null, 2);
    }
    case 'get_history': {
      const { sessionKey, limit } = args as { sessionKey: string; limit?: number };
      const history = await gateway.getSessionHistory(sessionKey, limit || 20);
      return JSON.stringify(history, null, 2);
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

/**
 * Handle a tool call with deduplication and progress notifications.
 * If the same request is already in-flight, wait for it instead of executing again.
 */
async function handleToolCall(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  progressCtx?: ProgressContext
): Promise<string> {
  const requestHash = computeRequestHash(sessionId, name, args);
  
  // Check if this exact request is already in-flight
  const existing = inFlightRequests.get(requestHash);
  if (existing) {
    console.log(`[dedup] Request ${requestHash} already in-flight, waiting for result...`);
    
    // Wait for the existing request to complete
    return new Promise<string>((resolve, reject) => {
      existing.waiters.push({ resolve, reject });
    });
  }
  
  // This is a new request - execute it
  console.log(`[exec] Starting request ${requestHash}: ${name}`);
  
  // Start progress notifications if we have a progress token
  if (progressCtx) {
    startProgressNotifications(progressCtx);
  }
  
  // Create a promise for this request
  const executePromise = executeToolCall(name, args);
  
  // Track the in-flight request
  const inFlight: InFlightRequest = {
    promise: executePromise,
    startedAt: Date.now(),
    waiters: [],
  };
  inFlightRequests.set(requestHash, inFlight);
  
  try {
    const result = await executePromise;
    
    // Stop progress notifications
    if (progressCtx) {
      stopProgressNotifications(progressCtx);
    }
    
    // Resolve all waiters with the same result
    for (const waiter of inFlight.waiters) {
      waiter.resolve(result);
    }
    
    console.log(`[exec] Completed request ${requestHash} (${inFlight.waiters.length} waiters)`);
    return result;
    
  } catch (error) {
    // Stop progress notifications
    if (progressCtx) {
      stopProgressNotifications(progressCtx);
    }
    
    // Reject all waiters with the same error
    const err = error instanceof Error ? error : new Error(String(error));
    for (const waiter of inFlight.waiters) {
      waiter.reject(err);
    }
    
    console.log(`[exec] Failed request ${requestHash}: ${err.message}`);
    throw error;
    
  } finally {
    // Remove from in-flight tracking
    inFlightRequests.delete(requestHash);
  }
}

function createMcpServer(sessionId: string): Server {
  const server = new Server(
    { name: 'clawdbot-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    
    // Extract progress token from request metadata
    const progressToken = request.params._meta?.progressToken;
    
    // Create progress context if we have a token
    const progressCtx: ProgressContext | undefined = progressToken ? {
      server,
      progressToken,
      progressValue: 0,
      startTime: Date.now(),
    } : undefined;
    
    try {
      const result = await handleToolCall(sessionId, name, args || {}, progressCtx);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

// ============ MCP Stateful Sessions ============

// Store sessions: sessionId -> { transport, server }
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

// Session cleanup interval (cleanup sessions older than 1 hour)
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const sessionLastAccess = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, lastAccess] of sessionLastAccess.entries()) {
    if (now - lastAccess > SESSION_MAX_AGE_MS) {
      const session = sessions.get(sessionId);
      if (session) {
        session.transport.close();
        sessions.delete(sessionId);
        sessionLastAccess.delete(sessionId);
        console.log(`[cleanup] Session expired: ${sessionId}`);
      }
    }
  }
}, 60000);

// MCP endpoint
app.all('/mcp', requireAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    // Check if this is an initialize request (new session)
    if (req.method === 'POST' && req.body && isInitializeRequest(req.body)) {
      // Create new session
      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });
      const server = createMcpServer(newSessionId);
      
      await server.connect(transport);
      sessions.set(newSessionId, { transport, server });
      sessionLastAccess.set(newSessionId, Date.now());
      
      console.log(`New session: ${newSessionId}`);
      
      // Handle the request
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Existing session - need session ID
    if (!sessionId) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Mcp-Session-Id header required for non-initialize requests' },
        id: null,
      });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Session not found' },
        id: null,
      });
    }

    // Update last access time
    sessionLastAccess.set(sessionId, Date.now());

    // Handle request with existing session
    await session.transport.handleRequest(req, res, req.body);

  } catch (error) {
    console.error('MCP error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
        id: null,
      });
    }
  }
});

// Session cleanup endpoint
app.delete('/mcp', requireAuth, (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session?.transport.close();
    sessions.delete(sessionId);
    sessionLastAccess.delete(sessionId);
    console.log(`Session deleted: ${sessionId}`);
  }
  res.sendStatus(204);
});

// ============ Other Endpoints ============

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '1.0.0', 
    sessions: sessions.size,
    inFlightRequests: inFlightRequests.size,
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Clawdbot MCP Server',
    version: '1.0.0',
    mcp_endpoint: `${BASE_URL}/mcp`,
    oauth_metadata: `${BASE_URL}/.well-known/oauth-authorization-server`,
  });
});

// ============ Start Server ============

app.listen(PORT, HOST, () => {
  console.log(`Clawdbot MCP Server running at http://${HOST}:${PORT}`);
  console.log(`MCP endpoint: ${BASE_URL}/mcp`);
  console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`Access token TTL: ${ACCESS_TOKEN_TTL}s, Refresh token TTL: ${REFRESH_TOKEN_TTL}s`);
  console.log(`TOTP verification: ${TOTP_SECRET ? 'ENABLED' : 'DISABLED (set MCP_TOTP_SECRET to enable)'}`);
  console.log(`Features: request deduplication, progress notifications (${PROGRESS_INTERVAL_MS}ms), refresh tokens`);
  if (!GATEWAY_TOKEN) {
    console.warn('Warning: CLAWDBOT_GATEWAY_TOKEN not set');
  }
  
  // Show TOTP setup URI if enabled (only on first start, for setup)
  if (TOTP_SECRET) {
    const totpUri = oauth.getTotpUri();
    if (totpUri) {
      console.log(`\nTOTP Setup URI (add to authenticator app):\n${totpUri}\n`);
    }
  }
});
