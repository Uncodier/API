import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';
import { VisitorIdentityError } from './contracts';
import { visitorIdentityRouteError } from './route-utils';

export const IssueIdentitySchema = z.object({
  session_id: z.string().uuid(),
  external_user_id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
}).strict();
export const CurrentUserIdentitySchema = z.object({ session_id: z.string().uuid() }).strict();
export const ExchangeIdentitySchema = z.object({
  site_id: z.string().uuid(), session_id: z.string().uuid(),
  identity_token: z.string().min(1).max(4096),
}).strict();

export async function readIdentityBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new VisitorIdentityError('invalid_request', 'JSON content type is required', 415);
  }
  const maxBytes = 8192;
  if (Number(request.headers.get('content-length')) > maxBytes) {
    throw new VisitorIdentityError('payload_too_large', 'Identity request is too large', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new VisitorIdentityError('invalid_request', 'JSON body is required', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new VisitorIdentityError('payload_too_large', 'Identity request is too large', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new VisitorIdentityError('invalid_request', 'Malformed JSON body', 400); }
}

export async function identityRateLimit(request: Request, action: string, identity?: string) {
  const limited = await enforceRequestRateLimit(request, {
    namespace: `visitor-identity-token:${action}`, identity,
    // First-party BFF instances share an egress IP; enforce the tight budget by
    // server-validated subject after authentication, not by that shared IP.
    limit: identity ? 30 : action === 'current-user' ? 1200 : 60,
    windowSeconds: 60, failClosed: true,
  });
  if (limited) limited.headers.set('Cache-Control', 'no-store');
  return limited;
}

export function identityResponse(data: unknown) {
  return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}

export function tokenRouteError(error: unknown) {
  const response = visitorIdentityRouteError(error instanceof z.ZodError
    ? new VisitorIdentityError('invalid_request', 'Identity request fields are invalid', 400) : error);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}