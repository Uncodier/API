type CampaignPrompt = { title: string; description?: string };
type RedisClient = ReturnType<typeof import('@/lib/utils/redis-client').getRedisClient>;

const TTL_SECONDS = 60;
const MAX_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 100;

function key(siteId: string): string {
  return `cache:active-campaign-prompt:v1:${siteId.toLowerCase()}`;
}

async function command<T>(run: (redis: RedisClient) => Promise<T>, invalidating = false): Promise<T | undefined> {
  if (!process.env.REDIS_CACHE_URL?.trim() && !process.env.REDIS_URL?.trim()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    return await Promise.race([
      import('@/lib/utils/redis-client').then(({ getRedisClient }) => {
        if (expired) return;
        const redis = getRedisClient();
        // Cold writers may queue invalidation; a late marker can only force a DB read.
        if (!invalidating && redis.status !== 'ready') return;
        return run(redis);
      }),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => { expired = true; resolve(undefined); }, COMMAND_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function isPromptList(value: unknown): value is CampaignPrompt[] {
  const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s === s.trim();
  return Array.isArray(value) && value.every(row => row !== null && typeof row === 'object'
    && text(row.title) && (row.description === undefined || text(row.description))
    && Object.keys(row).every(k => k === 'title' || k === 'description'));
}

// A concurrent mutation replaces the previous value (even a miss) with a unique
// marker. Never refill from a snapshot older than that mutation or its marker's TTL.
const FILL_IF_UNCHANGED = `
  if (redis.call('GET', KEYS[1]) or '') == ARGV[1] then
    return redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
  end
  return 0`;

/** The caller supplies an already-authorized site and a loader that throws on DB failure. */
export async function getCampaignPromptProjection(
  siteId: string,
  load: () => Promise<CampaignPrompt[]>,
): Promise<CampaignPrompt[]> {
  const cacheKey = key(siteId);
  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  const raw = await command(redis => redis.get(cacheKey)); // null = miss, undefined = unavailable
  if (raw === undefined || (raw !== null && Buffer.byteLength(raw) > MAX_BYTES)) return load();
  if (raw?.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPromptList(parsed)) return parsed;
    } catch { /* Malformed cache entries are misses. */ }
  }

  const rows = await load();
  if (isPromptList(rows)) {
    const json = JSON.stringify(rows);
    if (Buffer.byteLength(json) <= MAX_BYTES) {
      await command(redis => redis.eval(FILL_IF_UNCHANGED, 1, cacheKey, raw ?? '', json, expiresAt));
    }
  }
  return rows;
}

export async function invalidateCampaignPromptProjection(siteId: string): Promise<void> {
  await command(redis => redis.set(key(siteId), crypto.randomUUID(), 'EX', TTL_SECONDS), true);
}