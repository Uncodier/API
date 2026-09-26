import url from 'node:url';
import Redis from 'ioredis';
import { describe, expect, it, jest } from '@jest/globals';
import { parseRedisUrl } from '../redis-options';

describe('Redis URL options', () => {
  it('preserves Azure TLS, port, ACL credentials, and database', () => {
    expect(parseRedisUrl(
      ' rediss://default:pass%40word%3A%2F%2B%25@cache.example.test:10000/2 ',
    )).toEqual({
      host: 'cache.example.test',
      port: 10000,
      username: 'default',
      password: 'pass@word:/+%',
      db: 2,
      tls: {},
    });
  });

  it.each(['redis://localhost', 'redis://localhost/'])(
    'defaults to port 6379 and database 0 without TLS for %s',
    (value) => {
      expect(parseRedisUrl(value)).toEqual({ host: 'localhost', port: 6379, db: 0 });
    },
  );

  it('supports password-only authentication', () => {
    expect(parseRedisUrl('redis://:p%40ss@localhost')).toMatchObject({
      username: '',
      password: 'p@ss',
    });
  });

  it('decodes credentials exactly once', () => {
    expect(parseRedisUrl('redis://user%40tenant:p%2540ss@localhost')).toMatchObject({
      username: 'user@tenant',
      password: 'p%40ss',
    });
  });

  it('removes IPv6 brackets for socket connections', () => {
    expect(parseRedisUrl('redis://[::1]:6380/3')).toEqual({
      host: '::1', port: 6380, db: 3,
    });
  });

  it('preserves query options and numeric address family', () => {
    expect(parseRedisUrl(
      'redis://localhost?db=4&port=6380&family=6&connectionName=live%20logs',
    )).toEqual({
      host: 'localhost', port: 6380, db: 4, family: 6, connectionName: 'live logs',
    });
  });

  it('gives authority and path precedence over query credentials, port, and db', () => {
    expect(parseRedisUrl(
      'redis://user:pass@localhost:6379/2?port=6380&db=4&username=other&password=other',
    )).toMatchObject({
      host: 'localhost', port: 6379, db: 2, username: 'user', password: 'pass',
    });
  });

  it.each([
    'not-a-url',
    'https://user:secret@localhost',
    'redis://',
    'redis://localhost:invalid',
    'redis://localhost:70000',
    'redis://localhost:0',
    'redis://localhost/-1',
    'redis://localhost/1.5',
    'redis://localhost/not-a-db',
    'redis://localhost/1/2',
    'redis://localhost?db=9007199254740992',
    'redis://localhost?family=5',
    'redis://user:secret%ZZ@localhost',
  ])('rejects invalid configuration without exposing its input: %s', (value) => {
    expect(() => parseRedisUrl(value)).toThrow('Invalid Redis URL configuration');
    try {
      parseRedisUrl(value);
    } catch (error) {
      expect(String(error)).not.toContain(value);
      expect(String(error)).not.toContain('secret');
    }
  });

  it('constructs the real ioredis client without calling the legacy URL parser', () => {
    const legacyParser = jest.spyOn(url, 'parse').mockImplementation(() => {
      throw new Error('Legacy URL parsing must not be used');
    });
    let client: Redis | undefined;
    try {
      client = new Redis({
        ...parseRedisUrl('rediss://default:secret@cache.example.test:10000/2'),
        lazyConnect: true,
      });
      expect(client.status).toBe('wait');
      expect(client.options).toMatchObject({
        host: 'cache.example.test', port: 10000, db: 2, tls: {},
        username: 'default', password: 'secret',
      });
      expect(legacyParser).not.toHaveBeenCalled();
    } finally {
      client?.disconnect();
      legacyParser.mockRestore();
    }
  });
});