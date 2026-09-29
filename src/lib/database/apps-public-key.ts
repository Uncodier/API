/** Configuration guard, not JWT authentication: reject privileged keys before bundling. */
export function assertAppsPublicKey(key: string): void {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return;
  try {
    const parts = key.split('.');
    if (parts.length === 3 && parts.every(Boolean)) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload?.role === 'anon') return;
    }
  } catch { /* Do not include token or decoded payload in diagnostics. */ }
  throw new Error('Apps public configuration requires a publishable key or legacy anon key. Privileged, missing or malformed credentials cannot be injected into generated apps.');
}