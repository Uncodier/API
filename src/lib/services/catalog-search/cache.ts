import { createHash, randomUUID } from 'node:crypto';
import { getRedisClient } from '@/lib/utils/redis-client';
import { canonicalJson } from './contract';

const flights = new Map<string, Promise<unknown>>();
let cacheUnavailableUntil = 0;

export function catalogCacheKey(namespace: string, value: unknown): string {
  return `catalog:${namespace}:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** Redis is expendable: never wait through its connection retries on a search. */
async function cacheCommand<T>(operation: (client: ReturnType<typeof getRedisClient>) => Promise<T>): Promise<T | null> {
  if (Date.now() < cacheUnavailableUntil || !(process.env.REDIS_CACHE_URL || process.env.REDIS_URL)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = getRedisClient();
    if (client.status !== 'ready') return null;
    const result = await Promise.race([
      operation(client).then(value => ({ value })),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 120); }),
    ]);
    if (result === null) { cacheUnavailableUntil = Date.now() + 5_000; return null; }
    return result.value;
  } catch { cacheUnavailableUntil = Date.now() + 5_000; return null; }
  finally { if (timer) clearTimeout(timer); }
}

export async function readCatalogCache(key: string): Promise<unknown> {
  const raw = await cacheCommand(client => client.get(key));
  if (!raw || raw.length > 150_000) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function writeCatalogCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized.length > 150_000) return;
  const jitter = Math.floor(ttlSeconds * .1 * Math.random());
  await cacheCommand(client => client.set(key, serialized, 'EX', ttlSeconds + jitter));
}

export async function catalogSingleFlight<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  if (flights.size >= 256) throw new Error('Catalog search is busy');
  const promise = compute();
  flights.set(key, promise);
  try { return await promise; } finally { if (flights.get(key) === promise) flights.delete(key); }
}

/** Contention is not an outage. Caller may serve textual results instead of waiting. */
export async function acquireCatalogLock(key: string): Promise<{ token: string; acquired: boolean } | null> {
  const token = randomUUID();
  const response = await cacheCommand(async client => ({ result: await client.set(key, token, 'EX', 10, 'NX') }));
  return response ? { token, acquired: response.result === 'OK' } : null;
}

export async function releaseCatalogLock(key: string, token: string): Promise<void> {
  await cacheCommand(client => client.eval(
    "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
    1, key, token,
  ));
}