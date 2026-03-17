export function getApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return url.replace(/\/$/, '');
}

export async function fetchApiTool(endpoint: string, body: any, errorMessage: string) {
  const url = `${getApiBaseUrl()}${endpoint}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(url, {
      method: 'GET',
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
