/**
 * Utility to handle remote tool invocation when running in MCP "Remote Mode"
 * (i.e. without local database access, connecting to a remote API)
 */

export class RemoteToolError extends Error {
  status: number;
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
  const baseUrl = apiUrl.replace(/\/$/, '');
  const endpoint = path.startsWith('/') ? path : `/${path}`;
  const url = `${baseUrl}${endpoint}`;
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  
  console.log(`[RemoteTool] Invoking ${url} (Remote Mode)`);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      let errorData: any;
      let errorMessage: string;
      
      try {
        errorData = await response.json();
        // Try to extract a meaningful message from common error formats
        errorMessage = errorData.error || errorData.message || `Remote error ${response.status}`;
      } catch (e) {
        // Fallback for non-JSON errors
        const text = await response.text();
        errorMessage = text || `Remote error ${response.status}`;
        errorData = { error: errorMessage };
      }

      console.error(`[RemoteTool] Error ${response.status}: ${errorMessage}`);
      throw new RemoteToolError(errorMessage, response.status, errorData);
    }
    
    return await response.json();
  } catch (error) {
    if (error instanceof RemoteToolError) {
      throw error;
    }
    console.error(`[RemoteTool] Fetch error:`, error);
    throw error;
  }
}
