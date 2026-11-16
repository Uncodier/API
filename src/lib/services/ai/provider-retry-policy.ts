export const MAX_PROVIDER_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
export type ProviderRetryDecision = { retryAt: number };
const acceptedFailures = new WeakSet<object>();
/** Preserve host control/error identity without attaching provider data or causes. */
export function markAcceptedInferenceFailure(error: unknown): void {
  if (error && typeof error === 'object') acceptedFailures.add(error);
}

/** Admission-only recovery. Never infer replay safety from timeout/reset text. */
export function getProviderRetryDecision(error: unknown, now = Date.now()): ProviderRetryDecision | undefined {
  const chain: Record<string, any>[] = [];
  const seen = new Set<unknown>();
  for (let depth = 0; error && typeof error === 'object'; depth++) {
    if (depth >= 5 || seen.has(error)) return;
    seen.add(error);
    const failure = error as Record<string, any>;
    chain.push(failure);
    error = failure.cause;
  }
  // Check the entire chain before accepting an outer transient status.
  if (chain.some(f => acceptedFailures.has(f) || f.inferenceAccepted || f.generationId || f.generation_id || f.usage ||
    f.error?.generation_id || f.error?.metadata?.generation_id || f.error?.usage ||
    ['OpenRouterBillingError', 'CustomerReceiptError', 'AbortError', 'RecoveryError'].includes(f.name))) return;
  const transient = chain.some(f => [429, 500, 502, 503, 504].includes(f.status ?? f.statusCode) ||
    ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(f.code) ||
    (f.name === 'CustomerRoutingError' && f.code === 'CUSTOMER_PROVIDER_TRANSIENT_REJECTED'));
  if (!transient) return;
  let retryAt = now + 1000;
  for (const failure of chain) {
    if (failure.retryNotBefore !== undefined) {
      if (!Number.isFinite(failure.retryNotBefore)) return;
      retryAt = Math.max(retryAt, failure.retryNotBefore);
    }
    const headers = failure.headers;
    const header = typeof headers?.get === 'function' ? headers.get('retry-after')
      : headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (header == null) continue;
    if (typeof header !== 'string' || !header.trim()) return;
    const value = header.trim();
    const deadline = /^\d+(?:\.\d+)?$/.test(value)
      ? now + Math.ceil(Number(value) * 1000) : Date.parse(value);
    if (!Number.isFinite(deadline)) return;
    retryAt = Math.max(retryAt, deadline);
  }
  // Fail closed rather than shorten a provider's requested wait.
  if (!Number.isFinite(retryAt) || retryAt - now > MAX_PROVIDER_RETRY_DELAY_MS) return;
  return { retryAt };
}