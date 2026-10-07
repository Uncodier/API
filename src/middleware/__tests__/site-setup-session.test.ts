import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const mockApiKeyAuth = jest.fn(async () => NextResponse.json({ success: false }, { status: 401 }));
const mockRateLimit = jest.fn(async () => null);
jest.unstable_mockModule('../apiKeyAuth', () => ({ apiKeyAuth: mockApiKeyAuth }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: mockRateLimit }));
jest.unstable_mockModule('@/lib/security/upstash-rest', () => ({
  getCachedJson: async () => null, setCachedJson: async () => {}, sha256: async () => 'synthetic-hash',
}));
let middleware: typeof import('../requestMiddleware').default;
beforeAll(async () => { middleware = (await import('../requestMiddleware')).default; });
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { jest.restoreAllMocks(); });

function token(expired = false) {
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ sub: 'synthetic-user',
    exp: Math.floor(Date.now() / 1000) + (expired ? -100 : 3600) })}.${randomBytes(32).toString('base64url')}`;
}
function request(method: string, bearer?: string) {
  return new NextRequest('https://api.example.test/api/site/setup', {
    method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

it.each(['POST', 'GET'])('admits a verified proxied session without origin/API key for setup %s', async method => {
  const bearer = token();
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'synthetic-user' }));
  const response = await middleware(request(method, bearer));
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/v1/user'), expect.objectContaining({
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer}` },
  }));
  expect(mockApiKeyAuth).not.toHaveBeenCalled();
});

it('rejects an expired or invalid user session before the setup handler', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
  expect((await middleware(request('POST', token(true)))).status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await middleware(request('POST', token()))).status).toBe(401);
  expect(mockApiKeyAuth).not.toHaveBeenCalled();
});

it('does not treat cookie-only requests as API user authentication', async () => {
  const response = await middleware(new NextRequest('https://api.example.test/api/site/setup', {
    method: 'POST', headers: { cookie: 'synthetic-session' },
  }));
  expect(response.status).toBe(401);
  expect(mockApiKeyAuth).toHaveBeenCalledTimes(1);
});