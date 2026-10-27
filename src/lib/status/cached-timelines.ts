import { acquireLock, getCachedJson, releaseLock, setCachedJson } from '@/lib/security/upstash-rest';
import { getSystemTimelines, type SystemTimeline } from './get-system-timelines';

const CACHE_SECONDS = 60;
const FAILURE_SECONDS = 30;
// Covers bounded database reads and Redis writes without lease renewal.
const LOCK_SECONDS = 60;
const WAIT_MS = 250;
const WAIT_ATTEMPTS = 8;

interface LocalSnapshot {
  key: string;
  expiresAt: number;
  rows?: SystemTimeline[];
}

/** Isolated process-local state; Redis owns cross-instance admission. */
export function createTimelineCache(): () => Promise<SystemTimeline[]> {
  let pending: Promise<SystemTimeline[]> | undefined;
  let local: LocalSnapshot | undefined;
  const unavailable = () => new Error('System status history is temporarily unavailable');

  async function load(key: string): Promise<SystemTimeline[]> {
    const cached = await getCachedJson<SystemTimeline[]>(key);
    if (cached) {
      local = { key, rows: cached, expiresAt: Date.now() + CACHE_SECONDS * 1_000 };
      return cached;
    }
    const failureKey = `${key}:retry-after`;
    if (await getCachedJson<boolean>(failureKey)) throw unavailable();
    const lockKey = `${key}:refresh`;
    const lock = await acquireLock(lockKey, LOCK_SECONDS);
    if (lock.state === 'contended') {
      for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, WAIT_MS));
        const refreshed = await getCachedJson<SystemTimeline[]>(key);
        if (refreshed) {
          local = { key, rows: refreshed, expiresAt: Date.now() + CACHE_SECONDS * 1_000 };
          return refreshed;
        }
        if (await getCachedJson<boolean>(failureKey)) break;
      }
      // Contenders cannot start another scan or invent empty data.
      throw unavailable();
    }
    // Redis failure is not permission to fan out expensive database work.
    if (lock.state !== 'acquired') throw unavailable();
    try {
      // Close the cache-miss race if a previous owner completed before SET NX.
      const refreshed = await getCachedJson<SystemTimeline[]>(key);
      if (refreshed) {
        local = { key, rows: refreshed, expiresAt: Date.now() + CACHE_SECONDS * 1_000 };
        await releaseLock(lockKey, lock.token);
        return refreshed;
      }
      if (await getCachedJson<boolean>(failureKey)) throw unavailable();
      const rows = await getSystemTimelines();
      local = { key, rows, expiresAt: Date.now() + CACHE_SECONDS * 1_000 };
      // On failed publication retain the lease until expiry, so other instances
      // cannot immediately repeat a scan whose result could not be shared.
      if (await setCachedJson(key, rows, CACHE_SECONDS)) {
        await releaseLock(lockKey, lock.token);
      }
      return rows;
    } catch (error) {
      local = { key, expiresAt: Date.now() + FAILURE_SECONDS * 1_000 };
      if (await setCachedJson(failureKey, true, FAILURE_SECONDS)) {
        await releaseLock(lockKey, lock.token);
      }
      throw error;
    }
  }

  return async () => {
    const key = `cache:status:timelines:v3:${new Date().toISOString().slice(0, 10)}`;
    if (local?.key === key && local.expiresAt > Date.now()) {
      if (local.rows) return local.rows;
      throw unavailable();
    }
    if (pending) return pending;
    const current = load(key).catch(error => {
      if (!local || local.key !== key || local.expiresAt <= Date.now()) {
        local = { key, expiresAt: Date.now() + FAILURE_SECONDS * 1_000 };
      }
      throw error;
    });
    pending = current;
    try { return await current; } finally { pending = undefined; }
  };
}

export const getCachedSystemTimelines = createTimelineCache();