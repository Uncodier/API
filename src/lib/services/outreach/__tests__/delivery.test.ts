jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../transport', () => ({ prepareOutreachDelivery: jest.fn() }));
jest.mock('@/lib/utils/redis-client', () => ({ getRedisClient: jest.fn() }));
import { createOutreachDelivery, type OutreachRepository, type Snapshot } from '../delivery';
import { createOutreachLedger, RESERVE_OUTREACH_LUA, FINISH_OUTREACH_LUA, RELEASE_OUTREACH_LUA } from '../redis-ledger';
import { getOutreachPolicy, localDay, nextLocalDay, selectedOutreachAccounts } from '../policy';
import type { DeliveryContext } from '../transport';

const cold = 'leads_initial_cold_outreach';
const follow = 'leads_follow_up';
const now = new Date('2026-09-29T12:00:00Z'); // Tuesday
const settings = () => ({ business_hours: [{ timezone: 'America/Mexico_City' }],
  channels: { connections: [
    { id: 'zavu-hi', type: 'email', status: 'connected', zavu_sender_id: 'hi-sender', metadata: { from_address: 'hi@example.com' } },
    { id: 'zavu-other', type: 'email', status: 'connected', zavu_sender_id: 'other-sender' },
    { id: 'zavu-wa', type: 'whatsapp', status: 'connected', zavu_sender_id: 'wa-sender' },
  ], email: { status: 'active', email: 'smtp@example.com' } },
  activities: {
    [cold]: { status: 'active', all_segments: false, segment_ids: ['segment'], channel_accounts: { email: ['zavu-hi'], whatsapp: ['zavu-wa'] }, daily_message_limit: 3 },
    [follow]: { status: 'active', all_segments: true, channel_accounts: { email: ['zavu-hi'], whatsapp: [] }, weekdays: [2, 3, 4] },
  },
});

/** One synchronous eval invocation models Redis command serialization, not a
 * read-modify-write JS limiter. Validate script/key contract separately below. */
function memoryRedis() {
  const values = new Map<string, string>();
  const evalCommand = jest.fn(async (script: string, keys: string[], args: string[]) => {
    if (script === RESERVE_OUTREACH_LUA) {
      if (values.has(keys[1])) return ['existing', values.get(keys[1])!];
      if (values.has(keys[2])) return ['busy', ''];
      const count = Math.max(Number(values.get(keys[0]) || 0), Number(args[3]));
      if (count >= Number(args[0])) return ['limited', ''];
      values.set(keys[0], String(count + 1)); values.set(keys[1], args[2]); values.set(keys[2], args[2]);
      return ['reserved', args[2]];
    }
    if (script === FINISH_OUTREACH_LUA) {
      if (values.get(keys[0]) !== args[0]) return 0;
      values.set(keys[0], args[1]);
      if (values.get(keys[1]) === args[0]) values.delete(keys[1]);
      return 1;
    }
    if (script === RELEASE_OUTREACH_LUA) {
      if (values.get(keys[1]) !== args[0]) return 0;
      values.delete(keys[1]);
      if (values.get(keys[2]) === args[0]) values.delete(keys[2]);
      values.set(keys[0], String(Math.max(0, Number(values.get(keys[0]) || 0) - 1)));
      return 1;
    }
    throw new Error('Unexpected script');
  });
  return { values, evalCommand, ledger: createOutreachLedger(evalCommand) };
}

function fixture(total = 1, sameLead = false) {
  const config = settings();
  const rows = new Map<string, Snapshot>();
  for (let n = 0; n < total; n++) {
    rows.set(`m${n}`, { settings: config, message: { id: `m${n}`, role: 'assistant', conversation_id: `c${n}`, content: 'Hello',
      created_at: '2026-09-28T12:00:00Z', custom_data: { status: 'sending', outreach_activity: cold, channel: n % 2 ? 'whatsapp' : 'email' } },
    conversation: { id: `c${n}`, site_id: 'site', lead_id: sameLead ? 'l0' : `l${n}` },
    lead: { id: sameLead ? 'l0' : `l${n}`, site_id: 'site', email: 'lead@example.com', phone: '+15555555555', segment_id: 'segment', status: 'new' } });
  }
  const extras: any[] = [];
  const repo: OutreachRepository = {
    segmentBelongsToSite: jest.fn(async () => true),
    load: jest.fn(async (site, id) => site === 'site' && rows.has(id) ? structuredClone(rows.get(id)!) : null),
    history: jest.fn(async (_site, leadId) => [...Array.from(rows.values()).filter(r => r.lead.id === leadId).map(r => r.message), ...extras]),
    claim: jest.fn(async (message, marker) => {
      const row = rows.get(message.id)!;
      if (JSON.stringify(row.message.custom_data) !== JSON.stringify(message.custom_data)) return false;
      row.message.custom_data = { ...row.message.custom_data, outreach_delivery: marker }; return true;
    }),
    mark: jest.fn(async (message, marker) => { rows.get(message.id)!.message.custom_data.outreach_delivery = marker; }),
    reservedCount: jest.fn(async (_site, activity, day) => Array.from(rows.values()).filter(r => {
      const m = r.message.custom_data.outreach_delivery;
      return m?.activity === activity && m?.local_day === day;
    }).length),
  };
  const redis = memoryRedis();
  const send = jest.fn(async () => ({ success: true, messageId: `provider-${Math.random()}` }));
  const prepare = jest.fn(async (_ctx: DeliveryContext) => ({ send }));
  const deliver = createOutreachDelivery({ repository: repo, ledger: redis.ledger, prepare, now: () => now });
  return { config, rows, extras, repo, redis, send, prepare, deliver };
}

describe('central outreach delivery', () => {
  test.each([cold, follow])('blocks %s before custom start without reserving or sending', async activity => {
    const f = fixture();
    f.rows.get('m0')!.message.custom_data.outreach_activity = activity;
    Object.assign(f.config.activities[activity as typeof cold | typeof follow], { start_time_mode: 'custom', start_time: '10:30' });
    expect(await f.deliver('site', 'm0')).toMatchObject({ deferred: true, reason: 'before_start_time' });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.repo.claim).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  test('re-reads an opening reset during transport preparation before reserving', async () => {
    const f = fixture();
    Object.assign(f.config.activities[cold], { start_time_mode: 'custom', start_time: '06:00' });
    f.prepare.mockImplementation(async () => {
      Object.assign(f.config.activities[cold], { start_time_mode: 'business_opening' });
      Object.assign(f.config.business_hours[0], { days: { tuesday: { start: '10:30' } } });
      return { send: f.send };
    });
    expect(await f.deliver('site', 'm0')).toMatchObject({ deferred: true, reason: 'before_start_time' });
    expect(f.repo.claim).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  test('opening mode ignores an invalid stale override at actual delivery', async () => {
    const f = fixture();
    Object.assign(f.config.activities[cold], { start_time_mode: 'business_opening', start_time: 'invalid' });
    Object.assign(f.config.business_hours[0], { days: { tuesday: { start: '06:00' } } });
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: true });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  test('SMS, Telegram and voice workers share one atomic daily cap', async () => {
    const f = fixture(12); const channels = ['sms', 'telegram', 'voice'];
    for (const channel of channels) {
      (f.config.activities[cold].channel_accounts as Record<string, string[]>)[channel] = [channel];
      f.config.channels.connections.push({ id: channel, type: channel, status: 'connected', zavu_sender_id: `sender-${channel}` });
    }
    Array.from(f.rows.values()).forEach((row, index) => {
      const channel = channels[index % channels.length]; row.message.custom_data.channel = channel;
      row.lead.social_networks = { telegram: 'known-chat' };
      row.lead.voice_call_consent_status = 'granted'; row.lead.voice_call_consent_at = now.toISOString();
    });
    const results = await Promise.all(Array.from(f.rows.keys()).map(id => f.deliver('site', id)));
    expect(results.filter(r => r.success)).toHaveLength(3);
    expect(results.filter(r => r.reason === 'daily_limit')).toHaveLength(9);
    expect(f.send).toHaveBeenCalledTimes(3);
  });
  test.each(['sms', 'telegram', 'voice'])('%s uses central budget and retry identity, not another account/channel', async channel => {
    const f = fixture();
    const row = f.rows.get('m0')!;
    row.message.custom_data.channel = channel;
    row.conversation.channel = channel;
    row.lead.social_networks = { [channel]: 'chat-1' };
    row.lead.voice_call_consent_status = 'granted'; row.lead.voice_call_consent_at = now.toISOString();
    (f.config.activities[cold].channel_accounts as Record<string, string[]>)[channel] = ['selected-generic'];
    f.config.channels.connections.push({ id: 'selected-generic', type: channel, status: 'connected', zavu_sender_id: 'generic-sender' });
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: true, channel, recipient: channel === 'telegram' ? 'chat-1' : row.lead.phone });
    expect(f.prepare.mock.calls[0][0].account.id).toBe('selected-generic');
    expect(row.message.custom_data.outreach_delivery).toMatchObject({ state: 'sent', channel });
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: true, alreadySent: true });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  test.each(['telegram', 'voice'])('inaccessible %s defers before reservation without email fallback', async channel => {
    const f = fixture(); const row = f.rows.get('m0')!;
    row.message.custom_data.channel = channel;
    (f.config.activities[cold].channel_accounts as Record<string, string[]>)[channel] = ['selected-generic'];
    f.config.channels.connections.push({ id: 'selected-generic', type: channel, status: 'connected', zavu_sender_id: 'generic-sender' });
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: false, deferred: true });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.repo.claim).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  test('uses only selected hi Zavu account and idempotently recognizes sent after deactivation', async () => {
    const f = fixture();
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: true });
    expect(f.prepare.mock.calls[0][0].account).toMatchObject({ id: 'zavu-hi', provider: 'zavu' });
    f.config.activities[cold].status = 'inactive';
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: true, alreadySent: true });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  test('atomic daily cap shared across mixed email and WhatsApp workers', async () => {
    const f = fixture(12);
    const results = await Promise.all(Array.from(f.rows.keys()).map(id => f.deliver('site', id)));
    expect(results.filter(r => r.success)).toHaveLength(3);
    expect(results.filter(r => r.reason === 'daily_limit')).toHaveLength(9);
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.prepare.mock.calls.some(call => call[0].account.channel === 'whatsapp')).toBe(true);
  });
  test('same message concurrency cannot dispatch twice', async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 10 }, () => f.deliver('site', 'm0')));
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  test('ambiguous failure is quarantined on retries, even after Redis reset', async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error('timeout after provider accepted'));
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: false, deferred: true, reason: 'delivery_uncertain' });
    f.redis.values.clear();
    expect(await f.deliver('site', 'm0')).toMatchObject({ reason: 'delivery_uncertain' });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  test('Redis unavailable fails closed before durable claim or sending', async () => {
    const f = fixture();
    f.redis.evalCommand.mockRejectedValue(new Error('offline'));
    expect(await f.deliver('site', 'm0')).toMatchObject({ deferred: true, reason: 'limiter_unavailable' });
    expect(f.repo.claim).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  test('Redis restart restores baseline from durable dispatch/sent markers', async () => {
    const f = fixture(5);
    for (const id of ['m0', 'm1', 'm2']) expect((await f.deliver('site', id)).success).toBe(true);
    f.redis.values.clear();
    expect(await f.deliver('site', 'm3')).toMatchObject({ deferred: true, reason: 'daily_limit' });
    expect(f.send).toHaveBeenCalledTimes(3);
  });
  test.each(['inactive', 'segments', 'empty', 'disconnected', 'invalid-limit', 'invalid-timezone', 'quarantined'])(
    'blocks %s without provider fallback', async variant => {
      const f = fixture();
      if (variant === 'inactive') f.config.activities[cold].status = 'inactive';
      if (variant === 'segments') f.config.activities[cold].segment_ids = [];
      if (variant === 'empty') f.config.activities[cold].channel_accounts.email = [];
      if (variant === 'disconnected') f.config.channels.connections[0].status = 'disconnected';
      if (variant === 'invalid-limit') f.config.activities[cold].daily_message_limit = 0;
      if (variant === 'invalid-timezone') f.config.business_hours[0].timezone = 'not/a-zone';
      if (variant === 'quarantined') f.rows.get('m0')!.lead.metadata = { quarantined_cross_tenant: true };
      expect(await f.deliver('site', 'm0')).toMatchObject({ success: false, deferred: true });
      expect(f.send).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    });
  test('tenant mismatch is not found and never dispatched', async () => {
    const f = fixture(); expect(await f.deliver('other-site', 'm0')).toEqual({ success: false, reason: 'message_not_found' });
    expect(f.send).not.toHaveBeenCalled();
  });
  test('selected segment must belong to same site', async () => {
    const f = fixture();
    (f.repo.segmentBelongsToSite as jest.Mock).mockResolvedValue(false);
    expect(await f.deliver('site', 'm0')).toMatchObject({ deferred: true, reason: 'segment_not_selected' });
    expect(f.send).not.toHaveBeenCalled();
  });
  test('won leads are not outreach eligible', async () => {
    const f = fixture(); f.rows.get('m0')!.lead.status = 'won';
    expect(await f.deliver('site', 'm0')).toMatchObject({ deferred: true, reason: 'lead_ineligible' });
    expect(f.send).not.toHaveBeenCalled();
  });
  test('followup checks JS weekday in local timezone (Monday in Honolulu)', async () => {
    const f = fixture();
    f.config.business_hours[0].timezone = 'Pacific/Honolulu';
    f.rows.get('m0')!.message.custom_data.outreach_activity = follow;
    const deliver = createOutreachDelivery({ repository: f.repo, ledger: f.redis.ledger, prepare: f.prepare, now: () => new Date('2026-09-29T01:00:00Z') });
    expect(await deliver('site', 'm0')).toMatchObject({ reason: 'outside_weekdays', deferred: true });
    expect(f.send).not.toHaveBeenCalled();
  });
  test('cold/followup audiences are exclusive and internal user records do not qualify', async () => {
    const f = fixture();
    f.rows.get('m0')!.message.custom_data.outreach_activity = follow;
    f.extras.push({ id: 'inbound', role: 'user', created_at: '2026-09-20T12:00:00Z', custom_data: { internal: true } });
    expect(await f.deliver('site', 'm0')).toMatchObject({ reason: 'audience_mismatch' });
    f.extras[0].custom_data = {};
    expect(await f.deliver('site', 'm0')).toMatchObject({ success: true });
  });
  test('unanswered cap counts only confirmed sends, dedupes providers across channels', async () => {
    const f = fixture();
    for (let n = 0; n < 3; n++) f.extras.push({ id: `sent${n}`, role: 'assistant', created_at: '2026-09-28T10:00:00Z', custom_data: { status: 'sent', external_message_id: `e${n}` } });
    f.extras.push({ ...f.extras[0], id: 'duplicate-tracking' });
    expect(await f.deliver('site', 'm0')).toMatchObject({ reason: 'unanswered_limit', deferred: true });
    expect(f.send).not.toHaveBeenCalled();
  });
  test('serializes simultaneous queued messages to same lead across channels', async () => {
    const f = fixture(2, true);
    await Promise.all([f.deliver('site', 'm0'), f.deliver('site', 'm1')]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});

test('defaults and timezone boundaries respect DST and configured subsets', () => {
  const cfg = settings();
  expect(getOutreachPolicy(cfg, follow)).toMatchObject({ daily_message_limit: 30, max_unanswered_messages: 3, weekdays: [2, 3, 4] });
  expect(localDay(new Date('2026-09-29T01:00:00Z'), 'America/Mexico_City')).toEqual({ day: '2026-09-28', weekday: 1 });
  expect(nextLocalDay(new Date('2026-03-08T05:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  cfg.channels.connections[0].metadata = { emailChannelActive: false } as any;
  expect(selectedOutreachAccounts(cfg, getOutreachPolicy(cfg, cold)!, 'email')).toEqual([]);
});

test('Lua transaction holds message+lead identity, counter and no-expiry uncertainty in one invocation', () => {
  expect(RESERVE_OUTREACH_LUA).toContain("redis.call('INCR', KEYS[1])");
  expect(RESERVE_OUTREACH_LUA).toContain("redis.call('SET', KEYS[2], ARGV[3])");
  expect(RESERVE_OUTREACH_LUA).toContain("redis.call('SET', KEYS[3], ARGV[3])");
  expect(FINISH_OUTREACH_LUA).toContain("redis.call('GET', KEYS[1]) ~= ARGV[1]");
});