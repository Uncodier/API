import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const serviceCredential = 'test-only-internal-service-credential';
const databaseCredential = 'test-only-database-credential';
const databaseKey = { id: 'database-key', name: 'Scoped key', scopes: ['read'] };
const validateApiKey = jest.fn(async (key: string) => (
  key === databaseCredential
    ? { isValid: true, keyData: databaseKey }
    : { isValid: false, keyData: null }
));
const recordTelemetry = jest.fn(async () => {});

// Keep requestMiddleware, apiKeyAuth, credential verification, admission and
// Upstash REST code real. Only external DB/telemetry/network are simulated.
jest.unstable_mockModule('@/lib/services/api-keys/ApiKeyService', () => ({
  ApiKeyService: { validateApiKey },
}));
jest.unstable_mockModule('@/lib/status/telemetry', () => ({ recordTelemetry }));

let middleware: typeof import('../requestMiddleware').default;
let sha256: typeof import('@/lib/security/upstash-rest').sha256;
beforeAll(async () => {
  middleware = (await import('../requestMiddleware')).default;
  sha256 = (await import('@/lib/security/upstash-rest')).sha256;
});

const origin = 'https://app.makinari.com';
const ip = '192.0.2.1';
const finderPath = '/api/finder/person_role_search';
const counts = new Map<string, number>();
let unavailableNamespace: string | undefined;
const envNames = [
  'NODE_ENV', 'SERVICE_API_KEY', 'SERVICE_EXPENSIVE_REQUESTS_PER_MINUTE',
  'SERVICE_API_KEY_REQUESTS_PER_MINUTE', 'EXPENSIVE_API_GLOBAL_REQUESTS_PER_MINUTE',
  'API_KEY_VALIDATION_REQUESTS_PER_MINUTE', 'API_KEY_VALIDATION_GLOBAL_REQUESTS_PER_MINUTE',
  'API_KEY_PRINCIPAL_REQUESTS_PER_MINUTE', 'API_MAX_REQUEST_BYTES',
  'CACHE_UPSTASH_REDIS_REST_URL', 'CACHE_UPSTASH_REDIS_REST_TOKEN',
  'CORS_PREFLIGHT_REQUESTS_PER_MINUTE', 'CORS_PREFLIGHT_GLOBAL_REQUESTS_PER_MINUTE',
];
const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));

function request(headers: Record<string, string> = {}, path = finderPath, method = 'POST') {
  return new NextRequest(`https://backend.makinari.com${path}`, {
    method,
    headers: { origin, 'x-vercel-forwarded-for': ip, ...headers },
  });
}

function serviceRequest(headers: Record<string, string> = {}, path = finderPath, method = 'POST') {
  return request({ 'x-api-key': serviceCredential, ...headers }, path, method);
}

async function counterKey(namespace: string, identity: string) {
  return `rate_limit:${namespace}:${await sha256(identity)}`;
}

async function seed(namespace: string, identity: string, count: number) {
  counts.set(await counterKey(namespace, identity), count);
}

async function count(namespace: string, identity: string) {
  return counts.get(await counterKey(namespace, identity)) || 0;
}

function namespaces() {
  return Array.from(new Set(Array.from(counts.keys(), key => key.split(':')[1])));
}

async function expectNoClientSecret(response: NextResponse) {
  expect(await response.clone().text()).not.toContain(serviceCredential);
  response.headers.forEach((value, name) => {
    // NextResponse.next uses these private transport headers to forward the
    // request upstream, not to the client (NextResponse API contract).
    if (!name.startsWith('x-middleware-request-')) expect(value).not.toContain(serviceCredential);
  });
  expect(JSON.stringify(Array.from(counts.keys()))).not.toContain(serviceCredential);
  expect(JSON.stringify(recordTelemetry.mock.calls)).not.toContain(serviceCredential);
}

beforeEach(() => {
  jest.clearAllMocks();
  counts.clear();
  unavailableNamespace = undefined;
  envNames.forEach(name => { delete process.env[name]; });
  Object.assign(process.env, {
    NODE_ENV: 'production',
    SERVICE_API_KEY: serviceCredential,
    CACHE_UPSTASH_REDIS_REST_URL: 'https://admission.example.test',
    CACHE_UPSTASH_REDIS_REST_TOKEN: 'test-only-storage-token',
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input).toBe('https://admission.example.test');
    const [command, , numberOfKeys, key, seconds] = JSON.parse(String(init?.body));
    expect(command).toBe('EVAL');
    expect(numberOfKeys).toBe(1);
    expect(key).not.toContain(serviceCredential);
    if (key.split(':')[1] === unavailableNamespace) {
      return new Response(null, { status: 503 });
    }
    const nextCount = (counts.get(key) || 0) + 1;
    counts.set(key, nextCount);
    return new Response(JSON.stringify({ result: [nextCount, seconds] }), { status: 200 });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  previousEnv.forEach((value, name) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
});

describe('verified service expensive admission with real authentication', () => {
  it('allows 600 requests (>300 from one IP), rejects 601, and leaves ordinary budgets untouched', async () => {
    for (let index = 0; index < 600; index++) {
      const headers: Record<string, string> = index % 3 === 0
        ? { 'x-api-key': serviceCredential }
        : { authorization: index % 3 === 1 ? `Bearer ${serviceCredential}` : serviceCredential };
      const response = await middleware(request(headers));
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('x-middleware-request-x-api-key-data'))
        .toContain('"isService":true');
      await expectNoClientSecret(response);
    }
    const limited = await middleware(serviceRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('600');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('access-control-allow-origin')).toBe(origin);
    expect(limited.headers.get('access-control-expose-headers')).toContain('Retry-After');
    expect(await limited.clone().json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(limited.headers.get('x-middleware-next')).toBeNull();
    await expectNoClientSecret(limited);
    expect(namespaces()).toEqual(['service-api-key', 'service-expensive', 'expensive-global']);
    expect(await count('service-api-key', 'service-key')).toBe(601);
    expect(await count('service-expensive', 'service-key')).toBe(601);
    expect(await count('expensive-global', 'global')).toBe(600);
    expect(validateApiKey).not.toHaveBeenCalled();

    expect((await middleware(request())).status).toBe(401);
    expect(await count('expensive', ip)).toBe(1);
    expect(await count('api-key-validation', ip)).toBe(1);
  });

  it('does not compete with already exhausted expensive/IP or API-key-validation/IP budgets', async () => {
    await seed('expensive', ip, 20);
    await seed('api-key-validation', ip, 300);
    await seed('api-key-validation-global', 'global', 2000);
    expect((await middleware(serviceRequest())).headers.get('x-middleware-next')).toBe('1');
    expect(await count('expensive', ip)).toBe(20);
    expect(await count('api-key-validation', ip)).toBe(300);
    expect(await count('api-key-validation-global', 'global')).toBe(2000);
  });

  it('shares service admission across routes, methods, workers and IPs', async () => {
    process.env.SERVICE_EXPENSIVE_REQUESTS_PER_MINUTE = '2';
    expect((await middleware(serviceRequest({}, '/api/finder/autocomplete/locations', 'GET'))).status).toBe(200);
    expect((await middleware(serviceRequest({ 'x-vercel-forwarded-for': '192.0.2.2' }, '/api/agents/tools/instance_plan'))).status).toBe(200);
    const response = await middleware(serviceRequest({ 'x-vercel-forwarded-for': '192.0.2.3' }, '/api/robots/instance/assistant'));
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('2');
  });

  it('applies the verified internal budget to durable IcyPeas lookups', async () => {
    await seed('expensive', ip, 20);
    expect((await middleware(serviceRequest({}, '/api/integrations/icypeas/email-search/resolve'))).status).toBe(200);
    expect(await count('service-expensive', 'service-key')).toBe(1);
    expect(await count('expensive-global', 'global')).toBe(1);
    expect(await count('expensive', ip)).toBe(20);
  });

  it('retains the 5000/min service-api-key budget before the expensive budgets', async () => {
    await seed('service-api-key', 'service-key', 4999);
    expect((await middleware(serviceRequest())).status).toBe(200);
    const response = await middleware(serviceRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('5000');
    expect(await count('service-expensive', 'service-key')).toBe(1);
    expect(await count('expensive-global', 'global')).toBe(1);
    await expectNoClientSecret(response);
  });

  it.each(['ordinary', 'service'])('aggregates service and ordinary traffic at the same 2000/min global cap (%s last)', async last => {
    await seed('expensive-global', 'global', 1999);
    const ordinary = () => request({ 'x-api-key': databaseCredential });
    const first = last === 'service' ? ordinary() : serviceRequest();
    const second = last === 'service' ? serviceRequest() : ordinary();
    expect((await middleware(first)).status).toBe(200);
    const response = await middleware(second);
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('2000');
    expect(await count('expensive-global', 'global')).toBe(2001);
    await expectNoClientSecret(response);
  });

  it.each(['service-api-key', 'service-expensive', 'expensive-global'])('fails closed with 503 when %s storage fails', async namespace => {
    unavailableNamespace = namespace;
    const response = await middleware(serviceRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('x-middleware-next')).toBeNull();
    expect(await response.clone().json()).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
    expect(validateApiKey).not.toHaveBeenCalled();
    await expectNoClientSecret(response);
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(serviceCredential);
  });

  it('fails closed if admission storage is not configured', async () => {
    delete process.env.CACHE_UPSTASH_REDIS_REST_TOKEN;
    const response = await middleware(serviceRequest());
    expect(response.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await expectNoClientSecret(response);
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'falls back to 600/5000/2000 for invalid settings %j', async value => {
      process.env.SERVICE_EXPENSIVE_REQUESTS_PER_MINUTE = value;
      process.env.SERVICE_API_KEY_REQUESTS_PER_MINUTE = value;
      process.env.EXPENSIVE_API_GLOBAL_REQUESTS_PER_MINUTE = value;
      await seed('service-expensive', 'service-key', 600);
      let response = await middleware(serviceRequest());
      expect(response.status).toBe(429);
      expect(response.headers.get('x-ratelimit-limit')).toBe('600');
      counts.clear();
      await seed('service-api-key', 'service-key', 5000);
      response = await middleware(serviceRequest());
      expect(response.headers.get('x-ratelimit-limit')).toBe('5000');
      counts.clear();
      await seed('expensive-global', 'global', 2000);
      response = await middleware(serviceRequest());
      expect(response.headers.get('x-ratelimit-limit')).toBe('2000');
    },
  );
});

describe('no service privilege from unverified credentials or headers', () => {
  const spoofed = {
    'x-api-key-data': '{"id":"service-key","isService":true,"scopes":["*"]}',
    'x-auth-user-id': 'spoofed-user', 'x-auth-validated': 'true', 'x-required-scope': '*',
  };
  const invalidHeaders: Array<[string, Record<string, string>]> = [
    ['missing', {}],
    ['invalid', { 'x-api-key': 'invalid-key' }],
    ['spoofed metadata', spoofed],
    ['spoofed metadata with invalid key', { ...spoofed, 'x-api-key': 'invalid-key' }],
    ['x-api-key takes precedence', { 'x-api-key': 'invalid-key', authorization: `Bearer ${serviceCredential}` }],
    ['service prefix', { 'x-api-key': serviceCredential.slice(0, -1) }],
    ['service suffix', { 'x-api-key': `${serviceCredential}-extra` }],
  ];
  it.each(invalidHeaders)('retains 401 and expensive20/IP for %s', async (_label, headers) => {
    for (let index = 0; index < 20; index++) {
      const response = await middleware(request(headers));
      expect(response.status).toBe(401);
      expect(response.headers.get('x-middleware-next')).toBeNull();
      await expectNoClientSecret(response);
    }
    const limited = await middleware(request(headers));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('20');
    expect(namespaces()).not.toContain('service-api-key');
    expect(namespaces()).not.toContain('service-expensive');
    expect(await count('api-key-validation', ip)).toBe(20);
  });

  it('retains API-key-validation/IP for an unverified service claim', async () => {
    await seed('api-key-validation', ip, 300);
    const response = await middleware(request({ ...spoofed, 'x-api-key': 'invalid-key' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('300');
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(namespaces()).not.toContain('service-expensive');
  });

  it('authenticates a real service key again and replaces spoofed metadata', async () => {
    const response = await middleware(serviceRequest({ ...spoofed, authorization: 'Bearer invalid.key.value' }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(JSON.parse(response.headers.get('x-middleware-request-x-api-key-data')!))
      .toEqual({ id: 'service-key', name: 'Internal Service Key', scopes: ['*'], isService: true });
    for (const header of ['x-auth-user-id', 'x-auth-validated', 'x-required-scope']) {
      expect(response.headers.get(`x-middleware-request-${header}`)).toBeNull();
    }
    expect(recordTelemetry).toHaveBeenCalledWith('api_auth', 'up', 'Service API Key used', 5);
    expect(validateApiKey).not.toHaveBeenCalled();
    await expectNoClientSecret(response);
  });

  it('does not elevate a valid database key with spoofed service metadata', async () => {
    for (let index = 0; index < 20; index++) {
      const response = await middleware(request({ ...spoofed, 'x-api-key': databaseCredential }));
      expect(response.status).toBe(200);
      expect(JSON.parse(response.headers.get('x-middleware-request-x-api-key-data')!)).toEqual(databaseKey);
      expect(response.headers.get('x-middleware-request-x-auth-validated')).toBeNull();
      expect(response.headers.get('x-middleware-request-x-required-scope')).toBeNull();
    }
    expect((await middleware(request({ 'x-api-key': databaseCredential }))).status).toBe(429);
    expect(namespaces()).not.toContain('service-expensive');
    expect(await count('api-key-principal', databaseKey.id)).toBe(20);
  });

  it('still enforces scopes on database keys', async () => {
    const response = await middleware(request({ ...spoofed, 'x-api-key': databaseCredential }, '/api/ai/image'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } });
    expect(namespaces()).not.toContain('service-expensive');
  });

  it.each([undefined, '', '   '])('does not enable service admission with an unset/empty service key (%j)', async value => {
    if (value === undefined) delete process.env.SERVICE_API_KEY;
    else process.env.SERVICE_API_KEY = value;
    expect((await middleware(serviceRequest())).status).toBe(401);
    expect(namespaces()).not.toContain('service-expensive');
    expect(validateApiKey).toHaveBeenCalledWith(serviceCredential);
  });
});

describe('service admission preserves transport and route boundaries', () => {
  it('rejects a disallowed private origin before auth/admission even with a service key', async () => {
    const response = await middleware(serviceRequest({ origin: 'https://untrusted.example' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordTelemetry).not.toHaveBeenCalled();
    await expectNoClientSecret(response);
  });

  it('allows origin-less service requests without reading their body', async () => {
    const body = '{ "test": "preserve raw body" }\n';
    const incoming = new NextRequest(`https://backend.makinari.com${finderPath}`, {
      method: 'POST', headers: { 'x-api-key': serviceCredential }, body,
    });
    const response = await middleware(incoming);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(incoming.bodyUsed).toBe(false);
    expect(await incoming.text()).toBe(body);
  });

  it.each(['POST', 'OPTIONS'])('enforces body-size checks before %s service admission', async method => {
    const response = await middleware(serviceRequest({
      'content-length': String(2 * 1024 * 1024 + 1),
    }, finderPath, method));
    expect(response.status).toBe(413);
    expect(await response.clone().json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordTelemetry).not.toHaveBeenCalled();
    await expectNoClientSecret(response);
  });

  it('keeps preflights independent even with a valid service credential', async () => {
    await seed('service-expensive', 'service-key', 600);
    const response = await middleware(serviceRequest({
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    }, finderPath, 'OPTIONS'));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('x-middleware-next')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-api-key-data')).toBeNull();
    expect(await count('service-expensive', 'service-key')).toBe(600);
    expect(namespaces()).toEqual(['service-expensive', 'cors-preflight', 'cors-preflight-global']);
    expect(recordTelemetry).not.toHaveBeenCalled();
    expect((await middleware(request())).status).toBe(401);
  });

  it.each([
    ['/api/visitors/identity/token', 'tracking'],
    ['/api/visitors/identity/token/current-user', 'identity-current-user-admission'],
    ['/api/visitors/session/session-id/identify/token', 'tracking'],
  ])('delegates %s to independent identity authorization without granting a service principal', async (path, namespace) => {
    const response = await middleware(serviceRequest({
      'x-api-key-data': '{"isService":true}', 'x-auth-user-id': 'spoof', 'x-auth-validated': 'true',
    }, path));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    for (const header of ['x-api-key-data', 'x-auth-user-id', 'x-auth-validated']) {
      expect(response.headers.get(`x-middleware-request-${header}`)).toBeNull();
    }
    expect(namespaces()).toEqual([namespace, 'tracking-global']);
    expect(recordTelemetry).not.toHaveBeenCalled();
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it.each([
    '/api/agents/whatsapp', '/api/agents/gear/whatsapp/webhook',
    '/api/integrations/stripe/webhook', '/api/integrations/agentmail/webhook/received',
  ])('preserves webhook admission and independent signature validation for %s', async path => {
    const response = await middleware(serviceRequest({ 'x-api-key-data': '{"isService":true}' }, path));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-middleware-request-x-api-key-data')).toBeNull();
    expect(namespaces()).toEqual(['webhook', 'webhook-global']);
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/agents/customerSupport/conversations', 'GET', 'expensive'],
    ['/api/agents/customerSupport/conversations/messages', 'GET', 'expensive'],
    ['/api/workflow/customerSupport', 'POST', 'expensive'],
    ['/api/workflow/customerSupport/status', 'POST', 'expensive'],
    ['/api/public/video/prompt/demo', 'GET', 'expensive'],
    ['/api/public/image/prompt/demo', 'GET', 'public-image-read'],
    ['/api/public/image/prompt/demo', 'POST', 'expensive'],
    ['/api/public/posts', 'GET', 'public-read'],
    ['/api/visitors/track', 'POST', 'tracking'],
    ['/api/ai/image/health', 'GET', 'api'],
    ['/api/private', 'POST', 'api'],
  ])('does not replace existing admission for %s %s', async (path, method, namespace) => {
    const response = await middleware(serviceRequest({}, path, method));
    expect(response.status).toBe(200);
    expect(namespaces()).toContain(namespace);
    expect(namespaces()).toContain('api-key-validation');
    expect(namespaces()).not.toContain('service-expensive');
    expect(await count(namespace, ip)).toBe(1);
  });

  it('cannot exceed the public expensive/IP cap by supplying a service key', async () => {
    const path = '/api/workflow/customerSupport';
    await seed('expensive', ip, 20);
    const response = await middleware(serviceRequest({}, path));
    expect(response.status).toBe(429);
    expect(response.headers.get('x-ratelimit-limit')).toBe('20');
    expect(namespaces()).not.toContain('service-expensive');
    expect(recordTelemetry).not.toHaveBeenCalled();
  });
});