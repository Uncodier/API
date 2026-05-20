export function getProbeBaseUrl(): string | null {
  const raw =
    process.env.STATUS_PROBE_BASE_URL?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    (process.env.NODE_ENV !== 'production' ? 'http://localhost:3001' : null);
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/\/$/, '');
  }
  return `https://${raw.replace(/\/$/, '')}`;
}

export async function probeHttpRoute(
  path: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const base = getProbeBaseUrl();
  if (!base) {
    return { ok: false, status: 0, latencyMs: 0, error: 'STATUS_PROBE_BASE_URL not set' };
  }
  const start = Date.now();
  try {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };
    const serviceKey = process.env.SERVICE_API_KEY?.trim();
    if (serviceKey && !headers['x-api-key'] && !headers['Authorization']) {
      headers['x-api-key'] = serviceKey;
    }
    const resp = await fetch(`${base}${path}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    const latencyMs = Date.now() - start;
    const ok = resp.status < 500;
    return { ok, status: resp.status, latencyMs };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
