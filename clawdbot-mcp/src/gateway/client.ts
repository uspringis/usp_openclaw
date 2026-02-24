/**
 * Clawdbot Gateway HTTP client
 * Calls the Gateway's /tools/invoke endpoint
 */

interface ToolInvokeRequest {
  tool: string;
  action?: string;
  args?: Record<string, unknown>;
  sessionKey?: string;
}

interface ToolInvokeResponse {
  ok: boolean;
  result?: unknown;
  error?: { type: string; message: string };
}

export class GatewayClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async invoke(request: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    const url = `${this.baseUrl}/tools/invoke`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (response.status === 401) {
      throw new Error('Gateway authentication failed');
    }

    if (response.status === 404) {
      throw new Error(`Tool not available: ${request.tool}`);
    }

    const data = await response.json() as ToolInvokeResponse;
    return data;
  }

  async listSessions(): Promise<unknown> {
    const result = await this.invoke({
      tool: 'sessions_list',
      args: { messageLimit: 3 },
    });
    if (!result.ok) {
      throw new Error(result.error?.message || 'Failed to list sessions');
    }
    return result.result;
  }

  async sendToSession(sessionKey: string, message: string): Promise<unknown> {
    const result = await this.invoke({
      tool: 'sessions_send',
      args: { sessionKey, message },
    });
    if (!result.ok) {
      throw new Error(result.error?.message || 'Failed to send message');
    }
    return result.result;
  }

  async getSessionHistory(sessionKey: string, limit = 20): Promise<unknown> {
    const result = await this.invoke({
      tool: 'sessions_history',
      args: { sessionKey, limit, includeTools: false },
    });
    if (!result.ok) {
      throw new Error(result.error?.message || 'Failed to get history');
    }
    return result.result;
  }
}
