import { isZavuAcceptedStatus, type ZavuAcceptedStatus } from './zavu-receipt-state';

/** An idempotent replay can include an ID for a failed message; ID alone is not acceptance. */
export function isAcceptedZavuMessage(response: unknown): response is { message: { id: string; status: ZavuAcceptedStatus } } {
  if (!response || typeof response !== 'object') return false;
  const result = response as { success?: unknown; message?: { id?: unknown; status?: unknown } };
  return result.success !== false && typeof result.message?.id === 'string' && !!result.message.id.trim()
    && result.message.id.trim() !== 'unknown' && isZavuAcceptedStatus(result.message.status);
}
