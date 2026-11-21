import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { isValidUUID } from '@/lib/agentbase/utils/UuidUtils';
import { invalidateCampaignPromptProjection } from '../campaign-prompt-cache';

const site = randomUUID(), other = randomUUID();
const values = new Map<string, string>();
const redis = {
  status: 'ready',
  get: jest.fn(async (key: string) => values.get(key) ?? null),
  set: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
  eval: jest.fn(async (_script: string, _keys: number, key: string, expected: string, json: string, until: number) => {
    if ((values.get(key) ?? '') === expected && until > Date.now()) values.set(key, json);
  }),
};
const client = jest.fn(() => redis);
const query = {
  select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
  order: jest.fn<(_column: string, _options: { ascending: boolean }) => Promise<{ data?: unknown; error?: unknown }>>(),
};
const from = jest.fn((_table: string) => query);
jest.unstable_mockModule('@/lib/utils/redis-client', () => ({ getRedisClient: client }));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/agentbase/adapters/DatabaseAdapter', () => ({ DatabaseAdapter: { isValidUUID } }));
jest.unstable_mockModule('@/lib/agentbase/services/agent/AgentCacheService', () => ({ AgentCacheService: class {} }));
jest.unstable_mockModule('@/lib/agentbase/services/command/CommandCache', () => ({ CommandCache: {} }));
const { DataFetcher } = await import('@/lib/agentbase/services/agent/BackgroundServices/DataFetcher');
const read = DataFetcher.getActiveCampaigns;

beforeEach(() => {
  jest.clearAllMocks();
  values.clear();
  redis.status = 'ready';
  query.order.mockReset().mockResolvedValue({ data: [{ title: 'Fresh' }] });
  jest.replaceProperty(process, 'env', { ...process.env, REDIS_URL: '', REDIS_CACHE_URL: 'redis://cache.example.test' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it('caches only the ordered prompt projection under the canonical site key', async () => {
  query.order.mockResolvedValueOnce({ data: [
    { title: ' Second ', description: ' Offer ', budget: 20 }, { title: ' ', description: 'Skip' },
    { title: 'First', description: '  ', metadata: { private: true } },
  ] });
  const expected = [{ title: 'Second', description: 'Offer' }, { title: 'First' }];
  expect(await read(site)).toEqual(expected);
  expect(from).toHaveBeenCalledWith('campaigns');
  expect(query.select).toHaveBeenCalledWith('title, description');
  expect(query.eq.mock.calls).toEqual([['site_id', site], ['status', 'active']]);
  expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  expect([...values.values()]).toEqual([JSON.stringify(expected)]);
  expect(await read(site.toUpperCase())).toEqual(expected);
  expect(query.order).toHaveBeenCalledTimes(1);
  expect(await read(other)).toEqual([{ title: 'Fresh' }]);
  expect(values.size).toBe(2);
  const [, , key, , , until] = redis.eval.mock.calls[0];
  expect(key).toContain(site); expect(until).toBeGreaterThan(Date.now());
  expect(until).toBeLessThanOrEqual(Date.now() + 60_000);
});

it('does not query or touch Redis with an invalid tenant', async () => {
  expect(await read('not-a-site')).toEqual([]);
  expect(client).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
});

it('caches a successful empty projection but never a DB error, exception or missing result', async () => {
  query.order.mockResolvedValueOnce({ data: [], error: { message: 'query failed' } })
    .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ data: null })
    .mockResolvedValueOnce({ data: [] });
  for (let i = 0; i < 3; i++) expect(await read(site)).toEqual([]);
  expect(redis.eval).not.toHaveBeenCalled();
  expect(await read(site)).toEqual([]); expect(await read(site)).toEqual([]);
  expect(query.order).toHaveBeenCalledTimes(4); expect([...values.values()]).toEqual(['[]']);
});

it.each(['[', '{}', '[{"title":"X","budget":7}]', '[{"title":""}]', '[{"title":"X","description":null}]'])(
  'falls back to Supabase on invalid cached data: %s', async raw => {
    redis.get.mockResolvedValueOnce(raw);
    expect(await read(site)).toEqual([{ title: 'Fresh' }]);
    expect(query.order).toHaveBeenCalledTimes(1);
  },
);

it('does not cache oversized lists or truncate the caller’s prompt', async () => {
  const rows = [{ title: 'Offer', description: 'a'.repeat(128 * 1024) }];
  query.order.mockResolvedValue({ data: rows });
  expect(await read(site)).toEqual(rows); expect(redis.eval).not.toHaveBeenCalled();
});

it('fails open when Redis is unconfigured, connecting, or rejects commands', async () => {
  delete process.env.REDIS_CACHE_URL;
  const expected = [{ title: 'Fresh' }];
  expect(await read(site)).toEqual(expected);
  await invalidateCampaignPromptProjection(site); expect(client).not.toHaveBeenCalled();
  process.env.REDIS_URL = 'redis://cache.example.test'; redis.status = 'connecting';
  expect(await read(site)).toEqual(expected); expect(redis.get).not.toHaveBeenCalled();
  redis.status = 'ready'; redis.get.mockRejectedValueOnce(new Error('read failed'));
  expect(await read(site)).toEqual(expected); expect(redis.eval).not.toHaveBeenCalled();
  redis.eval.mockRejectedValueOnce(new Error('write failed'));
  expect(await read(site)).toEqual(expected);
  redis.set.mockRejectedValueOnce(new Error('invalidation failed'));
  await expect(invalidateCampaignPromptProjection(site)).resolves.toBeUndefined();
});

it('caps stalled Redis reads, fills and invalidations at 100 ms each', async () => {
  jest.useFakeTimers();
  const never = new Promise<never>(() => {});
  redis.get.mockReturnValueOnce(never);
  const onRead = read(site);
  await jest.advanceTimersByTimeAsync(100);
  expect(await onRead).toEqual([{ title: 'Fresh' }]); expect(redis.eval).not.toHaveBeenCalled();
  redis.eval.mockReturnValueOnce(never);
  const onFill = read(site);
  await jest.advanceTimersByTimeAsync(100);
  expect(await onFill).toEqual([{ title: 'Fresh' }]);
  redis.set.mockReturnValueOnce(never);
  const onInvalidation = invalidateCampaignPromptProjection(site);
  await jest.advanceTimersByTimeAsync(100);
  await expect(onInvalidation).resolves.toBeUndefined(); expect(jest.getTimerCount()).toBe(0);
});

it('a mutation fences an in-flight miss without evicting other tenants', async () => {
  await read(other);
  let finish!: (result: { data: unknown }) => void;
  let started!: () => void;
  const loading = new Promise<void>(resolve => { started = resolve; });
  query.order.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; started(); }));
  const stale = read(site);
  await loading;
  await invalidateCampaignPromptProjection(site.toUpperCase());
  finish({ data: [{ title: 'Old' }] });
  expect(await stale).toEqual([{ title: 'Old' }]);
  expect(await read(site)).toEqual([{ title: 'Fresh' }]);
  expect(await read(other)).toEqual([{ title: 'Fresh' }]);
  expect(query.order).toHaveBeenCalledTimes(3);
});