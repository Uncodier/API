import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

const insert = jest.fn(async () => ({ error: null }));
const from = jest.fn(() => ({ insert }));
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

describe('authentication telemetry through the real middleware lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of envNames) delete process.env[name];
    Object.assign(process.env, { NODE_ENV: 'production' });
    process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
    process.env.CACHE_UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.CACHE_UPSTASH_REDIS_REST_TOKEN = randomBytes(32).toString('hex');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each(['success', 'redis-error', 'timeout'])('retains pending telemetry after a 200 response: %s', async outcome => {
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
    } finally {
      // Hashing is asynchronous; release the mock only once fetch has attached
      // its rejection handler, not merely when authentication has responded.
      await started;
      if (outcome === 'timeout') fail(new DOMException('Timed out', 'TimeoutError'));
      else complete(new Response(JSON.stringify(outcome === 'success'
        ? { result: 'OK' }
        : { error: process.env.CACHE_UPSTASH_REDIS_REST_TOKEN })));
    }
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    if (outcome === 'success') {
      expect(from).toHaveBeenCalledWith('system_telemetry');
      expect(insert).toHaveBeenCalledWith(expect.objectContaining({
        system_key: 'api_auth', status: 'up', message: 'Service API Key used',
      }));
      expect(console.error).not.toHaveBeenCalled();
    } else {
      expect(insert).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith('[Upstash REST] Command failed:', expect.objectContaining({
        operation: 'telemetry-sample', failure: outcome === 'timeout' ? 'timeout' : 'redis',
      }));
    }
    expect(fetchMock.mock.calls.filter(([, init]) => JSON.parse(String(init?.body))[0] === 'SET')).toHaveLength(1);
    const output = JSON.stringify([jest.mocked(console.error).mock.calls, jest.mocked(console.warn).mock.calls, insert.mock.calls]);
    for (const name of ['SERVICE_API_KEY', 'CACHE_UPSTASH_REDIS_REST_TOKEN']) {
      expect(output).not.toContain(process.env[name]);
    }
  });
});