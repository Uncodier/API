const ACCEPTED_MESSAGE_STATES = new Set(['queued', 'sending', 'sent', 'delivered', 'read']);

/** An idempotent replay can include an ID for a failed message; ID alone is not acceptance. */
export function isAcceptedZavuMessage(response: unknown): response is { message: { id: string; status: string } } {
  if (!response || typeof response !== 'object') return false;
  const result = response as { success?: unknown; message?: { id?: unknown; status?: unknown } };
  return result.success !== false && typeof result.message?.id === 'string' && !!result.message.id.trim()
    && typeof result.message.status === 'string' && ACCEPTED_MESSAGE_STATES.has(result.message.status);
}