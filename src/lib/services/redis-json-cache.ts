import { getRedisClient } from '@/lib/utils/redis-client';

function configured(): boolean {
  return Boolean(
    process.env.REDIS_CACHE_URL?.trim() || process.env.REDIS_URL?.trim(),
  );
}

export async function readRedisJson<T>(key: string): Promise<T | null> {
  if (!configured()) return null;
  try {
    const value = await getRedisClient().get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn(
      `[Redis Cache] Read failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function writeRedisJson(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean> {
  if (!configured()) return false;
  try {
    await getRedisClient().set(
      key,
      JSON.stringify(value),
      'EX',
      Math.max(1, Math.trunc(ttlSeconds)),
    );
    return true;
  } catch (error) {
    console.warn(
      `[Redis Cache] Write failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export async function deleteRedisKeys(...keys: string[]): Promise<void> {
  if (!configured() || keys.length === 0) return;
  try {
    await getRedisClient().del(...keys);
  } catch (error) {
    console.warn(
      '[Redis Cache] Invalidation failed:',
      error instanceof Error ? error.message : error,
    );
  }
}
