import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { randomBytes } from 'node:crypto';
import {
  acquireLock,
  checkRateLimit,
  claimKey,
  deleteKey,
  getCachedJson,
  releaseLock,
  setCachedJson,
} from '../upstash-rest';

const originalEnv = {
  redisUrl: process.env.REDIS_URL,
  cacheRedisUrl: process.env.REDIS_CACHE_URL,
  restUrl: process.env.UPSTASH_REDIS_REST_URL,
  restToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  cacheRestUrl: process.env.CACHE_UPSTASH_REDIS_REST_URL,
  cacheRestToken: process.env.CACHE_UPSTASH_REDIS_REST_TOKEN,
};
const originalFetch = global.fetch;

describe('Upstash REST security primitives', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = randomBytes(32).toString('hex');
    delete process.env.REDIS_URL;
    delete process.env.REDIS_CACHE_URL;
    delete process.env.CACHE_UPSTASH_REDIS_REST_URL;
    delete process.env.CACHE_UPSTASH_REDIS_REST_TOKEN;
    global.fetch = jest.fn() as typeof fetch;
  });

  afterEach(() => {
    if (originalEnv.redisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalEnv.redisUrl;
    if (originalEnv.cacheRedisUrl === undefined) delete process.env.REDIS_CACHE_URL;
    else process.env.REDIS_CACHE_URL = originalEnv.cacheRedisUrl;
    if (originalEnv.restUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalEnv.restUrl;
    if (originalEnv.restToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalEnv.restToken;
    if (originalEnv.cacheRestUrl === undefined) delete process.env.CACHE_UPSTASH_REDIS_REST_URL;
    else process.env.CACHE_UPSTASH_REDIS_REST_URL = originalEnv.cacheRestUrl;
    if (originalEnv.cacheRestToken === undefined) delete process.env.CACHE_UPSTASH_REDIS_REST_TOKEN;
    else process.env.CACHE_UPSTASH_REDIS_REST_TOKEN = originalEnv.cacheRestToken;
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('denies requests after the fixed-window limit', async () => {
    (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue({
      ok: true,
      json: async () => ({ result: [3, 42] }),
    } as Response);

    await expect(checkRateLimit('rate:test', 2, 60)).resolves.toMatchObject({
      available: true,
      success: false,
      remaining: 0,
    });
  });

  it('fails open while reporting an unavailable configured Redis', async () => {
    (global.fetch as jest.MockedFunction<typeof fetch>)
      .mockRejectedValue(new Error('network unavailable'));

    await expect(checkRateLimit('rate:test', 2, 60)).resolves.toMatchObject({
      configured: true,
      available: false,
      success: true,
    });
  });

  it('round-trips JSON cache payloads', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: '{"allowed":true}' }),
      } as Response);

    await expect(setCachedJson('cache:test', { allowed: true }, 60))
      .resolves.toBe(true);
    await expect(getCachedJson<{ allowed: boolean }>('cache:test'))
      .resolves.toEqual({ allowed: true });
  });

  it('distinguishes acquired and contended claims', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as Response);

    await expect(claimKey('claim:test', 60))
      .resolves.toEqual({ state: 'acquired' });
    await expect(claimKey('claim:test', 60))
      .resolves.toEqual({ state: 'contended' });
  });

  it('distinguishes unavailable and unconfigured claims', async () => {
    (global.fetch as jest.MockedFunction<typeof fetch>)
      .mockRejectedValueOnce(new Error('network unavailable'));

    await expect(claimKey('claim:test', 60))
      .resolves.toEqual({ state: 'unavailable' });

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    await expect(claimKey('claim:test', 60))
      .resolves.toEqual({ state: 'unconfigured' });
  });

  it('does not mix partial specialized credentials with legacy credentials', async () => {
    process.env.CACHE_UPSTASH_REDIS_REST_URL = 'https://cache.example.test';
    delete process.env.CACHE_UPSTASH_REDIS_REST_TOKEN;

    await expect(claimKey('claim:test', 60))
      .resolves.toEqual({ state: 'unconfigured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('acquires and conditionally releases owner-token locks', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'OK' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 1 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 0 }),
      } as Response);

    const acquired = await acquireLock('lock:test', 60);
    expect(acquired.state).toBe('acquired');
    if (acquired.state !== 'acquired') {
      throw new Error('Expected an acquired lock');
    }
    await expect(releaseLock('lock:test', acquired.token))
      .resolves.toEqual({ state: 'released' });
    await expect(releaseLock('lock:test', 'wrong-owner'))
      .resolves.toEqual({ state: 'not-owner' });
  });

  it('distinguishes lock contention, unavailability, and missing config', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: null }),
      } as Response)
      .mockRejectedValueOnce(new Error('network unavailable'));

    await expect(acquireLock('lock:test', 60))
      .resolves.toEqual({ state: 'contended' });
    await expect(acquireLock('lock:test', 60))
      .resolves.toEqual({ state: 'unavailable' });

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    await expect(acquireLock('lock:test', 60))
      .resolves.toEqual({ state: 'unconfigured' });
  });

  describe('secret-safe failure diagnostics', () => {
    let clock = 1_900_000_000_000;

    beforeEach(() => {
      clock += 120_000;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    function diagnostic() {
      return jest.mocked(console.error).mock.calls.at(-1)?.[1];
    }

    it('aborts at the existing deadline without retries and recovers on the next request', async () => {
      const controller = new AbortController();
      const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      const fetchMock = jest.mocked(global.fetch);
      fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));

      const request = checkRateLimit('rate:test', 2, 60);
      clock += 2_000;
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

      await expect(request).resolves.toMatchObject({ configured: true, available: false });
      expect(timeout).toHaveBeenCalledWith(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(diagnostic()).toEqual({
        operation: 'rate-limit', failure: 'timeout', stage: 'fetch', elapsed_ms: 2_000,
        timeout_ms: 2_000, http_status: null, suppressed_since_last_log: 0,
      });

      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: [1, 60] }) } as Response);
      await expect(checkRateLimit('rate:test', 2, 60)).resolves.toMatchObject({ available: true, success: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['TimeoutError', 'timeout'],
      ['AbortError', 'aborted'],
      ['TypeError', 'network'],
    ])('classifies %s without logging sensitive error content', async (name, failure) => {
      const username = randomBytes(16).toString('hex');
      const password = randomBytes(32).toString('hex');
      const pathSecret = randomBytes(32).toString('hex');
      const querySecret = randomBytes(32).toString('hex');
      const url = new URL('https://redis.example.test');
      url.username = username;
      url.password = password;
      url.pathname = `/${pathSecret}`;
      url.searchParams.set('token', querySecret);
      process.env.UPSTASH_REDIS_REST_URL = url.toString();
      const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
      const key = randomBytes(32).toString('hex');
      const error = new Error(`${url} ${token} ${key}`);
      error.name = name;
      jest.mocked(global.fetch).mockRejectedValueOnce(error);

      await expect(claimKey(key, 60, 'telemetry-sample')).resolves.toEqual({ state: 'unavailable' });
      expect(diagnostic()).toMatchObject({ operation: 'telemetry-sample', failure, elapsed_ms: 0 });
      const logs = JSON.stringify(jest.mocked(console.error).mock.calls);
      for (const secret of [username, password, pathSecret, querySecret, token, key]) {
        expect(logs).not.toContain(secret);
      }
    });

    it('reports HTTP status without reading or logging the response body', async () => {
      const json = jest.fn();
      jest.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 503, json } as unknown as Response);
      await expect(getCachedJson('cache:test')).resolves.toBeNull();
      expect(diagnostic()).toMatchObject({ operation: 'cache-get', failure: 'http', stage: 'response', http_status: 503 });
      expect(json).not.toHaveBeenCalled();
    });

    it('does not leak Redis error payloads, stored values or arbitrary error names', async () => {
      const value = randomBytes(32).toString('hex');
      const key = randomBytes(32).toString('hex');
      const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
      jest.mocked(global.fetch).mockResolvedValueOnce({
        ok: true, status: 200, json: async () => ({ error: `${token} ${key} ${value}` }),
      } as Response);
      await expect(setCachedJson(key, { value }, 60)).resolves.toBe(false);
      expect(diagnostic()).toMatchObject({ operation: 'cache-set', failure: 'redis', http_status: 200 });

      const error = new Error(value);
      error.name = token;
      jest.mocked(global.fetch).mockRejectedValueOnce(error);
      await expect(deleteKey(key)).resolves.toBeUndefined();
      expect(diagnostic()).toMatchObject({ operation: 'key-delete', failure: 'network' });
      const logs = JSON.stringify(jest.mocked(console.error).mock.calls);
      for (const secret of [token, key, value]) expect(logs).not.toContain(secret);
    });

    it.each([null, {}, { error: null }, { unexpected: true }])('classifies malformed responses as unavailable: %j', async payload => {
      jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload } as Response);
      await expect(acquireLock('lock:test', 60)).resolves.toEqual({ state: 'unavailable' });
      expect(diagnostic()).toMatchObject({ operation: 'lock-acquire', failure: 'invalid-response', stage: 'response' });
    });

    it('identifies a timeout while reading the response body', async () => {
      jest.mocked(global.fetch).mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => { throw new DOMException('Timed out', 'TimeoutError'); },
      } as unknown as Response);
      await expect(getCachedJson('cache:test')).resolves.toBeNull();
      expect(diagnostic()).toMatchObject({ failure: 'timeout', stage: 'response', http_status: 200 });
    });

    it.each([
      [new TypeError('Body transport failed'), 'network'],
      [new SyntaxError('Invalid JSON'), 'invalid-response'],
    ])('distinguishes body transport and JSON parse failures: %s', async (error, failure) => {
      jest.mocked(global.fetch).mockResolvedValueOnce({
        ok: true, status: 200, json: async () => { throw error; },
      } as unknown as Response);
      await expect(getCachedJson('cache:test')).resolves.toBeNull();
      expect(diagnostic()).toMatchObject({ failure, stage: 'response', http_status: 200 });
    });

    it('throttles repeats without hiding different operations or failure categories', async () => {
      jest.mocked(global.fetch).mockRejectedValue(new TypeError('fetch failed'));
      await claimKey('claim:test', 60);
      await claimKey('claim:test', 60);
      await claimKey('claim:test', 60);
      expect(console.error).toHaveBeenCalledTimes(1);
      await claimKey('telemetry:test', 60, 'telemetry-sample');
      await releaseLock('lock:test', randomBytes(32).toString('hex'));
      expect(console.error).toHaveBeenCalledTimes(3);
      expect(diagnostic()).toMatchObject({ operation: 'lock-release', failure: 'network' });

      jest.mocked(global.fetch).mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
      await claimKey('claim:test', 60);
      expect(console.error).toHaveBeenCalledTimes(4);
      clock += 60_000;
      await claimKey('claim:test', 60);
      expect(console.error).toHaveBeenCalledTimes(5);
      expect(diagnostic()).toMatchObject({ operation: 'key-claim', failure: 'network', suppressed_since_last_log: 2 });
    });
  });
});
