import { NextResponse } from 'next/server';
import { authorizeInferenceRequest, resolveHttpExecutionRouting, withHttpExecutionRouting } from './customer-routing-http';
import { verifiedVisitorSessionClaims, visitorSessionTokenFromRequest } from '@/lib/security/visitor-session-token';

async function boundedBody(request: Request): Promise<any> {
  const maxBytes = 1024 * 1024;
  if (Number(request.headers.get('content-length')) > maxBytes) throw Object.assign(new Error('Request too large'), { status: 413 });
  const reader = request.clone().body?.getReader();
  if (!reader) throw Object.assign(new Error('Request body required'), { status: 400 });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw Object.assign(new Error('Request too large'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

/** Admission only: the original handler still enforces its role, resource and body contract. */
export async function withAuthorizedCommandRequest<T extends Request>(request: T,
  handler: (request: T) => Promise<Response>, options: { visitorSession?: boolean } = {}): Promise<Response> {
  try {
    const body = await boundedBody(request);
    const visitor = options.visitorSession && typeof body?.site_id === 'string'
      ? await verifiedVisitorSessionClaims(visitorSessionTokenFromRequest(request), {
        siteId: body.site_id, sessionId: body.session_id,
      }) : null;
    // Only the support route accepts visitor sessions; its original handler validates
    // current session, identity grant and conversation ownership before generating.
    const routing = visitor ? await resolveHttpExecutionRouting(request, visitor.siteId)
      : (await authorizeInferenceRequest(request, body?.site_id ?? body?.siteId)).routing;
    if (!routing) return NextResponse.json({ success: false, error: {
      code: 'SITE_REQUIRED', message: 'Command execution requires an authorized site',
    } }, { status: 400 });
    return await withHttpExecutionRouting(request, routing, () => handler(request));
  } catch (error: any) {
    return NextResponse.json({ success: false, error: {
      code: 'COMMAND_ADMISSION_FAILED', message: 'Command authentication or site admission failed',
    } }, { status: error instanceof SyntaxError || error?.name === 'SyntaxError' ? 400 : error?.status ?? 503 });
  }
}