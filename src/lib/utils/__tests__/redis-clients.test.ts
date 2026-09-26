import url from 'node:url';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { closeRedisConnection, getRedisClient } from '../redis-client';
import { closeTrackingRedisConnection, getTrackingRedisClient } from '../tracking-redis-client';

const environmentKeys = ['REDIS_URL', 'REDIS_CACHE_URL', 'REDIS_STREAMS_URL'] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

describe('Redis client configuration', () => {
  beforeEach(() => {
    environmentKeys.forEach((key) => { delete process.env[key]; });
    // Exercise the real constructors without opening sockets or reading application secrets.
    jest.spyOn(Redis.prototype, 'connect').mockResolvedValue(undefined);
    jest.spyOn(Redis.prototype, 'quit').mockResolvedValue('OK');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(url, 'parse').mockImplementation(() => {
      throw new Error('Legacy URL parsing must not be used');
    });
  });

  afterEach(async () => {
    await closeRedisConnection();
    await closeTrackingRedisConnection();
    jest.restoreAllMocks();
    environmentKeys.forEach((key) => {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  it('keeps cache and streams isolated and reuses each singleton', () => {
    process.env.REDIS_URL = 'redis://fallback.example.test';
    process.env.REDIS_CACHE_URL = ' rediss://cache-user:cache-pass@cache.example.test:10000/1 ';
    process.env.REDIS_STREAMS_URL = ' rediss://stream-user:stream-pass@streams.example.test:10000/2 ';

    const cache = getRedisClient();
    const streams = getTrackingRedisClient();

    expect(cache.options).toMatchObject({
      host: 'cache.example.test', port: 10000, db: 1, tls: {},
      username: 'cache-user', password: 'cache-pass',
    });
    expect(streams.options).toMatchObject({
      host: 'streams.example.test', port: 10000, db: 2, tls: {},
      username: 'stream-user', password: 'stream-pass',
    });
    expect(getRedisClient()).toBe(cache);
    expect(getTrackingRedisClient()).toBe(streams);
    expect(cache).not.toBe(streams);
    expect(Redis.prototype.connect).toHaveBeenCalledTimes(2);
    expect(url.parse).not.toHaveBeenCalled();
    for (const client of [cache, streams]) {
      expect(client.options).toMatchObject({
        maxRetriesPerRequest: 5, enableReadyCheck: true, connectTimeout: 15000, lazyConnect: false,
      });
      expect(client.options.retryStrategy?.(1)).toBe(100);
      expect(client.options.retryStrategy?.(200)).toBe(10000);
    }
  });

  it('falls back to REDIS_URL for blank dedicated URLs', () => {
    process.env.REDIS_URL = 'redis://:fallback-pass@fallback.example.test:6380/3';
    process.env.REDIS_CACHE_URL = '  ';
    process.env.REDIS_STREAMS_URL = '  ';
    for (const client of [getRedisClient(), getTrackingRedisClient()]) {
      expect(client.options).toMatchObject({
        host: 'fallback.example.test', port: 6380, db: 3, password: 'fallback-pass',
      });
      expect(client.options.tls).toBeUndefined();
    }
  });

  it('retains the local cache default but requires configuration for durable streams', () => {
    expect(getRedisClient().options).toMatchObject({ host: 'localhost', port: 6379, db: 0 });
    expect(() => getTrackingRedisClient()).toThrow('REDIS_STREAMS_URL or REDIS_URL is required');
  });

  it('does not expose password-only credentials or query secrets in connection logs', () => {
    process.env.REDIS_CACHE_URL = 'rediss://:super-secret@cache.example.test:10000?password=query-secret';
    getRedisClient();
    expect(console.log).toHaveBeenCalledWith(
      '[Redis Client] Attempting to connect to Redis at cache.example.test:10000',
    );
    expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain('secret');
  });

  it('does not log malformed credentials and can retry after a configuration error', () => {
    process.env.REDIS_CACHE_URL = 'rediss://user:secret%ZZ@cache.example.test';
    expect(() => getRedisClient()).toThrow('Invalid Redis URL configuration');
    expect(Redis.prototype.connect).not.toHaveBeenCalled();
    expect(String(jest.mocked(console.error).mock.calls)).not.toContain('secret');

    process.env.REDIS_CACHE_URL = 'redis://localhost';
    expect(getRedisClient().options.host).toBe('localhost');
  });
});