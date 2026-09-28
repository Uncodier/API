// @ts-nocheck -- Dynamic ESM Jest imports under the ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const apiKeyAuth = jest.fn(async () => NextResponse.json({ error: 'API key required' }, { status: 401 }));
const getFinishedWorkflowResult = jest.fn(async () => ({ success: true, status: 'running' }));
const customerSupportMessage = jest.fn(async () => ({ success: true, status: 'running', workflowId: 'wf-1' }));
const siteId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const visitorId = '33333333-3333-4333-8333-333333333333';
const from = jest.fn((table) => {
  const q: any = { select: () => q, eq: () => q, is: () => q, or: () => q,
    maybeSingle: async () => ({ error: null, data: table === 'visitor_sessions'
      ? { id: sessionId, site_id: siteId, visitor_id: visitorId, lead_id: null, is_active: true } : null }) };
  return q;
});

jest.unstable_mockModule('../apiKeyAuth', () => ({ apiKeyAuth }));
jest.unstable_mockModule('../../../cors.config.js', () => ({
  getAllowedHeaders: () => 'Content-Type, Prefer, X-Visitor-Session-Token', getAllowedOrigins: () => ['https://app.example'],
}));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: async () => null,
  hasAuthenticatedPrincipal: (request: Request) => request.headers.get('x-auth-validated') === 'true' || Boolean(request.headers.get('x-api-key-data')),
  isInternalServiceRequest: () => false,
}));
jest.unstable_mockModule('@/lib/security/upstash-rest', () => ({ getCachedJson: async () => null, setCachedJson: async () => {}, sha256: async () => 'hash' }));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite: async () => false }));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/app/api/agents/customerSupport/conversations/core', () => ({
  getConversationsCore: async () => ({ success: true, data: {
    conversations: [], pagination: { total: 0, page: 1, limit: 10, pages: 0 },
  } }),
}));
jest.unstable_mockModule('@/app/api/agents/customerSupport/conversations/messages/core', () => ({
  getMessagesCore: async () => ({ success: true, data: { messages: [] } }),
}));
jest.unstable_mockModule('@/lib/services/workflow-service', () => ({ WorkflowService: {
  getInstance: () => ({ getFinishedWorkflowResult, customerSupportMessage }),
} }));

const { default: middleware, isPublicRequest } = await import('../requestMiddleware');
const { POST: status } = await import('@/app/api/workflow/customerSupport/status/route');
const { POST: send } = await import('@/app/api/workflow/customerSupport/route');
const { GET: conversations } = await import('@/app/api/agents/customerSupport/conversations/route');
const { GET: messages } = await import('@/app/api/agents/customerSupport/conversations/messages/route');
const { issueVisitorSessionToken } = await import('@/lib/security/visitor-session-token');
const oldSecret = process.env.VISITOR_SESSION_TOKEN_SECRET;
beforeAll(() => { process.env.VISITOR_SESSION_TOKEN_SECRET = 'test-only-session-signing-key'; });
afterAll(() => {
  if (oldSecret === undefined) delete process.env.VISITOR_SESSION_TOKEN_SECRET;
  else process.env.VISITOR_SESSION_TOKEN_SECRET = oldSecret;
});
beforeEach(() => jest.clearAllMocks());

async function throughMiddleware(path: string, token?: string, forgedPrincipal = false) {
  const request = new NextRequest(`https://api.example${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', origin: 'https://customer-website.example', prefer: 'respond-async',
    ...(token ? { 'X-Visitor-Session-Token': token } : {}),
    ...(forgedPrincipal ? { 'x-api-key-data': '{"isService":true}', 'x-auth-validated': 'true' } : {}),
  }, body: JSON.stringify({ site_id: siteId, session_id: sessionId, client_message_id: 'send-1', message: 'Hello' }) });
  const gateway = await middleware(request);
  if (gateway.headers.get('x-middleware-next') !== '1') return gateway;
  const headers = new Headers();
  for (const name of (gateway.headers.get('x-middleware-override-headers') || '').split(',')) {
    if (name) headers.set(name, gateway.headers.get(`x-middleware-request-${name}`)!);
  }
  return (path.endsWith('/status') ? status : send)(new NextRequest(request, { headers }));
}

it.each(['/api/workflow/customerSupport', '/api/workflow/customerSupport/status'])('allows a signed visitor through middleware and handler at %s', async (path) => {
  const token = await issueVisitorSessionToken({ siteId, sessionId, visitorId });
  const response = await throughMiddleware(path, token);
  expect(response.status).toBe(path.endsWith('/status') ? 200 : 202);
  expect(apiKeyAuth).not.toHaveBeenCalled();
});

it('rejects missing, invalid, expired and other-session tokens, including forged principal headers', async () => {
  const expired = await issueVisitorSessionToken({ siteId, sessionId, visitorId }, -10);
  const otherSession = await issueVisitorSessionToken({ siteId, sessionId: 'different-session', visitorId });
  for (const token of [undefined, 'invalid', expired, otherSession]) {
    expect((await throughMiddleware('/api/workflow/customerSupport/status', token, true)).status).toBe(403);
  }
  expect(getFinishedWorkflowResult).not.toHaveBeenCalled();
  expect(from).not.toHaveBeenCalled();
});

it('allows widget CORS preflight but keeps internal and sibling workflow routes private', async () => {
  const response = await middleware(new NextRequest('https://api.example/api/workflow/customerSupport/status', {
    method: 'OPTIONS', headers: { origin: 'https://customer-website.example', 'Access-Control-Request-Headers': 'X-Visitor-Session-Token, Prefer' },
  }));
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-headers')).toContain('X-Visitor-Session-Token');
  expect(response.headers.get('access-control-allow-headers')).toContain('Prefer');
  for (const path of ['/api/workflows/channel-message/advance', '/api/workflows/channel-message/prepare', '/api/workflows/channel-message/result', '/api/workflow/customerSupport/other']) {
    expect(isPublicRequest(path, 'POST')).toBe(false);
    expect((await throughMiddleware(path, 'signed-looking-token')).status).toBe(401);
  }
  expect(isPublicRequest('/api/workflow/customerSupport/status', 'DELETE')).toBe(false);
});

it.each([
  ['/api/agents/customerSupport/conversations', conversations],
  ['/api/agents/customerSupport/conversations/messages', messages],
])('allows signed visitor reads through middleware and checks them in the handler at %s', async (path, handler) => {
  const token = await issueVisitorSessionToken({ siteId, sessionId, visitorId });
  const url = `https://api.example${path}?site_id=${siteId}&session_id=${sessionId}&visitor_id=${visitorId}`;
  const visit = async (auth?: string) => {
    const request = new NextRequest(url, { method: 'GET', headers: {
      origin: 'https://customer-website.example',
      ...(auth ? { 'X-Visitor-Session-Token': auth } : {}),
    } });
    const gateway = await middleware(request);
    if (gateway.headers.get('x-middleware-next') !== '1') return gateway;
    const headers = new Headers();
    for (const name of (gateway.headers.get('x-middleware-override-headers') || '').split(',')) {
      if (name) headers.set(name, gateway.headers.get(`x-middleware-request-${name}`)!);
    }
    return handler(new NextRequest(request, { headers }));
  };
  expect((await visit(token)).status).toBe(200);
  expect((await visit()).status).toBe(403);
  expect(apiKeyAuth).not.toHaveBeenCalled();
  expect(isPublicRequest(path, 'POST')).toBe(false);
  expect(isPublicRequest(`${path}/other`, 'GET')).toBe(false);
  const preflight = await middleware(new NextRequest(url, { method: 'OPTIONS', headers: {
    origin: 'https://customer-website.example',
    'access-control-request-headers': 'X-Visitor-Session-Token',
  } }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Visitor-Session-Token');
});