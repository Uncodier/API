import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

const abortSignal = jest.fn<(_signal: AbortSignal) => Promise<{ error: unknown }>>();
const insert = jest.fn((_values: Record<string, unknown>) => ({ abortSignal }));
const from = jest.fn((_table: string) => ({ insert }));
const validateApiKey = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/services/api-keys/ApiKeyService', () => ({ ApiKeyService: { validateApiKey } }));

let middleware: typeof import('../requestMiddleware').default;
beforeAll(async () => { middleware = (await import('../requestMiddleware')).default; });
const envNames = ['NODE_ENV', 'SERVICE_API_KEY', 'REDIS_URL', 'REDIS_CACHE_URL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'CACHE_UPSTASH_REDIS_REST_URL', 'CACHE_UPSTASH_REDIS_REST_TOKEN'];
const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));
function request() {
  return new NextRequest('https://api.example.test/api/mcp', {
    method: 'POST', headers: { 'x-api-key': process.env.SERVICE_API_KEY! },
  });
}

describe('MCP Redis timeouts with real middleware, auth and telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    abortSignal.mockReset().mockResolvedValue({ error: null });
    for (const name of envNames) delete process.env[name];
    Object.assign(process.env, { NODE_ENV: 'production',
      SERVICE_API_KEY: randomBytes(32).toString('hex'),
      CACHE_UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      CACHE_UPSTASH_REDIS_REST_TOKEN: randomBytes(32).toString('hex') });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(AbortSignal, 'timeout');
  });
  afterEach(() => {
    const output = JSON.stringify([
      jest.mocked(console.error).mock.calls, jest.mocked(console.warn).mock.calls, insert.mock.calls,
    ]);
    for (const name of ['SERVICE_API_KEY', 'CACHE_UPSTASH_REDIS_REST_TOKEN']) expect(output).not.toContain(process.env[name]);
    jest.restoreAllMocks();
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each(['api', 'api-key-validation', 'api-key-validation-global', 'service-api-key'])
    ('keeps admission fail-closed when %s times out', async namespace => {
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const args = JSON.parse(String(init?.body));
        if (String(args[3]).split(':')[1] === namespace) throw new DOMException('Timed out', 'TimeoutError');
        expect(args[0]).toBe('EVAL');
        return new Response(JSON.stringify({ result: [1, 60] }));
      });
      const waitUntil = jest.fn();
      const response = await middleware(request(), { waitUntil });
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('30');
      expect(response.headers.get('x-middleware-next')).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
      expect(waitUntil).not.toHaveBeenCalled();
      expect(validateApiKey).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(abortSignal).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });

  it.each(['timeout', 'contended'])('retains pending telemetry without blocking MCP admission: %s', async outcome => {
    let fail!: (error: Error) => void;
    let complete!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const pending = new Promise<Response>((resolve, reject) => { complete = resolve; fail = reject; });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const args = JSON.parse(String(init?.body));
      if (args[0] === 'EVAL') return new Response(JSON.stringify({ result: [1, 60] }));
      expect(args[0]).toBe('SET');
      expect(args).toEqual([
        'SET', expect.stringMatching(/^telemetry:sample:[a-f0-9]{64}$/), '1', 'EX', 60, 'NX',
      ]);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      markStarted();
      return pending;
    });
    const waitUntil = jest.fn<(promise: Promise<unknown>) => void>();
    try {
      const response = await middleware(request(), { waitUntil });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(validateApiKey).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(abortSignal).not.toHaveBeenCalled();
    } finally {
      await started;
      if (outcome === 'timeout') fail(new DOMException('Timed out', 'TimeoutError'));
      else complete(new Response(JSON.stringify({ result: null })));
    }
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    if (outcome === 'timeout') {
      // Sampling timeout must retain the real observation; admission timeouts
      // above remain fail-closed and never reach authentication telemetry.
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
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith('[Upstash REST] Command failed:', expect.objectContaining({
        operation: 'telemetry-sample', failure: 'timeout', stage: 'fetch',
        timeout_ms: 2000, http_status: null,
      }));
    } else {
      expect(from).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(abortSignal).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    }
    expect(console.warn).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => JSON.parse(String(init?.body))[0] === 'SET')).toHaveLength(1);
  });
});