import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const counts = new Map<string, number>();
let available = true;
const mockCheckRateLimit = jest.fn(async (key: string, limit: number, windowSeconds: number) => {
  const count = (counts.get(key) || 0) + 1;
  counts.set(key, count);
  return {
    configured: true,
    available,
    success: !available || count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    reset: Date.now() + windowSeconds * 1_000,
  };
});
const mockApiKeyAuth = jest.fn(async () => NextResponse.json(
  { success: false, error: { code: 'UNAUTHORIZED', message: 'API key required' } },
  { status: 401 },
));

jest.unstable_mockModule('../apiKeyAuth', () => ({ apiKeyAuth: mockApiKeyAuth }));
jest.unstable_mockModule('@/lib/security/upstash-rest', () => ({
  checkRateLimit: mockCheckRateLimit,
  getCachedJson: async () => null,
  setCachedJson: async () => {},
  sha256: async (value: string) => `hash:${value}`,
}));

let middleware: typeof import('../requestMiddleware').default;
beforeAll(async () => {
  middleware = (await import('../requestMiddleware')).default;
});

const origin = 'https://app.makinari.com';
const lookupPath = '/api/finder/autocomplete/locations?q=que&page=0';
const searchPath = '/api/finder/person_role_search';
const envNames = [
  'NODE_ENV',
  'CORS_PREFLIGHT_REQUESTS_PER_MINUTE',
  'CORS_PREFLIGHT_GLOBAL_REQUESTS_PER_MINUTE',
];
const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));

function request(path: string, method = 'OPTIONS', headers: Record<string, string> = {}) {
  return new NextRequest(`https://backend.makinari.com${path}`, {
    method,
    headers: {
      origin,
      'x-vercel-forwarded-for': '192.0.2.1',
      ...(method === 'OPTIONS' ? {
        'access-control-request-method': path.includes('autocomplete') ? 'GET' : 'POST',
        'access-control-request-headers': 'authorization, content-type',
      } : {}),
      ...headers,
    },
  });
}

function userToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'test-user', exp: Math.floor(Date.now() / 1000) + 3600,
  })}.test-signature`;
}

beforeEach(() => {
  counts.clear();
  available = true;
  jest.clearAllMocks();
  Object.assign(process.env, { NODE_ENV: 'production' });
  delete process.env.CORS_PREFLIGHT_REQUESTS_PER_MINUTE;
  delete process.env.CORS_PREFLIGHT_GLOBAL_REQUESTS_PER_MINUTE;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => (
    new Response(JSON.stringify({ id: 'test-user' }), { status: 200 })
  ));
});

afterEach(() => {
  jest.restoreAllMocks();
  previousEnv.forEach((value, name) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
});

describe('CORS preflight request budgets', () => {
  it('does not charge autocomplete preflights to operation or authentication budgets', async () => {
    for (let index = 0; index < 25; index++) {
      const response = await middleware(request(`${lookupPath}&query_index=${index}`));
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
      expect(response.headers.get('access-control-max-age')).toBe('86400');
      expect(response.headers.get('x-middleware-next')).toBeNull();
    }

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(50);
    expect(Array.from(counts.keys())).toEqual([
      'rate_limit:cors-preflight:hash:192.0.2.1',
      'rate_limit:cors-preflight-global:hash:global',
    ]);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'rate_limit:cors-preflight:hash:192.0.2.1', 300, 60,
    );
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'rate_limit:cors-preflight-global:hash:global', 10_000, 60,
    );
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('preserves the real Finder operation limit even when preflights still succeed', async () => {
    const headers = { authorization: `Bearer ${userToken()}` };
    for (let index = 0; index < 20; index++) {
      expect((await middleware(request(lookupPath))).status).toBe(204);
      const response = await middleware(request(lookupPath, 'GET', headers));
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('x-middleware-request-x-auth-user-id')).toBe('test-user');
    }

    expect((await middleware(request(searchPath))).status).toBe(204);
    const limited = await middleware(request(searchPath, 'POST', headers));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(limited.headers.get('x-ratelimit-limit')).toBe('20');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.headers.get('access-control-allow-origin')).toBe(origin);
    expect(limited.headers.get('x-middleware-next')).toBeNull();
    expect(counts.get('rate_limit:expensive-global:hash:global')).toBe(20);
    expect(counts.get('rate_limit:authenticated-user:hash:test-user')).toBe(20);
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
  });

  it('rate limits preflight abuse per IP without consuming the operation budget', async () => {
    process.env.CORS_PREFLIGHT_REQUESTS_PER_MINUTE = '2';
    expect((await middleware(request(lookupPath))).status).toBe(204);
    expect((await middleware(request(searchPath))).status).toBe(204);
    const limited = await middleware(request(lookupPath));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('2');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.headers.get('access-control-allow-origin')).toBe(origin);

    const response = await middleware(request(searchPath, 'POST', {
      authorization: `Bearer ${userToken()}`,
    }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(counts.get('rate_limit:expensive:hash:192.0.2.1')).toBe(1);
  });

  it('also caps preflights globally across client IPs', async () => {
    process.env.CORS_PREFLIGHT_GLOBAL_REQUESTS_PER_MINUTE = '2';
    for (const ip of ['192.0.2.1', '192.0.2.2']) {
      expect((await middleware(request(lookupPath, 'OPTIONS', {
        'x-vercel-forwarded-for': ip,
      }))).status).toBe(204);
    }
    const response = await middleware(request(lookupPath, 'OPTIONS', {
      'x-vercel-forwarded-for': '192.0.2.3',
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('2');
  });

  it('fails closed for preflights when rate-limit storage is unavailable in production', async () => {
    available = false;
    const response = await middleware(request(lookupPath));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('x-middleware-next')).toBeNull();
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'invalid', '1.5'])(
    'uses bounded defaults for invalid preflight settings: %s', async (value) => {
      process.env.CORS_PREFLIGHT_REQUESTS_PER_MINUTE = value;
      process.env.CORS_PREFLIGHT_GLOBAL_REQUESTS_PER_MINUTE = value;
      expect((await middleware(request(lookupPath))).status).toBe(204);
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1, 'rate_limit:cors-preflight:hash:192.0.2.1', 300, 60,
      );
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        2, 'rate_limit:cors-preflight-global:hash:global', 10_000, 60,
      );
    },
  );

  it('rejects unapproved private origins before spending rate-limit storage calls', async () => {
    const response = await middleware(request(lookupPath, 'OPTIONS', {
      origin: 'https://untrusted.example',
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('retains the request body-size limit for OPTIONS', async () => {
    const response = await middleware(request(lookupPath, 'OPTIONS', {
      'content-length': String(31 * 1024 * 1024),
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockApiKeyAuth).not.toHaveBeenCalled();
  });

  it('retains dynamic public visitor preflights without granting Finder access', async () => {
    const publicResponse = await middleware(request('/api/visitors/session', 'OPTIONS', {
      origin: 'https://customer.example',
    }));
    expect(publicResponse.status).toBe(204);
    expect(publicResponse.headers.get('access-control-allow-origin')).toBe('https://customer.example');
    expect((await middleware(request(lookupPath, 'OPTIONS', {
      origin: 'https://customer.example',
    }))).status).toBe(403);
  });

  it.each([[lookupPath, 'GET'], [searchPath, 'POST']])(
    'does not let a successful preflight authenticate %s', async (path, method) => {
      expect((await middleware(request(path))).status).toBe(204);
      const response = await middleware(request(path, method));
      expect(response.status).toBe(401);
      expect(response.headers.get('x-middleware-next')).toBeNull();
      expect(mockApiKeyAuth).toHaveBeenCalledTimes(1);
    },
  );
});