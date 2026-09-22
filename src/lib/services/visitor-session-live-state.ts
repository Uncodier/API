import { getRedisClient } from '@/lib/utils/redis-client';
import {
  deleteRedisKeys,
  readRedisJson,
} from './redis-json-cache';

const SESSION_CACHE_TTL_SECONDS = 60;
const HEARTBEAT_TTL_SECONDS = 60 * 60;
const HEARTBEAT_FLUSH_SECONDS = 30;

const CACHE_SESSION_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

const MERGE_HEARTBEAT_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then
  return {'{}', -1}
end
local current = redis.call('GET', KEYS[1])
local state = {}
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == 'table' then state = decoded end
end
local incoming = cjson.decode(ARGV[1])
for key, value in pairs(incoming) do state[key] = value end
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[2])
local flush = redis.call('SET', KEYS[2], '1', 'EX', ARGV[3], 'NX')
return {encoded, flush and 1 or 0}
`;

function sessionKey(siteId: string, sessionId: string): string {
  return `cache:visitor-session:${siteId}:${sessionId}`;
}

function heartbeatKey(siteId: string, sessionId: string): string {
  return `visitor:heartbeat:${siteId}:${sessionId}`;
}

function flushKey(siteId: string, sessionId: string): string {
  return `visitor:heartbeat-flush:${siteId}:${sessionId}`;
}

function closedKey(siteId: string, sessionId: string): string {
  return `visitor:session-closed:${siteId}:${sessionId}`;
}

function configured(): boolean {
  return Boolean(
    process.env.REDIS_CACHE_URL?.trim() || process.env.REDIS_URL?.trim(),
  );
}

export async function readCachedVisitorSession<T>(
  siteId: string,
  sessionId: string,
): Promise<T | null> {
  if (!configured()) return null;
  try {
    const [closed, value] = await getRedisClient().mget(
      closedKey(siteId, sessionId),
      sessionKey(siteId, sessionId),
    );
    if (closed || !value) return null;
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function cacheVisitorSession(
  siteId: string,
  sessionId: string,
  session: unknown,
): Promise<void> {
  if (!configured()) return;
  try {
    await getRedisClient().eval(
      CACHE_SESSION_SCRIPT,
      2,
      sessionKey(siteId, sessionId),
      closedKey(siteId, sessionId),
      JSON.stringify(session),
      SESSION_CACHE_TTL_SECONDS,
    );
  } catch {
    // The database remains authoritative when cache writes fail.
  }
}

export async function readVisitorHeartbeat(
  siteId: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return (
    await readRedisJson<Record<string, unknown>>(
      heartbeatKey(siteId, sessionId),
    )
  ) ?? {};
}

export async function recordVisitorHeartbeat(
  siteId: string,
  sessionId: string,
  update: Record<string, unknown>,
): Promise<{
  state: Record<string, unknown>;
  shouldPersist: boolean;
  closed: boolean;
} | null> {
  if (!configured()) return null;
  try {
    const result = await getRedisClient().eval(
      MERGE_HEARTBEAT_SCRIPT,
      3,
      heartbeatKey(siteId, sessionId),
      flushKey(siteId, sessionId),
      closedKey(siteId, sessionId),
      JSON.stringify(update),
      HEARTBEAT_TTL_SECONDS,
      HEARTBEAT_FLUSH_SECONDS,
    ) as [string, number | string];
    return {
      state: JSON.parse(result[0]) as Record<string, unknown>,
      shouldPersist: Number(result[1]) === 1,
      closed: Number(result[1]) === -1,
    };
  } catch (error) {
    console.warn(
      '[Visitor Session] Redis heartbeat failed:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function clearVisitorLiveState(
  siteId: string,
  sessionId: string,
): Promise<void> {
  await deleteRedisKeys(
    sessionKey(siteId, sessionId),
    heartbeatKey(siteId, sessionId),
    flushKey(siteId, sessionId),
  );
}

export async function closeVisitorLiveState(
  siteId: string,
  sessionId: string,
): Promise<void> {
  if (!configured()) return;
  try {
    const redis = getRedisClient();
    await redis
      .multi()
      .del(
        sessionKey(siteId, sessionId),
        heartbeatKey(siteId, sessionId),
        flushKey(siteId, sessionId),
      )
      .set(closedKey(siteId, sessionId), '1', 'EX', 5 * 60)
      .exec();
  } catch (error) {
    console.warn(
      '[Visitor Session] Close marker failed:',
      error instanceof Error ? error.message : error,
    );
  }
}
