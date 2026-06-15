export function getApiBaseUrl(): string {
  // Try to use the API URL, fallback to API SERVER URL, then APP URL, and finally localhost:3001
  const url = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_SERVER_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
  return url.replace(/\/$/, '');
}

export async function fetchApiTool(endpoint: string, body: any, errorMessage: string) {
  const url = `${getApiBaseUrl()}${endpoint}`;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.SERVICE_API_KEY) {
      headers['x-api-key'] = process.env.SERVICE_API_KEY;
    }
    
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      if (!res.ok) {
        throw new Error(`Error ${res.status}: ${res.statusText}. Could not parse JSON response.`);
      }
      throw new Error(`Invalid JSON response from ${endpoint} (Status: ${res.status}): ${text.slice(0, 150)}...`);
    }

    if (!res.ok) {
      throw new Error(data.error?.message || data.error || errorMessage);
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`${errorMessage}: ${String(error)}`);
  }
}

export async function fetchApiToolGet(endpoint: string, errorMessage: string) {
  const url = `${getApiBaseUrl()}${endpoint}`;
  try {
    const headers: Record<string, string> = {};
    if (process.env.SERVICE_API_KEY) {
      headers['x-api-key'] = process.env.SERVICE_API_KEY;
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      if (!res.ok) {
        throw new Error(`Error ${res.status}: ${res.statusText}. Could not parse JSON response.`);
      }
      throw new Error(`Invalid JSON response from ${endpoint} (Status: ${res.status}): ${text.slice(0, 150)}...`);
    }

    if (!res.ok) {
      throw new Error(data.error?.message || data.error || errorMessage);
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`${errorMessage}: ${String(error)}`);
  }
}
