import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type AsyncMock = (...args: unknown[]) => Promise<unknown>;
const from = jest.fn();
const spawn = jest.fn<AsyncMock>();
const evaluate = jest.fn();
const count = jest.fn<AsyncMock>();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/services/robot-instance/assistant-respawn', () => ({
  LOOKBACK_MS: 1800000, countRecentRespawns: count, evaluateInstanceStall: evaluate, spawnSilentContinueWorkflow: spawn,
}));
let GET: typeof import('../route').GET;
beforeAll(async () => { ({ GET } = await import('../route')); });

const action = { id: 'user-log', site_id: 'site', user_id: 'user',
  details: { status: 'running', assistant_recovery: { version: 1 } } };
function query(result: unknown, list = false) {
  const q: Record<string, jest.Mock> = {};
  for (const method of ['select', 'eq', 'in', 'gte', 'order']) q[method] = jest.fn(() => q);
  q.limit = list ? jest.fn(async () => result) : jest.fn(() => q);
  q.maybeSingle = jest.fn(async () => result);
  return q;
}
function setup(customAction: unknown = action, metadata: unknown = null) {
  const latest = query({ data: customAction, error: null });
  from.mockReturnValueOnce(query({ data: [{ instance_id: 'instance' }], error: null }, true))
    .mockReturnValueOnce(query({ data: [{ log_type: 'tool_call', site_id: 'untrusted-tail-site', user_id: 'untrusted-tail-user' }], error: null }, true))
    .mockReturnValueOnce(latest)
    .mockReturnValueOnce(query({ data: metadata ? { metadata } : null, error: null }));
  return latest;
}
const request = () => new Request('https://example.test/cron', { headers: { authorization: 'Bearer test-secret' } });
beforeEach(() => {
  jest.resetAllMocks(); process.env.CRON_SECRET = 'test-secret';
  evaluate.mockReturnValue('respawn'); count.mockResolvedValue(0); spawn.mockResolvedValue(true);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('bound assistant recovery cron', () => {
  it('requires a configured secret before database access', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(new Request('https://example.test/cron', { headers: { authorization: 'Bearer undefined' } }))).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
  it('uses the newest trusted user action, never identities inferred from the tool log tail', async () => {
    const latest = setup();
    const response = await GET(request());
    expect(latest.eq).toHaveBeenCalledWith('trusted_user_action', true);
    expect(latest.eq).toHaveBeenCalledWith('log_type', 'user_action');
    expect(spawn).toHaveBeenCalledWith({ instanceId: 'instance', siteId: 'site', userId: 'user', userMessageLogId: 'user-log' });
    expect(await response.json()).toMatchObject({ results: [{ status: 'respawned' }] });
  });
  it.each(['stopped', 'cancelled', 'completed', 'failed', 'paused'])('does not resume a %s action', async (status) => {
    setup({ ...action, details: { ...action.details, status } });
    expect(await (await GET(request())).json()).toMatchObject({ results: [{ status: 'skipped_no_active_checkpoint' }] });
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([null, { ...action, details: { status: 'running' } }, { ...action, user_id: null }])(
    'does not guess context for legacy or missing actions: %j', async (row) => {
      setup(row); await GET(request()); expect(spawn).not.toHaveBeenCalled();
    },
  );
  it.each([{ workflow_run: true }, { requirement_id: 'requirement' }])('does not steal managed plan work: %j', async (metadata) => {
    setup(action, metadata);
    expect(await (await GET(request())).json()).toMatchObject({ results: [{ status: 'skipped_workflow_managed' }] });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('reports in-flight/changed/claimed checkpoints as skipped rather than retrying broadly', async () => {
    setup(); spawn.mockResolvedValue(false);
    expect(await (await GET(request())).json()).toMatchObject({ results: [{ status: 'skipped_unsafe_checkpoint' }] });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});