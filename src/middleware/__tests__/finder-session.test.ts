import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const mockApiKeyAuth = jest.fn(async () => NextResponse.json(
  { success: false, error: { code: 'UNAUTHORIZED', message: 'API key required' } },
  { status: 401 },
));
const mockRateLimit = jest.fn(async () => null);

jest.unstable_mockModule('../apiKeyAuth', () => ({ apiKeyAuth: mockApiKeyAuth }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: mockRateLimit,
}));
jest.unstable_mockModule('@/lib/security/upstash-rest', () => ({
  getCachedJson: async () => null,
  setCachedJson: async () => {},
  sha256: async () => 'test-token-hash',
}));

let middleware: typeof import('../requestMiddleware').default;
beforeAll(async () => {
  middleware = (await import('../requestMiddleware')).default;
});

const paths = [
  '/api/finder/person_role_search',
  '/api/finder/person_role_search/totals',
  '/api/finder/person_role_search/createQuery',
];
const origin = 'https://app.makinari.com';
const previousNodeEnv = process.env.NODE_ENV;

function userToken(expiresIn = 3600): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'test-user', exp: Math.floor(Date.now() / 1000) + expiresIn,
  })}.test-signature`;
}

function request(path: string, token?: string): NextRequest {
  return new NextRequest(`https://backend.makinari.com${path}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ site_id: 'test-site', organization_industries: [42] }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, { NODE_ENV: 'production' });
});

afterEach(() => {
  jest.restoreAllMocks();
  if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
  else Object.assign(process.env, { NODE_ENV: previousNodeEnv });
});

describe('Find People browser session authentication', () => {
  it.each(paths)('accepts a verified user session without an API key for %s', async path => {
    const token = userToken();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'test-user' }), { status: 200 }),
    );
    const response = await middleware(request(path, token));

    expect(fetchMock).toHaveBeenCalledWith(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`,
      expect.objectContaining({
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-middleware-request-x-auth-validated')).toBe('true');
    expect(response.headers.get('x-middleware-request-x-auth-user-id')).toBe('test-user');
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
  });

  it.each(paths)('rejects an anonymous request despite its trusted origin for %s', async path => {
    const response = await middleware(request(path));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(mockApiKeyAuth).toHaveBeenCalledTimes(1);
  });

  it('rejects a token that Supabase cannot verify', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    const response = await middleware(request(paths[0], userToken()));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: 'Invalid or expired user token' } });
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
  });

  it('rejects expired tokens without contacting Supabase', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const response = await middleware(request(paths[0], userToken(-60)));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
  });

  it('allows Authorization in the browser preflight for Finder', async () => {
    const response = await middleware(new NextRequest(`https://backend.makinari.com${paths[0]}`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
  });
});