export interface SetupEmailPayload {
  site_id: string;
  email: string;
  subject: string;
  message: string;
  omit_signature: true;
}
export interface SetupEmailRequest {
  operation_key: string;
  payload: SetupEmailPayload;
}
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export class SetupEmailInputError extends Error {
  constructor(public readonly status: number) { super('Invalid setup email request'); }
}
export async function readSetupEmailRequest(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new SetupEmailInputError(415);
  const limit = 131_072;
  if (Number(request.headers.get('content-length')) > limit) throw new SetupEmailInputError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new SetupEmailInputError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      throw new SetupEmailInputError(413);
    }
    chunks.push(value);
  }
  return parseSetupEmailRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export function parseSetupEmailRequest(value: unknown): SetupEmailRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request');
  const body = value as Record<string, unknown>;
  const allowed = new Set(['operation_key', 'site_id', 'email', 'subject', 'message']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('Unsupported setup email field');
  if (typeof body.operation_key !== 'string' || !/^setup-email-v1:[a-f0-9]{64}$/.test(body.operation_key)
    || typeof body.site_id !== 'string' || !UUID.test(body.site_id)
    || typeof body.email !== 'string' || body.email.length > 320
    || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(body.email)
    || body.email === 'no-email@example.com'
    || typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 998 || /[\r\n]/.test(body.subject)
    || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 100_000) {
    throw new Error('Invalid setup email input');
  }
  // Exact strings (including whitespace) form the immutable payload identity.
  return { operation_key: body.operation_key, payload: {
    site_id: body.site_id.toLowerCase(), email: body.email, subject: body.subject,
    message: body.message, omit_signature: true,
  } };
}