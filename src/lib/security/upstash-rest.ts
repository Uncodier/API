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

let lastErrorLogAt = 0;

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
  const restUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (restUrl && restToken) {
    return {
      url: restUrl.replace(/\/+$/, ''),
      token: restToken,
    };
  }

  const redisUrl = process.env.REDIS_URL?.trim();
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

async function command<T>(args: Array<string | number>): Promise<{
  configured: boolean;
  available: boolean;
  result: T | null;
}> {
  const config = getConfig();
  if (!config) {
    return { configured: false, available: false, result: null };
  }

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      throw new Error(`Upstash returned ${response.status}`);
    }
    const payload = await response.json() as UpstashResponse<T>;
    if (payload.error) throw new Error(payload.error);
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
      throw new Error('Upstash returned an invalid response');
    }
    return { configured: true, available: true, result: payload.result ?? null };
  } catch (error) {
    if (Date.now() - lastErrorLogAt >= 60_000) {
      lastErrorLogAt = Date.now();
      console.error(
        '[Upstash REST] Command failed:',
        error instanceof Error ? error.message : error,
      );
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
  ]);
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
  const { result } = await command<string>(['GET', key]);
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
  ]);
  return !configured || result === 'OK';
}

export async function claimKey(
  key: string,
  ttlSeconds: number,
): Promise<KeyClaimResult> {
  const { available, configured, result } = await command<string>([
    'SET',
    key,
    '1',
    'EX',
    ttlSeconds,
    'NX',
  ]);
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
  ]);
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
  ]);
  if (!configured) return { state: 'unconfigured' };
  if (!available) return { state: 'unavailable' };
  return Number(result) === 1
    ? { state: 'released' }
    : { state: 'not-owner' };
}

export async function deleteKey(key: string): Promise<void> {
  await command<number>(['DEL', key]);
}
