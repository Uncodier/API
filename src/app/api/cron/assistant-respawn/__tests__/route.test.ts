import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as policy from '@/lib/services/robot-instance/assistant-respawn-policy';

const from = jest.fn<(table: string) => ReturnType<typeof query>>();
const countRecentRespawns = jest.fn<typeof import('@/lib/services/robot-instance/assistant-respawn').countRecentRespawns>();
const spawnSilentContinueWorkflow = jest.fn<typeof import('@/lib/services/robot-instance/assistant-respawn').spawnSilentContinueWorkflow>();
// Exercise the real policy and ownership predicate, but never import DB/workflow implementations.
const evaluateInstanceStall = jest.fn(policy.evaluateInstanceStall);
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/services/robot-instance/assistant-respawn', () => ({
  ...policy, countRecentRespawns, evaluateInstanceStall, spawnSilentContinueWorkflow,
}));

let GET: typeof import('../route').GET;
beforeAll(async () => { ({ GET } = await import('../route')); });

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const INSTANCE_ID = 'instance-1';
const STALL_LOG_TYPES = ['user_action', 'agent_action', 'thinking', 'tool_call', 'infrastructure'];
const originalSecret = process.env.CRON_SECRET;
let secret: string;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
type QueryResult = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): QueryResult => ({ data, error: null });

function query(result: QueryResult, single = false) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: single ? jest.fn().mockReturnThis() : jest.fn(async () => result),
    maybeSingle: jest.fn(async () => result),
  };
}

function enqueue(table: string, result: QueryResult, single = false) {
  const builder = query(result, single);
  from.mockImplementationOnce((actualTable) => {
    expect(actualTable).toBe(table);
    return builder;
  });
  return builder;
}

function candidates({
  recent = ok([{ instance_id: INSTANCE_ID }]), stranded = ok([]),
}: { recent?: QueryResult; stranded?: QueryResult } = {}) {
  return {
    recent: enqueue('instance_logs', recent),
    stranded: enqueue('instance_logs', stranded),
  };
}

function activeAction({
  status = 'running', inFlight = true, lastActivityAt = ago(16 * MINUTE),
}: { status?: string; inFlight?: boolean; lastActivityAt?: string } = {}) {
  return {
    id: 'trusted-user-log', site_id: 'trusted-site', user_id: 'trusted-user',
    created_at: ago(2 * 60 * MINUTE),
    details: { status, assistant_recovery: { version: 1, inFlight, lastActivityAt } },
  };
}

function toolLog(age = 16 * MINUTE) {
  return {
    log_type: 'tool_call', message: 'Tool execution started', created_at: ago(age),
    // Tail identities must never supply the scope used to authorize recovery.
    site_id: 'untrusted-tail-site', user_id: 'untrusted-tail-user', details: {},
  };
}

function checkpoint(action: unknown = activeAction(), logs = [toolLog()]) {
  return {
    logs: enqueue('instance_logs', ok(logs)),
    action: enqueue('instance_logs', ok(action), true),
  };
}

function request(authorization: string | null = `Bearer ${secret}`) {
  const url = new URL('https://example.invalid');
  url.pathname = '/api/cron/assistant-respawn';
  return new Request(url, { headers: authorization === null ? {} : { authorization } });
}

async function expectResult(response: Response, status: string, instanceId = INSTANCE_ID) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    message: 'Processed 1 active instances', results: [{ instance_id: instanceId, status }],
  });
}

function expectTrustedActionQuery(builder: ReturnType<typeof query>, instanceId = INSTANCE_ID) {
  expect(builder.eq.mock.calls).toEqual([
    ['instance_id', instanceId], ['log_type', 'user_action'], ['trusted_user_action', true],
  ]);
  // Select the latest action first, including stopped actions, rather than an older running one.
  expect(builder.order.mock.calls).toEqual([
    ['created_at', { ascending: false }], ['id', { ascending: false }],
  ]);
  expect(builder.limit).toHaveBeenCalledWith(1);
  expect(builder.maybeSingle).toHaveBeenCalledTimes(1);
}

function expectPlanQuery(builder: ReturnType<typeof query>) {
  expect(builder.select).toHaveBeenCalledWith('metadata');
  expect(builder.eq).toHaveBeenCalledWith('instance_id', INSTANCE_ID);
  expect(builder.in).toHaveBeenCalledWith('status', ['pending', 'in_progress', 'active', 'paused']);
  expect(builder.order).toHaveBeenCalledWith('updated_at', { ascending: false });
  expect(builder.limit).toHaveBeenCalledWith(1);
  expect(builder.maybeSingle).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  jest.resetAllMocks();
  secret = randomBytes(32).toString('hex');
  process.env.CRON_SECRET = secret;
  from.mockImplementation(() => { throw new Error('Unexpected database query'); });
  countRecentRespawns.mockResolvedValue(0);
  evaluateInstanceStall.mockImplementation(policy.evaluateInstanceStall);
  spawnSilentContinueWorkflow.mockResolvedValue(true);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // Do not let the route's catch block hide an unplanned query or wrong table.
    expect(from.mock.results.filter((result) => result.type === 'throw')).toEqual([]);
  } finally {
    jest.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

describe('assistant respawn cron route (offline)', () => {
  it.each([undefined, '', ' \t '])('requires a configured nonblank secret: %j', async (configured) => {
    if (configured === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = configured;
    // This also catches accidental acceptance of an interpolated missing env value.
    const response = await GET(request(`Bearer ${process.env.CRON_SECRET?.trim()}`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(from).not.toHaveBeenCalled();
    expect(countRecentRespawns).not.toHaveBeenCalled();
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it.each(['missing', 'mismatched'])('rejects %s authorization before database access', async (kind) => {
    const authorization = kind === 'missing' ? null : `Bearer ${randomBytes(32).toString('hex')}`;
    const response = await GET(request(authorization));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(from).not.toHaveBeenCalled();
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it('accepts the runtime-generated secret with surrounding environment whitespace', async () => {
    process.env.CRON_SECRET = ` \t${secret}\n `;
    candidates({ recent: ok([]) });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Processed 0 active instances', results: [] });
    expect(from).toHaveBeenCalledTimes(2);
    expect(countRecentRespawns).not.toHaveBeenCalled();
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it('merges and deduplicates recent logs with trusted running in-flight candidates from 24 hours', async () => {
    const queries = candidates({
      recent: ok([{ instance_id: INSTANCE_ID }, { instance_id: INSTANCE_ID }, { instance_id: null }]),
      stranded: ok([{ instance_id: INSTANCE_ID }, { instance_id: 'stranded-instance' }, { instance_id: '' }]),
    });
    checkpoint();
    enqueue('instance_plans', ok(null), true);
    const stranded = checkpoint(activeAction({ lastActivityAt: ago(2 * 60 * MINUTE) }), [toolLog(2 * 60 * MINUTE)]);
    enqueue('instance_plans', ok(null), true);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Processed 2 active instances',
      results: [
        { instance_id: INSTANCE_ID, status: 'respawned' },
        { instance_id: 'stranded-instance', status: 'respawned' },
      ],
    });
    expect(queries.recent.select).toHaveBeenCalledWith('instance_id');
    expect(queries.recent.in).toHaveBeenCalledWith('log_type', STALL_LOG_TYPES);
    expect(queries.recent.gte).toHaveBeenCalledWith('created_at', ago(30 * MINUTE));
    expect(queries.recent.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(queries.recent.limit).toHaveBeenCalledWith(2000);
    expect(queries.stranded.select).toHaveBeenCalledWith('instance_id');
    expect(queries.stranded.eq.mock.calls).toEqual([
      ['log_type', 'user_action'], ['trusted_user_action', true],
      ['details->>status', 'running'], ['details->assistant_recovery->>inFlight', 'true'],
    ]);
    expect(queries.stranded.gte).toHaveBeenCalledWith('created_at', ago(24 * 60 * MINUTE));
    expect(queries.stranded.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(queries.stranded.limit).toHaveBeenCalledWith(200);
    expect(stranded.logs.eq).toHaveBeenCalledWith('instance_id', 'stranded-instance');
    expect(stranded.logs.in).toHaveBeenCalledWith('log_type', STALL_LOG_TYPES);
    expect(stranded.logs.limit).toHaveBeenCalledWith(10);
    expect(stranded.logs.gte).not.toHaveBeenCalled();
    expectTrustedActionQuery(stranded.action, 'stranded-instance');
    expect(countRecentRespawns.mock.calls).toEqual([[INSTANCE_ID], ['stranded-instance']]);
    expect(spawnSilentContinueWorkflow).toHaveBeenCalledTimes(2);
    expect(spawnSilentContinueWorkflow).toHaveBeenNthCalledWith(2, {
      instanceId: 'stranded-instance', siteId: 'trusted-site', userId: 'trusted-user', userMessageLogId: 'trusted-user-log',
    }, { allowStaleInFlight: true });
    expect(from).toHaveBeenCalledTimes(8);
  });

  it('still recovers a stranded turn beyond LOOKBACK even when the recent-log query is empty', async () => {
    candidates({ recent: ok([]), stranded: ok([{ instance_id: INSTANCE_ID }]) });
    checkpoint(activeAction({ lastActivityAt: ago(2 * 60 * MINUTE) }), [toolLog(2 * 60 * MINUTE)]);
    enqueue('instance_plans', ok(null), true);

    await expectResult(await GET(request()), 'respawned');
    expect(evaluateInstanceStall.mock.results[0].value).toBe('respawn');
    expect(spawnSilentContinueWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each([15, 16])('allows stale in-flight recovery at %i minutes with the trusted action scope', async (minutes) => {
    candidates();
    const action = activeAction({ lastActivityAt: ago(minutes * MINUTE) });
    const logs = [toolLog(minutes * MINUTE)];
    const queries = checkpoint(action, logs);
    const plan = enqueue('instance_plans', ok(null), true);

    await expectResult(await GET(request()), 'respawned');
    expectTrustedActionQuery(queries.action);
    expectPlanQuery(plan);
    expect(countRecentRespawns).toHaveBeenCalledWith(INSTANCE_ID);
    expect(evaluateInstanceStall).toHaveBeenCalledWith({
      logs, nowMs: NOW, recentRespawnCount: 0, inFlight: true,
      lastActivityAt: action.details.assistant_recovery.lastActivityAt,
    });
    expect(evaluateInstanceStall.mock.results[0].value).toBe('respawn');
    expect(spawnSilentContinueWorkflow).toHaveBeenCalledTimes(1);
    expect(spawnSilentContinueWorkflow).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID, siteId: action.site_id, userId: action.user_id, userMessageLogId: action.id,
    }, { allowStaleInFlight: true });
  });

  it.each([
    { name: 'checkpoint heartbeat', logAge: 20 * MINUTE, activityAge: 15 * MINUTE - 1 },
    { name: 'latest tool log', logAge: 15 * MINUTE - 1, activityAge: 20 * MINUTE },
    { name: 'in-flight turn older than the ordinary three-minute threshold', logAge: 14 * MINUTE, activityAge: 14 * MINUTE },
  ])('does not spawn when the $name is fresh under the real in-flight policy', async ({ logAge, activityAge }) => {
    candidates();
    checkpoint(activeAction({ lastActivityAt: ago(activityAge) }), [toolLog(logAge)]);

    await expectResult(await GET(request()), 'healthy_or_fresh');
    expect(evaluateInstanceStall).toHaveBeenCalledTimes(1);
    expect(evaluateInstanceStall.mock.results[0].value).toBe('healthy_or_fresh');
    expect(from).toHaveBeenCalledTimes(4); // No plan lookup or workflow admission.
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it('does not spawn for a 16-minute-old log with a fresh streaming heartbeat', async () => {
    candidates();
    const action = activeAction({ lastActivityAt: ago(16 * MINUTE) });
    const logs = [{ ...toolLog(16 * MINUTE), details: { last_activity_at: ago(MINUTE) } }];
    checkpoint(action, logs);

    await expectResult(await GET(request()), 'healthy_or_fresh');
    expect(evaluateInstanceStall).toHaveBeenCalledTimes(1);
    expect(evaluateInstanceStall).toHaveBeenCalledWith({
      logs, nowMs: NOW, recentRespawnCount: 0, inFlight: true,
      lastActivityAt: action.details.assistant_recovery.lastActivityAt,
    });
    expect(evaluateInstanceStall.mock.results[0].value).toBe('healthy_or_fresh');
    expect(from).toHaveBeenCalledTimes(4); // The heartbeat prevents even a plan lookup.
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled', 'stopped', 'failed', 'paused'])('skips the latest %s action despite a stale tool tail', async (status) => {
    candidates({ stranded: ok([{ instance_id: INSTANCE_ID }]) });
    const queries = checkpoint(activeAction({ status }));

    await expectResult(await GET(request()), 'skipped_no_active_checkpoint');
    expectTrustedActionQuery(queries.action);
    expect(countRecentRespawns).not.toHaveBeenCalled();
    expect(evaluateInstanceStall).not.toHaveBeenCalled();
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: 'workflow runner', metadata: { workflow_run: true } },
    { name: 'workflow template', metadata: { workflow_template: true } },
    { name: 'requirement', metadata: { requirement_id: 'requirement-1' } },
  ])('does not take over a plan managed by a $name', async ({ metadata }) => {
    candidates();
    checkpoint();
    const plan = enqueue('instance_plans', ok({ metadata }), true);

    await expectResult(await GET(request()), 'skipped_workflow_managed');
    expectPlanQuery(plan);
    expect(evaluateInstanceStall.mock.results[0].value).toBe('respawn');
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it('skips recovery when plan ownership cannot be read', async () => {
    candidates();
    checkpoint();
    const plan = enqueue('instance_plans', { data: null, error: { message: 'Plan lookup unavailable' } }, true);

    await expectResult(await GET(request()), 'skipped_plan_lookup_error');
    expectPlanQuery(plan);
    expect(evaluateInstanceStall.mock.results[0].value).toBe('respawn');
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it.each(['recent', 'stranded'] as const)('fails closed when the %s candidate query fails, even with candidates returned', async (source) => {
    const error = { message: `${source} candidate lookup unavailable` };
    candidates({
      recent: ok([{ instance_id: INSTANCE_ID }]),
      stranded: ok([{ instance_id: 'stranded-instance' }]),
      [source]: { data: [{ instance_id: INSTANCE_ID }], error },
    });

    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: error.message });
    expect(from).toHaveBeenCalledTimes(2);
    expect(countRecentRespawns).not.toHaveBeenCalled();
    expect(evaluateInstanceStall).not.toHaveBeenCalled();
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it('skips recovery when the latest trusted action lookup fails', async () => {
    candidates();
    enqueue('instance_logs', ok([toolLog()]));
    enqueue('instance_logs', { data: activeAction(), error: { message: 'Action lookup unavailable' } }, true);

    await expectResult(await GET(request()), 'skipped_no_active_checkpoint');
    expect(countRecentRespawns).not.toHaveBeenCalled();
    expect(evaluateInstanceStall).not.toHaveBeenCalled();
    expect(spawnSilentContinueWorkflow).not.toHaveBeenCalled();
  });

  it('reports a false/ambiguous claim as unsafe without retrying or claiming success', async () => {
    candidates();
    checkpoint();
    enqueue('instance_plans', ok(null), true);
    spawnSilentContinueWorkflow.mockResolvedValue(false);

    await expectResult(await GET(request()), 'skipped_unsafe_checkpoint');
    expect(spawnSilentContinueWorkflow).toHaveBeenCalledTimes(1);
    expect(spawnSilentContinueWorkflow).toHaveBeenCalledWith({
      instanceId: INSTANCE_ID, siteId: 'trusted-site', userId: 'trusted-user', userMessageLogId: 'trusted-user-log',
    }, { allowStaleInFlight: true });
    expect(countRecentRespawns).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(5);
  });
});
