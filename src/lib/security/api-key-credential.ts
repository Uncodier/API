/** Keep admission and authentication on exactly the same credential precedence. */
export function extractApiKeyCredential(request: Pick<Request, 'headers'>): string | null {
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) return apiKey;

  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  return authorization.startsWith('Bearer ')
    ? authorization.substring(7)
    : authorization;
}

/** Verify the credential itself, never caller-supplied internal identity headers. */
export async function isServiceApiKeyCredential(credential: string | null): Promise<boolean> {
  const serviceApiKey = process.env.SERVICE_API_KEY?.trim();
  if (!serviceApiKey || !credential) return false;

  // WebCrypto HMAC verification avoids a secret-dependent string/prefix/length
  // comparison and works in the middleware runtime without Node crypto imports.
  const encoder = new TextEncoder();
  const expected = encoder.encode(serviceApiKey);
  const key = await crypto.subtle.importKey(
    'raw', expected, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, expected);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(credential));
}