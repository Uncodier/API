import { getCachedJson, setCachedJson } from '@/lib/security/upstash-rest';
import { getSystemTimelines, type SystemTimeline } from './get-system-timelines';

const pending = new Map<string, Promise<SystemTimeline[]>>();

/** Short cache and process-local coalescing for the full historical projection. */
export async function getCachedSystemTimelines(): Promise<SystemTimeline[]> {
  const key = `cache:status:timelines:v2:${new Date().toISOString().slice(0, 10)}`;
  const cached = await getCachedJson<SystemTimeline[]>(key);
  if (cached) return cached;
  const current = pending.get(key);
  if (current) return current;
  const load = (async () => {
    const timelines = await getSystemTimelines();
    await setCachedJson(key, timelines, 60);
    return timelines;
  })();
  pending.set(key, load);
  try { return await load; } finally { pending.delete(key); }
}