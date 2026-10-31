/**
 * Utility to handle remote tool invocation when running in MCP "Remote Mode"
 * (i.e. without local database access, connecting to a remote API)
 */

export class RemoteToolError extends Error {
  status: number;
  // Upstream response data is deliberately preserved for HTTP route consumers.
  // It is not safe diagnostic text and must not be logged.
  data: any;

  constructor(message: string, status: number, data: any) {
    super(message);
    this.name = 'RemoteToolError';
    this.status = status;
    this.data = data;
  }
}

export function shouldUseRemoteApi(): boolean {
  // If we have full DB credentials, prefer local DB (local execution or server-side).
  // If we are missing DB credentials but have API URL, use remote (MCP remote mode).
  const hasDbKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hasApiUrl = !!process.env.API_URL;
  
  // Logic: If no DB Key is present, but we have an API URL, we MUST use the remote API.
  // This supports the "Remote MCP" use case where users only provide API_URL + REST_API_KEY.
  return !hasDbKey && hasApiUrl;
}

export async function invokeRemoteTool(path: string, payload: any) {
  const apiUrl = process.env.API_URL;
  const apiKey = process.env.REST_API_KEY;
  
  if (!apiUrl) {
    throw new Error('API_URL is required for remote tool invocation (Remote Mode)');
  }
  
  // Normalize URL
  const baseUrl = apiUrl.replace(/\/+$/, '');
  const endpoint = `/${path.replace(/^\/+/, '')}`;
  const url = `${baseUrl}${endpoint}`;
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  
  const siteId = process.env.MCP_SITE_ID;
  if (siteId) {
    headers['x-mcp-site-id'] = siteId;
  }
  
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  // MCP stdio reserves stdout for protocol messages. Never log URLs, headers,
  // payloads, or upstream diagnostics (any of them may contain credentials).
  console.error('[RemoteTool] Invoking remote tool');
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      let errorData: any;
      const errorMessage = `Remote error ${response.status}`;
      // Read once: json() consumes the body even when parsing fails.
      const text = await response.text();
      try {
        errorData = JSON.parse(text);
      } catch {
        // Fallback for non-JSON errors
        errorData = { error: text || errorMessage };
      }

      console.error(`[RemoteTool] Error ${response.status}: ${errorMessage}`);
      throw new RemoteToolError(errorMessage, response.status, errorData);
    }
    
    return await response.json();
  } catch (error) {
    if (error instanceof RemoteToolError) {
      throw error;
    }
    console.error('[RemoteTool] Remote invocation failed');
    // Do not attach the original error as a cause: fetch/JSON/serialization
    // errors can embed authenticated URLs or request/response content.
    throw new Error('Remote tool invocation failed');
  }
}
