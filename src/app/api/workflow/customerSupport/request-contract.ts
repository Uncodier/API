import { createHash } from 'node:crypto';

export const SUPPORT_MESSAGE_MAX_LENGTH = 4000;
export const SUPPORT_CLIENT_ID_MAX_LENGTH = 128;
const MAX_REQUEST_BYTES = 32 * 1024;

/** Bound bytes while reading, including requests without Content-Length. */
export async function readSupportRequest(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function supportRequestError(body: Record<string, unknown>, requireClientId = false): string | null {
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return `message must contain 1 to ${SUPPORT_MESSAGE_MAX_LENGTH} characters`;
  }
  if ((requireClientId || body.client_message_id !== undefined) && (
    typeof body.client_message_id !== 'string' || !body.client_message_id.trim()
    || body.client_message_id.length > SUPPORT_CLIENT_ID_MAX_LENGTH
  )) return 'Invalid client_message_id';
  if (typeof body.site_id !== 'string' || !body.site_id.trim() || body.site_id.length > 128) return 'Invalid site_id';
  for (const key of ['session_id', 'conversationId']) {
    if (body[key] !== undefined && body[key] !== null && (
      typeof body[key] !== 'string' || !(body[key] as string).trim() || (body[key] as string).length > 128
    )) return `Invalid ${key}`;
  }
  return null;
}

export function supportMessageId(siteId: string, sessionId: string, clientId: string, message: string): string {
  return createHash('sha256').update(JSON.stringify([siteId, sessionId, clientId.trim(), message])).digest('hex');
}