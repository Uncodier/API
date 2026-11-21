import { createHash } from 'node:crypto';

/** The receipt is for this exact saved caption/file, not a later edit of the row. */
export function pinnedReplyPayloadHash(content: string, data: {
  response_format?: unknown; message_type?: unknown; media_url?: unknown; mime_type?: unknown;
}): string {
  return createHash('sha256').update(JSON.stringify([content, data.response_format ?? 'text',
    data.message_type ?? null, data.media_url ?? null, data.mime_type ?? null])).digest('hex');
}

export function isChannelReplyAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);
}
