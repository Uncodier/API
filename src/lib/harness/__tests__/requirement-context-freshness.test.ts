import { randomBytes, randomUUID } from 'node:crypto';
import { formatRequirementContext, formatRequirementSnapshot, loadRequirementSnapshot, REQUIREMENT_PAGE_LIMIT } from '../requirement-context';
import type { RequirementRun } from '../requirement-types';

function fixture() {
  const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    sessionId: randomUUID(), runId: 'offline-refresh', executionGeneration: 1 };
  const req: any = { id: run.requirementId, site_id: run.siteId, user_id: run.userId, status: 'in-progress', backlog_revision: 1,
    updated_at: '2026-10-14T10:00:00Z', item_0_id: 'item-1', item_0_status: 'pending' };
  const plan = (overrides = {}) => ({ id: randomUUID(), site_id: run.siteId, requirement_id: run.requirementId, status: 'pending',
    updated_at: '2026-10-14T10:00:00Z', ...overrides });
  let plans: any[] = [plan()]; let error: unknown = null;
  const queries: any[] = [];
  const client = { rpc: jest.fn(), from: jest.fn((table: string) => {
    const q: any = { table, filters: [] }; queries.push(q);
    const result = () => ({ data: table === 'requirements' ? req : plans.slice(0, REQUIREMENT_PAGE_LIMIT), error });
    const builder: any = { select: (columns: string) => { q.columns = columns; return builder; },
      eq: (key: string, value: unknown) => { q.filters.push([key, value]); return builder; },
      order: () => builder, range: (start: number, end: number) => { q.range = [start, end]; return builder; },
      maybeSingle: async () => result(), then: (resolve: any) => Promise.resolve(result()).then(resolve) };
    return builder;
  }) };
  return { run, req, client, queries, plan, setPlans: (value: any[]) => { plans = value; }, fail: (value: unknown) => { error = value; } };
}

it('refreshes status/count observations and revisions with two bounded scoped reads, never full task prose/history', async () => {
  const f = fixture();
  const first = await loadRequirementSnapshot(f.run, f.client);
  f.req.item_0_status = 'done'; f.req.backlog_revision++;
  f.setPlans([f.plan({ status: 'completed' })]);
  const second = await loadRequirementSnapshot(f.run, f.client);
  expect(first.backlog.observed_status_counts).toEqual({ pending: 1 });
  expect(second.backlog.observed_status_counts).toEqual({ done: 1 });
  expect(second.plans.observed_status_counts).toEqual({ completed: 1 });
  expect(first.revision).not.toBe(second.revision);
  expect(second.requirement.backlog_revision).toBe(2);
  expect(Number.isFinite(Date.parse(second.observed_at))).toBe(true);
  expect(formatRequirementSnapshot(second)).toContain('Fresh tool receipts take precedence');
  expect(f.queries).toHaveLength(4);
  for (const query of f.queries) {
    expect(query.columns.split(',')).not.toEqual(expect.arrayContaining(['backlog', 'steps', 'metadata', 'instructions', 'description', 'title']));
    expect(query.columns).not.toMatch(/steps_total|steps_completed/);
    expect(query.filters).toContainEqual(['site_id', f.run.siteId]);
    if (query.table === 'requirements') {
      expect(query.filters).toContainEqual(['id', f.run.requirementId]);
      expect(query.filters).toContainEqual(['user_id', f.run.userId]);
      expect(query.columns).toContain('item_0_id:backlog->items->0->>id');
    } else {
      expect(query.filters).toContainEqual(['metadata->>requirement_id', f.run.requirementId]);
      expect(query.range).toEqual([0, REQUIREMENT_PAGE_LIMIT - 1]);
    }
  }
  expect(f.client.rpc).not.toHaveBeenCalled();
});

it('unknown and partial samples never claim global totals or closure; excludes foreign/template plans', async () => {
  const f = fixture();
  f.req.item_0_status = 'not-a-known-status'; f.req.next_item_id = 'item-21';
  f.setPlans(Array.from({ length: 20 }, (_, i) => f.plan(i === 0 ? { site_id: randomUUID() }
    : i === 1 ? { requirement_id: randomUUID() } : i === 2 ? { workflow_template: true } : {})));
  const snapshot = await loadRequirementSnapshot(f.run, f.client);
  expect(snapshot.backlog).toMatchObject({ observed_status_counts: { unknown: 1 }, total: null, next_offset: 20 });
  expect(snapshot.plans).toMatchObject({ observed_plans: 17, total: null, next_offset: 20 });
  expect(snapshot.plans.coverage).toContain('Step totals are unknown');
  expect(formatRequirementSnapshot(snapshot)).toContain('omitted or unknown state is not completed or unchanged');
  expect(JSON.stringify(snapshot)).not.toContain('availableAction');
});

it('rejects read failures and scope mismatch without returning old or fabricated empty state or raw exceptions', async () => {
  const f = fixture(); const secret = randomBytes(24).toString('hex');
  f.fail({ message: secret });
  await expect(loadRequirementSnapshot(f.run, f.client)).rejects.toThrow('Requirement snapshot unavailable.');
  f.fail(null); f.req.site_id = randomUUID();
  await expect(loadRequirementSnapshot(f.run, f.client)).rejects.toThrow('Requirement snapshot unavailable.');
  expect(f.queries).toHaveLength(2);
});

it('allowlists state and item identities, omitting sensitive task content even from overbroad offline rows', async () => {
  const f = fixture(); const secret = randomBytes(24).toString('hex');
  Object.assign(f.req, { item_0_id: `secret:${secret}`, item_0_status: secret, description: secret, instructions: secret, metadata: { secret } });
  f.setPlans([f.plan({ status: secret, updated_at: secret, description: secret, steps: [{ title: secret }] })]);
  const text = formatRequirementSnapshot(await loadRequirementSnapshot(f.run, f.client));
  expect(text).not.toContain(secret);
  expect(text).toContain('unknown');
});

it('does not label the static initial task and instructions as current', () => {
  const f = fixture();
  const text = formatRequirementContext({ requirement: { ...f.req, title: 'Task', instructions: 'Preserve original constraints.' }, plans: [], history: [], revision: 'reference-r1' });
  expect(text).toContain('slice-start reference'); expect(text).toContain('Preserve original constraints.');
  expect(text).not.toContain('current snapshot');
});