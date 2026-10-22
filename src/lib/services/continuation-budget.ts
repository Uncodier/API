/** Legacy maxRetries is a maximum number of generation attempts, not extra retries. */
export const CONTINUATION_LIMITS = Object.freeze({ maxAttempts: 3, maxTimeoutMs: 120_000 });

export function validContinuationBudget(timeout: unknown, maxRetries: unknown): boolean {
  return typeof timeout === 'number' && Number.isSafeInteger(timeout)
    && timeout >= 1 && timeout <= CONTINUATION_LIMITS.maxTimeoutMs
    && typeof maxRetries === 'number' && Number.isSafeInteger(maxRetries)
    && maxRetries >= 0 && maxRetries <= CONTINUATION_LIMITS.maxAttempts;
}