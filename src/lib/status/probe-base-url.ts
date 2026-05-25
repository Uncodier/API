export function getProbeBaseUrl(): string | null {
  const raw =
    process.env.STATUS_PROBE_BASE_URL?.trim() ||
    (process.env.VERCEL_ENV === 'production' ? process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() : null) ||
    process.env.VERCEL_URL?.trim() ||
    (process.env.NODE_ENV !== 'production' ? 'http://localhost:3001' : null);
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/\/$/, '');
  }
  return `https://${raw.replace(/\/$/, '')}`;
}

export type ProbeHttpOptions = RequestInit & {
  /** When false, do not attach SERVICE_API_KEY (e.g. public /api/status). Default true. */
  useServiceKey?: boolean;
};

export async function probeHttpRoute(
  path: string,
  options: ProbeHttpOptions = {},
): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const base = getProbeBaseUrl();
  if (!base) {
    return { ok: false, status: 0, latencyMs: 0, error: 'STATUS_PROBE_BASE_URL not set' };
  }
  const start = Date.now();
  const { useServiceKey = true, ...fetchOptions } = options;
  try {
    const headers: Record<string, string> = {
      ...(fetchOptions.headers as Record<string, string>),
    };
    
    // Add Vercel Protection Bypass for preview deployments
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    }

    const serviceKey = process.env.SERVICE_API_KEY?.trim();
    const hasAuthHeader = !!(headers['Authorization'] || headers['authorization']);
    if (
      useServiceKey &&
      serviceKey &&
      !headers['x-api-key'] &&
      !hasAuthHeader
    ) {
      headers['x-api-key'] = serviceKey;
    }
    const resp = await fetch(`${base}${path}`, {
      ...fetchOptions,
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
