const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface UpstashConfig {
  url: string;
  token: string;
}

interface UpstashResponse<T> {
  result?: T;
  error?: string;
}

const COMMAND_TIMEOUT_MS = 2_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

type RedisOperation =
  | 'rate-limit'
  | 'cache-get'
  | 'cache-set'
  | 'key-claim'
  | 'telemetry-sample'
  | 'lock-acquire'
  | 'lock-release'
  | 'key-delete';
type RedisFailure = 'timeout' | 'aborted' | 'http' | 'redis' | 'invalid-response' | 'network';

// Only fixed operation/failure labels enter this bounded map; never Redis keys.
const errorLogWindows = new Map<string, { loggedAt: number; suppressed: number }>();

export interface RateLimitDecision {
  configured: boolean;
  available: boolean;
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export type KeyClaimResult =
  | { state: 'acquired' }
  | { state: 'contended' }
  | { state: 'unavailable' }
  | { state: 'unconfigured' };

export type LockAcquireResult =
  | { state: 'acquired'; token: string }
  | { state: 'contended' }
  | { state: 'unavailable' }
  | { state: 'unconfigured' };

export type LockReleaseResult =
  | { state: 'released' }
  | { state: 'not-owner' }
  | { state: 'unavailable' }
  | { state: 'unconfigured' };

function getConfig(): UpstashConfig | null {
  const cacheRestUrl = process.env.CACHE_UPSTASH_REDIS_REST_URL?.trim();
  const cacheRestToken = process.env.CACHE_UPSTASH_REDIS_REST_TOKEN?.trim();
  if (cacheRestUrl || cacheRestToken) {
    if (!cacheRestUrl || !cacheRestToken) return null;
    return {
      url: cacheRestUrl.replace(/\/+$/, ''),
      token: cacheRestToken,
    };
  }

  const cacheRedisUrl = process.env.REDIS_CACHE_URL?.trim();
  const legacyRestUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const legacyRestToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!cacheRedisUrl && (legacyRestUrl || legacyRestToken)) {
    if (!legacyRestUrl || !legacyRestToken) return null;
    return {
      url: legacyRestUrl.replace(/\/+$/, ''),
      token: legacyRestToken,
    };
  }

  const redisUrl = cacheRedisUrl || process.env.REDIS_URL?.trim();
  if (!redisUrl) return null;

  try {
    const parsed = new URL(redisUrl);
    if (!parsed.hostname.endsWith('.upstash.io') || !parsed.password) {
      return null;
    }
    return {
      url: `https://${parsed.hostname}`,
      token: decodeURIComponent(parsed.password),
    };
  } catch {
    return null;
  }
}

async function command<T>(args: Array<string | number>, operation: RedisOperation): Promise<{
  configured: boolean;
  available: boolean;
  result: T | null;
}> {
  const config = getConfig();
  if (!config) {
    return { configured: false, available: false, result: null };
  }

  const startedAt = Date.now();
  let signal: AbortSignal | undefined;
  let failure: RedisFailure = 'network';
  let stage: 'fetch' | 'response' = 'fetch';
  let httpStatus: number | null = null;
  try {
    signal = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal,
    });
    stage = 'response';
    httpStatus = response.status;
    if (!response.ok) {
      failure = 'http';
      throw new Error('Redis REST HTTP failure');
    }
    failure = 'invalid-response';
    const payload = await response.json() as UpstashResponse<T>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Redis REST invalid response');
    }
    if (payload.error) {
      failure = 'redis';
      throw new Error('Redis REST command rejected');
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
      throw new Error('Redis REST invalid response');
    }
    return { configured: true, available: true, result: payload.result ?? null };
  } catch (error) {
    // Runtime exceptions and upstream bodies can contain credentials or payloads.
    // Classify known error names, but never log raw errors, URLs or command args.
    // DOMException can cross runtime/VM boundaries without instanceof Error.
    const errorName = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
    if (errorName === 'TimeoutError' || (signal?.aborted && signal.reason?.name === 'TimeoutError')) {
      failure = 'timeout';
    } else if (errorName === 'AbortError' || signal?.aborted) {
      failure = 'aborted';
    } else if (errorName === 'TypeError' && stage === 'response') {
      // fetch body transport errors (for example a reset connection) are not
      // JSON syntax errors, even when the endpoint returned HTTP 200 headers.
      failure = 'network';
    }
    const now = Date.now();
    const logKey = `${operation}:${failure}`;
    const window = errorLogWindows.get(logKey);
    if (!window || now - window.loggedAt >= ERROR_LOG_INTERVAL_MS) {
      errorLogWindows.set(logKey, { loggedAt: now, suppressed: 0 });
      console.error('[Upstash REST] Command failed:', {
        operation,
        failure,
        stage,
        elapsed_ms: Math.max(0, now - startedAt),
        timeout_ms: COMMAND_TIMEOUT_MS,
        http_status: httpStatus ?? null,
        suppressed_since_last_log: window?.suppressed ?? 0,
      });
    } else {
      window.suppressed += 1;
    }
    return { configured: true, available: false, result: null };
  }
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const { available, configured, result } = await command<[number, number]>([
    'EVAL',
    RATE_LIMIT_SCRIPT,
    1,
    key,
    windowSeconds,
  ], 'rate-limit');
  if (!available || !result) {
    return {
      configured,
      available: false,
      success: true,
      limit,
      remaining: limit,
      reset: Date.now() + windowSeconds * 1_000,
    };
  }

  const count = Number(result[0]) || 0;
  const ttl = Math.max(1, Number(result[1]) || windowSeconds);
  return {
    configured: true,
    available: true,
    success: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    reset: Date.now() + ttl * 1_000,
  };
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  const { result } = await command<string>(['GET', key], 'cache-get');
  if (!result) return null;
  try {
    return JSON.parse(result) as T;
  } catch {
    return null;
  }
}

export async function setCachedJson(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean> {
  const { configured, result } = await command<string>([
    'SET',
    key,
    JSON.stringify(value),
    'EX',
    ttlSeconds,
  ], 'cache-set');
  return !configured || result === 'OK';
}

export async function claimKey(
  key: string,
  ttlSeconds: number,
  operation: 'key-claim' | 'telemetry-sample' = 'key-claim',
): Promise<KeyClaimResult> {
  const { available, configured, result } = await command<string>([
    'SET',
    key,
    '1',
    'EX',
    ttlSeconds,
    'NX',
  ], operation);
  if (!configured) return { state: 'unconfigured' };
  if (!available) return { state: 'unavailable' };
  return result === 'OK'
    ? { state: 'acquired' }
    : { state: 'contended' };
}

export async function acquireLock(
  key: string,
  ttlSeconds: number,
): Promise<LockAcquireResult> {
  const token = crypto.randomUUID();
  const { available, configured, result } = await command<string>([
    'SET',
    key,
    token,
    'EX',
    ttlSeconds,
    'NX',
  ], 'lock-acquire');
  if (!configured) return { state: 'unconfigured' };
  if (!available) return { state: 'unavailable' };
  return result === 'OK'
    ? { state: 'acquired', token }
    : { state: 'contended' };
}

export async function releaseLock(
  key: string,
  token: string,
): Promise<LockReleaseResult> {
  const { available, configured, result } = await command<number>([
    'EVAL',
    RELEASE_LOCK_SCRIPT,
    1,
    key,
    token,
  ], 'lock-release');
  if (!configured) return { state: 'unconfigured' };
  if (!available) return { state: 'unavailable' };
  return Number(result) === 1
    ? { state: 'released' }
    : { state: 'not-owner' };
}

export async function deleteKey(key: string): Promise<void> {
  await command<number>(['DEL', key], 'key-delete');
}
