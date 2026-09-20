import { NextRequest } from 'next/server';
import { authorizeVisitorSession } from '@/lib/security/authorize-visitor-session';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';

export function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Requested-With, X-Visitor-Session-Token',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export function json(
  body: unknown,
  status: number,
  request: NextRequest,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

export function jsonWithTrace(
  body: unknown,
  status: number,
  request: NextRequest,
  traceId: string,
): Response {
  const payload = typeof body === 'object' && body !== null
    ? { ...body, trace_id: traceId }
    : body;
  return json(payload, status, request);
}

export function isValidUuid(value?: string | null): value is string {
  return Boolean(
    value
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

export async function authorizeUploadBeforeParsing(request: NextRequest) {
  const authenticated = hasAuthenticatedPrincipal(request);
  const siteId = request.nextUrl.searchParams.get('site_id');
  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (authenticated) return { authenticated, siteId, sessionId, error: null };
  if (!isValidUuid(siteId) || !isValidUuid(sessionId)) {
    return {
      authenticated,
      siteId,
      sessionId,
      error: 'site_id and session_id query parameters are required',
    };
  }
  const authorized = await authorizeVisitorSession(request, {
    siteId,
    sessionId,
  });
  return {
    authenticated,
    siteId,
    sessionId,
    error: authorized ? null : 'Visitor session authorization is required',
  };
}
