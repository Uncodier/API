import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  acquireLock,
  checkRateLimit,
  claimKey,
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

describe('Upstash REST security primitives', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
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
});
