import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { GET } from '../route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { materializeRunFromGraph } from '@/lib/services/workflow-robot/materialize';
import { isCronDueInWindow } from '@/lib/services/workflow-robot/cron-window';
import { recordTelemetry } from '@/lib/status/telemetry';
import { start } from 'workflow/api';
import { executeScheduledWorkflow } from '../workflow';
import { executeScheduledConnectorWorkflow } from '../connector-workflow';

jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn(async () => {}) }));
jest.mock('../connector-workflow', () => ({ executeScheduledConnectorWorkflow: jest.fn() }));
jest.mock('workflow/api', () => ({ start: jest.fn() }));
jest.mock('../workflow', () => ({ executeScheduledWorkflow: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/workflow-robot/materialize', () => ({ materializeRunFromGraph: jest.fn() }));
jest.mock('@/lib/services/workflow-robot/cron-window', () => ({ WORKFLOW_CRON_WINDOW_MS: 120000, isCronDueInWindow: jest.fn() }));
jest.mock('@/lib/timezone', () => ({ normalizeTimezone: () => 'UTC', resolveClientTimezone: async () => 'UTC' }));

const secret = randomBytes(32).toString('hex');
const originalFlag = process.env.WORKFLOW_CONNECTOR_READS_ENABLED;
const originalSecret = process.env.CRON_SECRET;
const request = (token = secret, signal?: AbortSignal) => new Request('https://api.example.test/cron/workflows', {
  headers: { authorization: `Bearer ${token}` }, signal,
});
const trigger = () => ({ id: randomUUID(), instance_id: randomUUID(), config: { cron: '* * * * *', timezone: 'UTC' }, site_id: randomUUID() });
const privateValue = randomBytes(32).toString('hex');
const lease = () => ({ run_id: randomUUID(), job_id: randomUUID(), lease_id: randomUUID() });
const ok = (data: unknown) => ({ data, error: null });
const err = (code: string) => ({ data: null, error: { code, message: privateValue } });
function mockRpc(fn: (name: string, args: Record<string, any>) => unknown) {
  jest.mocked(supabaseAdmin.rpc).mockImplementation((name, args) => ({ abortSignal: async () => fn(name, args ?? {}) }) as never);
}
let rows: ReturnType<typeof trigger>[];
let scanFailure = false;
function mockScan() {
  jest.mocked(supabaseAdmin.from).mockImplementation(() => {
    let data = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    let pageSize = 0;
    const query = {
      select: () => query, eq: () => query, order: () => query,
      limit: (n: number) => { pageSize = n; return query; },
      gte: (_: string, id: string) => { data = data.filter(r => r.id >= id); return query; },
      gt: (_: string, id: string) => { data = data.filter(r => r.id > id); return query; },
      lt: (_: string, id: string) => { data = data.filter(r => r.id < id); return query; },
      abortSignal: async () => scanFailure ? err('unavailable') : ok(data.slice(0, pageSize)),
    };
    return query as never;
  });
}

beforeEach(() => {
  jest.resetAllMocks(); rows = [trigger()]; scanFailure = false;
  process.env.CRON_SECRET = secret; process.env.WORKFLOW_CONNECTOR_READS_ENABLED = 'true';
  jest.mocked(start).mockResolvedValue({ runId: 'offline-workflow-run' } as never);
  jest.mocked(isCronDueInWindow).mockReturnValue({ due: true, windowKey: '2026-09-16T15:00' });
  mockScan(); mockRpc(name => name === 'workflow_connector_route' ? ok(false) : ok([]));
});
afterAll(() => {
  if (originalFlag === undefined) delete process.env.WORKFLOW_CONNECTOR_READS_ENABLED; else process.env.WORKFLOW_CONNECTOR_READS_ENABLED = originalFlag;
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
});

describe('cron admission', () => {
  it('authenticates before scanning or leasing, even if the secret is missing', async () => {
    expect((await GET(request('invalid'))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request('undefined'))).status).toBe(401);
    expect(supabaseAdmin.from).not.toHaveBeenCalled(); expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  it('visits 137 triggers once with bounded concurrency, including those beyond the first page', async () => {
    rows = Array.from({ length: 137 }, trigger);
    const seen: string[] = []; let active = 0, peak = 0;
    mockRpc(async (name, params) => {
      if (name === 'workflow_connector_claim_queue') return ok([]);
      if (name === 'workflow_connector_route') return ok(true);
      if (name !== 'workflow_connector_bind') throw new Error();
      seen.push(params.p_trigger); peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return ok({ privateValue });
    });
    const body = await (await GET(request())).json();
    expect(seen.sort()).toEqual(rows.map(r => r.id).sort());
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
    expect(body.scan).toMatchObject({ complete: true, counts: { reserved: 137, started: 0 } });
    expect(JSON.stringify(body)).not.toContain(privateValue); expect(JSON.stringify(body)).not.toContain(seen[0]);
    expect(start).not.toHaveBeenCalled(); expect(materializeRunFromGraph).not.toHaveBeenCalled();
  });

  it.each([['duplicate', '23505'], ['blocked', '42501'], ['failed', 'XX000']])('treats bind outcome %s without ever falling back', async (outcome, code) => {
    mockRpc(name => name === 'workflow_connector_bind' ? err(code) : ok(name === 'workflow_connector_route' ? true : []));
    expect((await (await GET(request())).json()).scan.counts[outcome]).toBe(1);
    expect(start).not.toHaveBeenCalled(); expect(materializeRunFromGraph).not.toHaveBeenCalled();
  });

  it('blocks on unknown classification; flag off does not bind, claim or dispatch', async () => {
    mockRpc(() => ok(null)); await GET(request());
    expect(materializeRunFromGraph).not.toHaveBeenCalled();
    jest.mocked(supabaseAdmin.rpc).mockClear();
    delete process.env.WORKFLOW_CONNECTOR_READS_ENABLED;
    mockRpc(() => ok(true));
    expect((await (await GET(request())).json()).scan.counts.connector_disabled).toBe(1);
    expect(jest.mocked(supabaseAdmin.rpc).mock.calls.map(c => c[0])).toEqual(['workflow_connector_route']);
    expect(start).not.toHaveBeenCalled(); expect(materializeRunFromGraph).not.toHaveBeenCalled();
  });
});

describe('independent outbox', () => {
  it('reserves before queue, never starts before claim, and acknowledges only after acceptance', async () => {
    const events: string[] = [];
    let job: ReturnType<typeof lease> | undefined;
    mockRpc((name, p) => {
      if (name === 'workflow_connector_route') return ok(true);
      if (name === 'workflow_connector_bind') {
        expect(p).toEqual({ p_instance: rows[0].instance_id, p_trigger: rows[0].id, p_occurrence: '2026-09-16T15:00:00Z',
          p_run: expect.any(String), p_job: expect.any(String) });
        job = { run_id: p.p_run, job_id: p.p_job, lease_id: randomUUID() }; events.push('bind');
        return ok({ privateValue });
      }
      if (name === 'workflow_connector_claim_queue') { if (job) events.push('claim'); return ok(job ? [job] : []); }
      if (name === 'workflow_connector_ack_queue') {
        expect(p).toEqual({ p_run: job!.run_id, p_job: job!.job_id, p_lease: job!.lease_id }); events.push('ack'); return ok(true);
      }
      throw new Error();
    });
    let release!: () => void;
    jest.mocked(start).mockImplementationOnce(() => new Promise<any>(resolve => { events.push('start'); release = () => resolve({}); }));
    const pending = GET(request());
    for (let i = 0; i < 30 && !release; i++) await new Promise(r => setTimeout(r, 1));
    expect(events).toEqual(['bind', 'claim', 'start']); release();
    const body = await (await pending).json();
    expect(events).toEqual(['bind', 'claim', 'start', 'ack']);
    expect(start).toHaveBeenCalledWith(executeScheduledConnectorWorkflow, [{ run_id: job!.run_id, job_id: job!.job_id }]);
    expect(body).toMatchObject({ queue: { acknowledged: 1, failed: 0 }, scan: { counts: { reserved: 1, started: 0 } } });
    for (const v of [...Object.values(job!), privateValue]) expect(JSON.stringify(body)).not.toContain(v);
  });

  it('continues after ambiguous queue acceptance and recovers only through a new lease on a later tick with scan failure', async () => {
    scanFailure = true;
    const a = lease(), b = lease(); let claimResult = [a,b];
    mockRpc(name => name === 'workflow_connector_claim_queue' ? ok(claimResult.splice(0)) : ok(true));
    jest.mocked(start).mockRejectedValueOnce(new Error(privateValue));
    const first = await GET(request()); expect(first.status).toBe(503);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ scan: { complete: false }, queue: { failed: 1, acknowledged: 1 } });
    expect(JSON.stringify(firstBody)).not.toContain(privateValue);
    const ackArgs = () => jest.mocked(supabaseAdmin.rpc).mock.calls.filter(c => c[0] === 'workflow_connector_ack_queue').map(c => c[1]);
    expect(ackArgs()).toEqual([{ p_run: b.run_id, p_job: b.job_id, p_lease: b.lease_id }]);
    await GET(request()); expect(start).toHaveBeenCalledTimes(2); // DB has not leased it again.
    const renewed = { ...a, lease_id: randomUUID() }; claimResult = [renewed];
    expect((await (await GET(request())).json()).queue).toEqual({ failed: 0, acknowledged: 1 });
    expect(start).toHaveBeenCalledTimes(3); expect(ackArgs()[1]).toEqual({ p_run: a.run_id, p_job: a.job_id, p_lease: renewed.lease_id });
    expect(JSON.stringify(jest.mocked(recordTelemetry).mock.calls)).not.toContain(privateValue);
    expect(materializeRunFromGraph).not.toHaveBeenCalled();
  });

  it('does not claim indefinitely or report failed acknowledgments as accepted', async () => {
    rows = [];
    mockRpc((name, args) => name === 'workflow_connector_claim_queue' ? ok(Array.from({ length: args.p_limit }, lease)) : ok(false));
    expect((await (await GET(request())).json()).queue).toEqual({ failed: 64, acknowledged: 0 });
    expect(start).toHaveBeenCalledTimes(64);
  });

  it('leaves ambiguous in-flight starts unacknowledged on cancellation', async () => {
    rows = []; const controller = new AbortController();
    mockRpc(() => ok([lease()]));
    jest.mocked(start).mockImplementationOnce(() => { controller.abort(); return new Promise<never>(() => {}); });
    const body = await (await GET(request(secret, controller.signal))).json();
    expect(body.queue).toEqual({ failed: 1, acknowledged: 0 });
    expect(jest.mocked(supabaseAdmin.rpc).mock.calls.map(c => c[0])).toEqual(['workflow_connector_claim_queue']);
  });
});

describe('ordinary scheduled runs', () => {
  it.each([
    ['new', [{}], false, true], ['recoverable', [], true, true], ['duplicate', [], false, false],
  ] as const)('preserves %s dispatch behavior', async (_, steps, resume, shouldStart) => {
    delete process.env.WORKFLOW_CONNECTOR_READS_ENABLED;
    jest.mocked(materializeRunFromGraph).mockResolvedValue({ run_plan_id: 'plan', steps, resume_existing_run: resume } as never);
    const body = await (await GET(request())).json();
    expect(body.scan.counts.started).toEqual(Number(shouldStart));
    if (shouldStart) expect(start).toHaveBeenCalledWith(executeScheduledWorkflow, ['plan']); else expect(start).not.toHaveBeenCalled();
  });

  it('does not assert an ordinary start before durable queue acceptance', async () => {
    jest.mocked(materializeRunFromGraph).mockResolvedValue({ run_plan_id: 'plan', steps: [{}] } as never);
    let release!: () => void;
    jest.mocked(start).mockImplementationOnce(() => new Promise<any>(resolve => { release = () => resolve({}); }));
    let returned = false;
    const pending = GET(request()).then(response => { returned = true; return response; });
    for (let i = 0; i < 30 && !release; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(release).toBeDefined(); expect(returned).toBe(false);
    release(); expect((await (await pending).json()).scan.counts.started).toBe(1);
  });

  it('reports a failed ordinary dispatch without leaking errors', async () => {
    jest.mocked(materializeRunFromGraph).mockResolvedValue({ run_plan_id: 'plan', steps: [{}] } as never);
    jest.mocked(start).mockRejectedValue(new Error(privateValue));
    const body = await (await GET(request())).json();
    expect(body.scan.counts.failed).toBe(1); expect(JSON.stringify(body)).not.toContain(privateValue);
    expect(jest.mocked(recordTelemetry).mock.calls[0][1]).toBe('degraded');
  });
});
