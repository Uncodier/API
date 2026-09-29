import { sanitizeRuntimeLog } from './runtime-log-context';

function errorMessage(value: unknown): string | undefined {
  // Durable errors may cross the workflow VM boundary without Error's prototype.
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    return value.message;
  }
  return undefined;
}

/** Pure helpers: safe to use in the workflow VM as well as durable steps. */
export function boundedFailureDetail(value: unknown, limit = 1200): string {
  const message = errorMessage(value) ?? String(value ?? '');
  return sanitizeRuntimeLog(message.slice(0, 8000)).slice(0, limit);
}

export function cronOwnershipRejectionReason(error: unknown): string | undefined {
  // Workflow serializes FatalError's message, not custom properties/prototypes.
  // Never infer a rejection reason from a generic "exceeded max retries" wrapper.
  const message = errorMessage(error) ?? '';
  return /^Cron execution ownership rejected \(([a-z_]{1,80})\)/.exec(message)?.[1];
}