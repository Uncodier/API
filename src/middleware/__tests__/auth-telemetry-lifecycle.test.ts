import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

const abortSignal = jest.fn<(_signal: AbortSignal) => Promise<{ error: unknown }>>();
const insert = jest.fn((_values: Record<string, unknown>) => ({ abortSignal }));
const from = jest.fn((_table: string) => ({ insert }));
const validateApiKey = jest.fn();

// Real middleware, authentication, telemetry sampling and Redis REST adapter.
// Only external database and HTTP calls are mocked; never load local .env files.
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/services/api-keys/ApiKeyService', () => ({
  ApiKeyService: { validateApiKey },
}));

let middleware: typeof import('../requestMiddleware').default;
beforeAll(async () => { middleware = (await import('../requestMiddleware')).default; });

const envNames = [
  'NODE_ENV', 'SERVICE_API_KEY', 'REDIS_URL', 'REDIS_CACHE_URL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'CACHE_UPSTASH_REDIS_REST_URL', 'CACHE_UPSTASH_REDIS_REST_TOKEN',
];
const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));
const originalFetch = global.fetch;
let serviceApiKey: string;
let redisRestToken: string;

function expectSafeOutput(...sensitiveValues: string[]) {
  const output = JSON.stringify([
    jest.mocked(console.error).mock.calls, jest.mocked(console.warn).mock.calls, insert.mock.calls,
  ]);
  for (const value of sensitiveValues) expect(output).not.toContain(value);
}

function expectAuthObservation() {
  expect(from).toHaveBeenCalledTimes(1);
  expect(from).toHaveBeenCalledWith('system_telemetry');
  expect(insert).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledWith({
    system_key: 'api_auth', status: 'up', message: 'Service API Key used', latency_ms: 5,
  });
  expect(abortSignal).toHaveBeenCalledTimes(1);
  expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(abortSignal.mock.calls[0][0].aborted).toBe(false);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(3000);
}

describe('authentication telemetry through the real middleware lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    abortSignal.mockReset().mockResolvedValue({ error: null });
    for (const name of envNames) delete process.env[name];
    Object.assign(process.env, { NODE_ENV: 'production' });
    serviceApiKey = randomBytes(32).toString('hex');
    redisRestToken = randomBytes(32).toString('hex');
    process.env.SERVICE_API_KEY = serviceApiKey;
    process.env.CACHE_UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.CACHE_UPSTASH_REDIS_REST_TOKEN = redisRestToken;
    jest.spyOn(AbortSignal, 'timeout');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    expectSafeOutput(serviceApiKey, redisRestToken);
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each(['success', 'redis-error', 'timeout', 'contended'])('retains pending telemetry after a 200 response: %s', async outcome => {
    let complete!: (response: Response) => void;
    let fail!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const telemetryRequest = new Promise<Response>((resolve, reject) => { complete = resolve; fail = reject; });
    const fetchMock = jest.fn<typeof fetch>(async (_url, init) => {
      const args = JSON.parse(String(init?.body)) as Array<string | number>;
      if (args[0] === 'EVAL') return new Response(JSON.stringify({ result: [1, 60] }));
      if (args[0] === 'SET' && String(args[1]).startsWith('telemetry:sample:')) {
        markStarted();
        return telemetryRequest;
      }
      throw new Error('Unexpected command');
    });
    global.fetch = fetchMock;
    const waitUntil = jest.fn<(promise: Promise<unknown>) => void>();
    const request = new NextRequest('https://api.example.test/api/catalog/index/process', {
      method: 'POST', headers: { 'x-api-key': process.env.SERVICE_API_KEY! },
    });
    try {
      const response = await middleware(request, { waitUntil });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(validateApiKey).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(abortSignal).not.toHaveBeenCalled();
    } finally {
      // Hashing is asynchronous; release the mock only once fetch has attached
      // its rejection handler, not merely when authentication has responded.
      await started;
      if (outcome === 'timeout') fail(new DOMException('Timed out', 'TimeoutError'));
      else complete(new Response(JSON.stringify(outcome === 'redis-error'
        ? { error: redisRestToken }
        : { result: outcome === 'contended' ? null : 'OK' })));
    }
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    if (outcome === 'contended') {
      expect(from).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(abortSignal).not.toHaveBeenCalled();
    } else {
      // Redis sampling is optional evidence deduplication, not admission:
      // unavailable claims retain the real authentication observation.
      expectAuthObservation();
    }
    expect(console.warn).not.toHaveBeenCalled();
    if (outcome === 'redis-error' || outcome === 'timeout') {
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith('[Upstash REST] Command failed:', expect.objectContaining({
        operation: 'telemetry-sample', failure: outcome === 'timeout' ? 'timeout' : 'redis',
        stage: outcome === 'timeout' ? 'fetch' : 'response', timeout_ms: 2000,
        http_status: outcome === 'timeout' ? null : 200,
      }));
    } else {
      expect(console.error).not.toHaveBeenCalled();
    }
    const claims = fetchMock.mock.calls.filter(([, init]) => JSON.parse(String(init?.body))[0] === 'SET');
    expect(claims).toHaveLength(1);
    expect(JSON.parse(String(claims[0][1]?.body))).toEqual([
      'SET', expect.stringMatching(/^telemetry:sample:[a-f0-9]{64}$/), '1', 'EX', 60, 'NX',
    ]);
    expect(claims[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('records admitted authentication when Redis sampling becomes unconfigured', async () => {
    const namespaces: string[] = [];
    const fetchMock = jest.fn<typeof fetch>(async (_url, init) => {
      const args = JSON.parse(String(init?.body));
      expect(args[0]).toBe('EVAL');
      const namespace = String(args[3]).split(':')[1];
      namespaces.push(namespace);
      if (namespace === 'service-api-key') {
        // Remove sampling config only after the final admission command.
        // Missing admission Redis must remain fail-closed in production.
        delete process.env.CACHE_UPSTASH_REDIS_REST_URL;
        delete process.env.CACHE_UPSTASH_REDIS_REST_TOKEN;
      }
      return new Response(JSON.stringify({ result: [1, 60] }));
    });
    global.fetch = fetchMock;
    const waitUntil = jest.fn<(promise: Promise<unknown>) => void>();
    const response = await middleware(new NextRequest('https://api.example.test/api/catalog/index/process', {
      method: 'POST', headers: { 'x-api-key': serviceApiKey },
    }), { waitUntil });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    expect(namespaces).toEqual(['api', 'api-key-validation', 'api-key-validation-global', 'service-api-key']);
    expect(fetchMock).toHaveBeenCalledTimes(4); // No sampling HTTP request.
    expect(validateApiKey).not.toHaveBeenCalled();
    expectAuthObservation();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(['returned-error', 'rejected-write'])('keeps auth successful and warnings secret-safe for %s', async outcome => {
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(32).toString('hex');
    const databaseToken = randomBytes(32).toString('hex');
    const databaseUrl = new URL('https://database.example.test');
    databaseUrl.username = username;
    databaseUrl.password = password;
    databaseUrl.searchParams.set('token', databaseToken);
    const error = new Error(`Database unavailable: ${databaseUrl.href}`);
    if (outcome === 'returned-error') abortSignal.mockResolvedValueOnce({ error });
    else abortSignal.mockRejectedValueOnce(error);
    global.fetch = jest.fn<typeof fetch>(async (_url, init) => {
      const args = JSON.parse(String(init?.body));
      if (args[0] === 'EVAL') return new Response(JSON.stringify({ result: [1, 60] }));
      expect(args[0]).toBe('SET');
      expect(args[1]).toMatch(/^telemetry:sample:/);
      return new Response(JSON.stringify({ result: 'OK' }));
    });
    const waitUntil = jest.fn<(promise: Promise<unknown>) => void>();
    const response = await middleware(new NextRequest('https://api.example.test/api/catalog/index/process', {
      method: 'POST', headers: { 'x-api-key': serviceApiKey },
    }), { waitUntil });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    expect(validateApiKey).not.toHaveBeenCalled();
    expectAuthObservation();
    expect(console.error).not.toHaveBeenCalled();
    expect(jest.mocked(console.warn).mock.calls).toEqual([[
      outcome === 'returned-error' ? '[Telemetry] Evidence write failed' : '[Telemetry] Evidence write unavailable',
    ]]);
    expectSafeOutput(username, password, databaseToken, databaseUrl.href);
  });
});