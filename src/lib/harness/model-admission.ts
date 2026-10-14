/** Retry only unambiguously rejected admissions, never timeouts with an unknown generation. */
export async function retryModelAdmission<T>(create: () => Promise<T>, signal: AbortSignal,
  runtime: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number } = {}): Promise<T> {
  const now = runtime.now || Date.now;
  const until = now() + 20000;
  const sleep = runtime.sleep || ((ms, abort) => new Promise<void>((resolve, reject) => {
    abort.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(new Error('Model admission cancelled')); };
    const timer = setTimeout(() => { abort.removeEventListener('abort', onAbort); resolve(); }, ms);
    abort.addEventListener('abort', onAbort, { once: true });
  }));
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await create(); }
    catch (error) {
      const e = error as { status?: number; headers?: Headers | Record<string, string>; usage?: unknown;
        generationId?: unknown; error?: { usage?: unknown; generation_id?: unknown; metadata?: { generation_id?: unknown } } };
      if (attempt >= 2 || ![429, 503].includes(e?.status || 0) || e.usage || e.generationId ||
        e.error?.usage || e.error?.generation_id || e.error?.metadata?.generation_id) throw error;
      const headers = e.headers;
      const retryAfter = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'] ?? headers?.['Retry-After'];
      let delay = 500 * 2 ** attempt;
      if (retryAfter) {
        const requested = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Math.ceil(Number(retryAfter) * 1000) : Date.parse(retryAfter) - now();
        if (!Number.isFinite(requested)) throw error;
        delay = Math.max(delay, requested);
      }
      if (now() + delay > until) throw error;
      await sleep(delay, signal);
    }
  }
}