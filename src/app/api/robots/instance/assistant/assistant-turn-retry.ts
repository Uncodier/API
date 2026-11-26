import { APIError } from 'openai/error';
import { CustomerRoutingError } from '@/lib/services/ai/customer-routing';
import { getProviderRetryDecision } from '@/lib/services/ai/provider-retry-policy';

/** Only raised by the initial read-only binding lookup, never its tool-time recheck. */
export class TransientBindingPreflightError extends Error {
  constructor() { super('Requirement file environment is unavailable'); }
}

export function settledTurnRetry(error: unknown, generation: number) {
  if (error instanceof TransientBindingPreflightError) return generation === 0 ? { retryAt: Date.now() + 1000 } : undefined;
  // A 503 from arbitrary application code is not evidence of provider rejection.
  if (!(error instanceof APIError || (error instanceof CustomerRoutingError &&
      error.code === 'CUSTOMER_PROVIDER_TRANSIENT_REJECTED'))) return;
  return getProviderRetryDecision(error);
}
