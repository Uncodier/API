function getBaseUrl(): string {
  const baseUrl = process.env.NEXT_API_URL?.trim();
  if (!baseUrl) {
    throw new Error('NEXT_API_URL is not defined');
  }
  return baseUrl.replace(/\/$/, '');
}

export interface MakinariWebhook {
  id: string;
  url: string;
  events: string[];
  created_at?: string;
  updated_at?: string;
  status?: string;
}

export class MakinariClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${getBaseUrl()}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });
    
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(`Makinari API Error: ${response.status} ${response.statusText} - ${JSON.stringify(errorBody)}`);
    }

    const data = await response.json();
    return data as T;
  }

  async getWebhooks(): Promise<MakinariWebhook[]> {
    return this.request<MakinariWebhook[]>('/webhooks', {
      method: 'GET',
    });
  }

  async createWebhook(url: string, events: string[]): Promise<MakinariWebhook> {
    return this.request<MakinariWebhook>('/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url, events }),
    });
  }

  async deleteWebhook(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/webhooks/${id}`, {
      method: 'DELETE',
    });
  }

  /**
   * Fetch available tools from the remote MCP server.
   */
  async getTools(): Promise<any[]> {
    const response = await this.request<any>('/api/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1,
      }),
    });

    if (response.error) {
      throw new Error(`Failed to list tools: ${response.error.message}`);
    }

    return response.result?.tools || [];
  }

  /**
   * Call a tool on the remote MCP server.
   */
  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    const response = await this.request<any>('/api/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
        id: 1,
      }),
    });

    if (response.error) {
      throw new Error(`Tool call failed: ${response.error.message}`);
    }

    return response.result;
  }
}

export const getMakinariClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY is not defined');
  }
  return new MakinariClient(apiKey);
};
