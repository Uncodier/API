import { createHash } from 'node:crypto';
import { getTrackingRedisClient } from '@/lib/utils/tracking-redis-client';

const ADMISSION_SCRIPT = `
local decision = redis.call('GET', KEYS[1])
if not decision then
  decision = ARGV[1]
  redis.call('SET', KEYS[1], decision, 'EX', ARGV[2])
end

if decision ~= '1' then
  return {0, 'sampled_out'}
end

local now = tonumber(ARGV[3])
local active_until = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)

local global_member = redis.call('ZSCORE', KEYS[2], ARGV[5])
local site_member = redis.call('ZSCORE', KEYS[3], ARGV[5])
if not global_member and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[6]) then
  redis.call('SET', KEYS[1], '0', 'EX', ARGV[2])
  return {0, 'global_session_limit'}
end
if not site_member and redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[7]) then
  redis.call('SET', KEYS[1], '0', 'EX', ARGV[2])
  return {0, 'site_session_limit'}
end

local request_bytes = tonumber(ARGV[8])
local global_bytes = tonumber(redis.call('GET', KEYS[4]) or '0')
local site_bytes = tonumber(redis.call('GET', KEYS[5]) or '0')
local session_requests = tonumber(redis.call('GET', KEYS[6]) or '0')

if global_bytes + request_bytes > tonumber(ARGV[9]) then
  redis.call('SET', KEYS[1], '0', 'EX', ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[5])
  redis.call('ZREM', KEYS[3], ARGV[5])
  return {0, 'global_byte_limit'}
end
if site_bytes + request_bytes > tonumber(ARGV[10]) then
  redis.call('SET', KEYS[1], '0', 'EX', ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[5])
  redis.call('ZREM', KEYS[3], ARGV[5])
  return {0, 'site_byte_limit'}
end
if session_requests + 1 > tonumber(ARGV[11]) then
  redis.call('SET', KEYS[1], '0', 'EX', ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[5])
  redis.call('ZREM', KEYS[3], ARGV[5])
  return {0, 'session_request_limit'}
end

redis.call('ZADD', KEYS[2], active_until, ARGV[5])
redis.call('ZADD', KEYS[3], active_until, ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[2])
redis.call('INCRBY', KEYS[4], request_bytes)
redis.call('EXPIRE', KEYS[4], ARGV[12])
redis.call('INCRBY', KEYS[5], request_bytes)
redis.call('EXPIRE', KEYS[5], ARGV[12])
redis.call('INCR', KEYS[6])
redis.call('EXPIRE', KEYS[6], ARGV[12])

return {1, 'accepted'}
`;

const DECISION_TTL_SECONDS = 2 * 60 * 60;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const BUCKET_TTL_SECONDS = 120;
const RECORDING_QUEUE_KEY = 'recording:{metadata}:pending';
const DEFAULT_MAX_QUEUE_MESSAGES = 300;

export interface RecordingAdmissionResult {
  accepted: boolean;
  reason: string;
}

function numberSetting(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum
    ? parsed
    : fallback;
}

function percentSetting(): number {
  return Math.min(
    100,
    numberSetting('SESSION_RECORDING_SAMPLE_PERCENT', 2, 0),
  );
}

function identityHash(siteId: string, sessionId: string): string {
  return createHash('sha256')
    .update(`${siteId}\0${sessionId}`)
    .digest('hex')
    .slice(0, 32);
}

export function shouldSampleRecording(
  siteId: string,
  sessionId: string,
  samplePercent = percentSetting(),
): boolean {
  if (samplePercent <= 0) return false;
  if (samplePercent >= 100) return true;
  const hash = createHash('sha256')
    .update(`${siteId}\0${sessionId}`)
    .digest();
  const bucket = hash.readUInt32BE(0) / 0x1_0000_0000;
  return bucket < samplePercent / 100;
}

export async function admitRecordingRequest(params: {
  siteId: string;
  sessionId: string;
  requestBytes: number;
  now?: number;
}): Promise<RecordingAdmissionResult> {
  if (
    !process.env.REDIS_STREAMS_URL?.trim()
    && !process.env.REDIS_URL?.trim()
  ) {
    console.error(
      '[Session Recording] durable Redis URL is missing; recording dropped',
    );
    return { accepted: false, reason: 'admission_unavailable' };
  }

  const now = params.now ?? Date.now();
  const minute = Math.floor(now / 60_000);
  const identity = identityHash(params.siteId, params.sessionId);
  const site = createHash('sha256')
    .update(params.siteId)
    .digest('hex')
    .slice(0, 16);
  const prefix = 'recording:{admission}';
  const keys = [
    `${prefix}:decision:${identity}`,
    `${prefix}:active:global`,
    `${prefix}:active:site:${site}`,
    `${prefix}:bytes:global:${minute}`,
    `${prefix}:bytes:site:${site}:${minute}`,
    `${prefix}:requests:session:${identity}:${minute}`,
  ];
  const candidate = shouldSampleRecording(params.siteId, params.sessionId)
    ? '1'
    : '0';

  try {
    const redis = getTrackingRedisClient();
    const backlog = await redis.xlen(RECORDING_QUEUE_KEY);
    if (
      backlog >= numberSetting(
        'SESSION_RECORDING_QUEUE_MAX_MESSAGES',
        DEFAULT_MAX_QUEUE_MESSAGES,
        1,
      )
    ) {
      return { accepted: false, reason: 'queue_backlog' };
    }

    const result = await redis.eval(
      ADMISSION_SCRIPT,
      keys.length,
      ...keys,
      candidate,
      String(DECISION_TTL_SECONDS),
      String(now),
      String(now + ACTIVE_WINDOW_MS),
      identity,
      String(numberSetting('SESSION_RECORDING_MAX_ACTIVE_GLOBAL', 500, 1)),
      String(numberSetting('SESSION_RECORDING_MAX_ACTIVE_PER_SITE', 50, 1)),
      String(params.requestBytes),
      String(numberSetting(
        'SESSION_RECORDING_MAX_GLOBAL_BYTES_PER_MINUTE',
        100 * 1024 * 1024,
        1,
      )),
      String(numberSetting(
        'SESSION_RECORDING_MAX_SITE_BYTES_PER_MINUTE',
        20 * 1024 * 1024,
        1,
      )),
      String(numberSetting(
        'SESSION_RECORDING_MAX_REQUESTS_PER_SESSION_MINUTE',
        20,
        1,
      )),
      String(BUCKET_TTL_SECONDS),
    ) as [number | string, string];

    return {
      accepted: Number(result?.[0]) === 1,
      reason: String(result?.[1] || 'admission_rejected'),
    };
  } catch (error) {
    console.error('[Session Recording] Admission control failed:', error);
    return { accepted: false, reason: 'admission_unavailable' };
  }
}
