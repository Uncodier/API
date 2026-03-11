export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function convertUrlToBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const headers: Record<string, string> = {};
    
    // Add authentication for Twilio Media URLs
    if (url.includes('api.twilio.com')) {
      const accountSid = process.env.GEAR_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.GEAR_TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
      
      if (accountSid && authToken) {
        const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
        console.log(`[Video API] Added Basic Auth for Twilio URL`);
      } else {
        console.warn(`[Video API] Twilio URL detected but no auth credentials found in environment`);
      }
    }

    const response = await fetch(url, { 
      headers,
      signal: AbortSignal.timeout(10_000) 
    });
    if (!response.ok) {
      console.warn(`[Video API] Failed to fetch reference image: ${response.status} ${response.statusText}`);
      return null;
    }
    const buffer = await response.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/png';
    return { data: base64Data, mimeType };
  } catch (error: any) {
    console.warn(`[Video API] Error converting URL to base64: ${error.message}`);
    return null;
  }
}

export async function bufferFromDownload(downloadResult: any): Promise<Buffer> {
  if (!downloadResult) {
    throw new Error('Gemini video download returned an empty response.');
  }
  if (downloadResult instanceof ArrayBuffer || downloadResult instanceof Uint8Array) {
    return Buffer.from(downloadResult as any);
  }
  if (typeof downloadResult.arrayBuffer === 'function') {
    const arr = await downloadResult.arrayBuffer();
    return Buffer.from(arr);
  }
  if (downloadResult?.data) {
    if (downloadResult.data instanceof ArrayBuffer || downloadResult.data instanceof Uint8Array) {
      return Buffer.from(downloadResult.data);
    }
    if (typeof downloadResult.data.arrayBuffer === 'function') {
      const arr = await downloadResult.data.arrayBuffer();
      return Buffer.from(arr);
    }
  }
  if (downloadResult?.body && typeof downloadResult.body.arrayBuffer === 'function') {
    const arr = await downloadResult.body.arrayBuffer();
    return Buffer.from(arr);
  }
  throw new Error('Unsupported Gemini download response format.');
}



