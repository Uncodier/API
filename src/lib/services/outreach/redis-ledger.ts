import { randomUUID } from 'crypto';
import { getRedisClient } from '@/lib/utils/redis-client';
import type { OutreachActivityKey } from './policy';

// One atomic operation reserves BOTH the daily slot and the message lease. The
// message key has no expiry: an unknown provider outcome must never auto-resend.
export const RESERVE_OUTREACH_LUA = `
local existing = redis.call('GET', KEYS[2])
if existing then return {'existing', existing} end
if redis.call('EXISTS', KEYS[3]) == 1 then return {'busy', ''} end
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local baseline = tonumber(ARGV[4])
if baseline > count then
  count = baseline
  redis.call('SET', KEYS[1], count, 'EX', ARGV[2])
end
if count >= tonumber(ARGV[1]) then return {'limited', ''} end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[3])
return {'reserved', ARGV[3]}
`;

export const FINISH_OUTREACH_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
`;

// Only used before a dispatch marker/network call. Never release on ambiguity.
export const RELEASE_OUTREACH_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2])
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

export interface OutreachLease { dayKey: string; messageKey: string; leadKey: string; value: string; attemptId: string }
export type Reservation = { state: 'reserved'; lease: OutreachLease }
  | { state: 'limited' | 'unavailable' | 'uncertain' | 'busy' }
  | { state: 'sent'; messageId?: string };
export interface OutreachLedger {
  reserve(params: { siteId: string; activity: OutreachActivityKey; day: string; messageId: string; leadId: string; limit: number; baseline: number }): Promise<Reservation>;
  sent(lease: OutreachLease, messageId?: string): Promise<void>;
  release(lease: OutreachLease): Promise<void>;
}

type Eval = (script: string, keys: string[], args: string[]) => Promise<unknown>;
async function evaluate(script: string, keys: string[], args: string[]): Promise<unknown> {
  // Never silently use a process-local fallback or an unconfigured localhost.
  if (!process.env.REDIS_CACHE_URL?.trim() && !process.env.REDIS_URL?.trim()) throw new Error('Redis not configured');
  return getRedisClient().eval(script, keys.length, ...keys, ...args);
}

export function createOutreachLedger(evalCommand: Eval = evaluate): OutreachLedger {
  return {
    async reserve(params) {
      const prefix = `outreach:{${params.siteId}}`;
      const dayKey = `${prefix}:${params.activity}:${params.day}`;
      // Message identity intentionally excludes activity and date.
      const messageKey = `${prefix}:message:${params.messageId}`;
      const leadKey = `${prefix}:lead:${params.leadId}`;
      const attemptId = randomUUID();
      const value = JSON.stringify({ state: 'dispatching', attemptId });
      try {
        const result = await evalCommand(RESERVE_OUTREACH_LUA, [dayKey, messageKey, leadKey], [String(params.limit), String(3 * 86400), value, String(params.baseline)]) as string[];
        if (result?.[0] === 'reserved') return { state: 'reserved', lease: { dayKey, messageKey, leadKey, value, attemptId } };
        if (result?.[0] === 'busy') return { state: 'busy' };
        if (result?.[0] === 'limited') return { state: 'limited' };
        if (result?.[0] === 'existing') {
          const existing = JSON.parse(result[1]);
          return existing.state === 'sent' ? { state: 'sent', messageId: existing.messageId } : { state: 'uncertain' };
        }
        return { state: 'unavailable' };
      } catch { return { state: 'unavailable' }; }
    },
    async sent(lease, messageId) {
      const result = await evalCommand(FINISH_OUTREACH_LUA, [lease.messageKey, lease.leadKey], [lease.value, JSON.stringify({ state: 'sent', messageId })]);
      if (Number(result) !== 1) throw new Error('Outreach lease ownership lost');
    },
    async release(lease) {
      await evalCommand(RELEASE_OUTREACH_LUA, [lease.dayKey, lease.messageKey, lease.leadKey], [lease.value]);
    },
  };
}