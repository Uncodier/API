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
  /** Exact route contract; successful HTTP alone defaults to 200 only. */
  expectedStatuses?: readonly number[];
  /** Receives only a bounded body, never an unrestricted upstream Response. */
  validateResponse?: (body: string, headers: Headers) => boolean | Promise<boolean>;
  /** Validation bodies are capped at 256 KiB, with a default of 64 KiB. */
  maxResponseBytes?: number;
};

async function readBoundedBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Body limit exceeded');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      if (signal.aborted) throw new Error('Probe aborted');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('Probe aborted');
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Body limit exceeded');
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function probeHttpRoute(
  path: string,
  options: ProbeHttpOptions = {},
): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const base = getProbeBaseUrl();
  if (!base) {
    return { ok: false, status: 0, latencyMs: 0, error: 'STATUS_PROBE_BASE_URL not set' };
  }
  const start = Date.now();
  const {
    useServiceKey = true,
    expectedStatuses = [200],
    validateResponse,
    maxResponseBytes = 64 * 1024,
    ...fetchOptions
  } = options;
  let status = 0;
  let error = 'HTTP probe request failed';
  const timeout = AbortSignal.timeout(12_000);
  const signal = fetchOptions.signal
    ? AbortSignal.any([timeout, fetchOptions.signal])
    : timeout;
  let onAbort: (() => void) | undefined;
  try {
    const headers = new Headers(fetchOptions.headers);

    // Add Vercel Protection Bypass for preview deployments
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      headers.set('x-vercel-protection-bypass', process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
    }

    const serviceKey = process.env.SERVICE_API_KEY?.trim();
    const hasAuthHeader = headers.has('authorization');
    if (
      useServiceKey &&
      serviceKey &&
      !headers.has('x-api-key') &&
      !hasAuthHeader
    ) {
      headers.set('x-api-key', serviceKey);
    }
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Probe aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const ok = await Promise.race([aborted, (async () => {
      if (signal.aborted) return false;
      const resp = await fetch(`${base}${path}`, {
        ...fetchOptions,
        headers,
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
      status = resp.status;
      // Opaque, auth, missing, throttled and redirect responses are never evidence.
      if (resp.redirected || status < 200 || status >= 500 ||
          (status >= 300 && status < 400) || [401, 403, 404, 429].includes(status) ||
          !expectedStatuses.includes(status)) {
        error = 'Unexpected HTTP status';
        void resp.body?.cancel().catch(() => {});
        return false;
      }
      if (!validateResponse) {
        void resp.body?.cancel().catch(() => {});
        return true;
      }
      error = 'HTTP response validation failed';
      const limit = Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0
        ? Math.min(maxResponseBytes, 256 * 1024)
        : 64 * 1024;
      const body = await readBoundedBody(resp, limit, signal);
      return (await validateResponse(body, resp.headers)) === true;
    })()]);
    return { ok, status, latencyMs: Date.now() - start, ...(!ok ? { error } : {}) };
  } catch {
    return {
      ok: false,
      status,
      latencyMs: Date.now() - start,
      error,
    };
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
