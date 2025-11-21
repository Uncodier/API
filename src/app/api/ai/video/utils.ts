export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function convertUrlToBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
    return Buffer.from(downloadResult);
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



