/** Public text must never contain provider errors, credentials or internal paths. */
export const ASSISTANT_FAILURE_MESSAGE =
  'The assistant could not complete this request. Automatic continuation was unavailable or unsafe. Check the current task status before retrying.';

import { getProviderRetryDecision } from '@/lib/services/ai/provider-retry-policy';
export { getProviderRetryDecision } from '@/lib/services/ai/provider-retry-policy';
export const isTransientAssistantFailure = (error: unknown): boolean => Boolean(getProviderRetryDecision(error));