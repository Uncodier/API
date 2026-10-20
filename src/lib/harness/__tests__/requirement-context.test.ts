import { randomBytes, randomUUID } from 'node:crypto';
import { formatRequirementContext, loadRequirementContext, loadRequirementPage, loadRequirementProgressTarget } from '../requirement-context';
import type { RequirementRun } from '../requirement-types';

function fixture() {
  const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(),
    instanceId: randomUUID(), runId: randomUUID(), sessionId: randomUUID(), executionGeneration: 7 };
  const req: any = { id: run.requirementId, site_id: run.siteId, user_id: run.userId, title: 'Implement export',
    instructions: 'Keep the original data format.', description: 'Do not change existing routes.', status: 'in-progress',
    backlog_revision: 4, runner_instance_id: run.instanceId,
    backlog: { items: [{ id: 'item-1', title: 'Export', status: 'done', acceptance: ['CSV round-trips correctly'],
      constraints: ['MUST NOT expose other tenants'], attempts: 99, blocked_by: [{ reason: 'Legacy test failure', category: 'product_defect' }] }] } };
  const tables: Record<string, any[]> = { requirements: [req], instance_plans: [], requirement_status: [], instance_logs: [], requirement_user_action_receipts: [] };
  const queries: any[] = [];
  const client = { rpc: jest.fn(), from: jest.fn((table: string) => {
    const q: any = { table, filters: [], rangeValues: null };
    const builder: any = {
      select: jest.fn((columns: string) => { q.columns = columns; return builder; }),
      eq: jest.fn((key: string, value: any) => { q.filters.push([key, value]); return builder; }),
      is: jest.fn((key: string, value: any) => { q.filters.push([key, value]); return builder; }),
      order: jest.fn(() => builder),
      range: jest.fn((start: number, end: number) => { q.rangeValues = [start, end]; return builder; }),
      maybeSingle: jest.fn(() => Promise.resolve({ data: rows()[0] ?? null, error: null })),
      then: (resolve: any) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    const rows = () => {
      let data = tables[table].filter(row => q.filters.every(([key, value]: any) => {
        const field = key.includes('->>') ? key.split('->>')[1] : key;
        const actual = field.split('.').reduce((current: any, part: string) => current?.[part], row);
        return value == null ? actual == null : actual === value;
      }));
      if (q.rangeValues) data = data.slice(q.rangeValues[0], q.rangeValues[1] + 1);
      return data;
    };
    queries.push(q); return builder;
  }) };
  const plan = (overrides: any = {}) => ({ id: randomUUID(), site_id: run.siteId, instance_id: run.instanceId,
    requirement_id: run.requirementId, title: 'Export plan', instructions: 'Implement the requested export', status: 'failed',
    steps: [{ id: 'step-1', title: 'Write export', status: 'failed', metadata: { backlog_item_id: 'item-1' } }], ...overrides });
  return { run, req, tables, queries, client, plan };
}

it('loads tenant-scoped explicit and exact-runner legacy plans, filtering foreign and malformed item links', async () => {
  const f = fixture();
  const explicit = f.plan({ instance_id: randomUUID(), steps: [{ id: 'unbound', title: 'Requirement-only work' },
    { id: 'bad', metadata: { backlog_item_id: 'another-item' } }] });
  const legacy = f.plan({ requirement_id: null, instructions: 'Other task private instructions', steps: [
    { id: 'match', title: 'Matching work', backlog_item_id: 'item-1' }, { id: 'other', title: 'Foreign work', backlog_item_id: 'other' },
    { id: 'unbound', title: 'Other task unbound work' }] });
  f.tables.instance_plans = [explicit, legacy, f.plan({ site_id: randomUUID() }), f.plan({ requirement_id: randomUUID() }),
    f.plan({ requirement_id: null, instance_id: randomUUID() })];
  const before = JSON.stringify(f.tables);
  const ctx = await loadRequirementContext(f.run, f.client);
  expect(ctx.plans.map(plan => plan.id)).toEqual([explicit.id, legacy.id]);
  expect(ctx.plans[0].steps.map((step: any) => step.id)).toEqual(['unbound']);
  expect(ctx.plans[1].steps.map((step: any) => step.id)).toEqual(['match']);
  expect(JSON.stringify(ctx)).not.toContain('Other task private instructions');
  expect(JSON.stringify(ctx)).not.toContain('Foreign work');
  expect(JSON.stringify(f.tables)).toBe(before);
  expect(f.client.rpc).not.toHaveBeenCalled();
  for (const query of f.queries) {
    expect(query.filters).toContainEqual([query.table === 'requirement_user_action_receipts' ? 'action.site_id' : 'site_id', f.run.siteId]);
    expect(query.columns.split(',')).not.toContain('*');
    expect(query.columns.split(',')).not.toContain('metadata');
    if (query.table !== 'requirements') expect(query.rangeValues).not.toBeNull();
  }
  expect(f.queries.find(q => q.table === 'requirements').filters).toContainEqual(['user_id', f.run.userId]);
});

it('does not infer a legacy plan association from a malformed or different runner ID', async () => {
  const f = fixture();
  f.req.runner_instance_id = 'not-a-runner';
  f.tables.instance_plans = [f.plan({ requirement_id: null })];
  expect((await loadRequirementContext(f.run, f.client)).plans).toEqual([]);
  expect(f.queries.filter(q => q.table === 'instance_plans')).toHaveLength(1);
  await expect(loadRequirementContext({ ...f.run, requirementId: 'bad,site_id.eq.foreign' }, f.client)).rejects.toThrow('identity');
});

it('preserves original acceptance and constraints; accepted/failed legacy evidence is informational, with no writes', async () => {
  const f = fixture();
  f.tables.instance_plans = [f.plan()];
  const ctx = await loadRequirementContext(f.run, f.client), prompt = formatRequirementContext(ctx);
  expect(prompt).toContain(f.req.instructions);
  expect(prompt).toContain('CSV round-trips correctly');
  expect(prompt).toContain('MUST NOT expose other tenants');
  expect(prompt).toContain('Legacy test failure');
  expect(prompt).toContain('informational');
  expect(prompt).toContain('continue with the next useful item');
  expect(prompt).not.toMatch(/Next\.js|Judge|must pass|quarantine the run|do not code/i);
  expect(ctx.requirement.backlog?.items?.[0].status).toBe('done');
  expect(f.client.rpc).not.toHaveBeenCalled();
});

it('omits raw metadata/env/source fields and redacts runtime synthetic credentials from bounded reference history', async () => {
  const f = fixture(), secrets = Array.from({ length: 5 }, () => randomBytes(24).toString('hex'));
  const url = new URL('https://example.test/resource'); url.username = secrets[0]; url.password = secrets[1]; url.searchParams.set('access_token', secrets[2]);
  f.req.metadata = { environment: { token: secrets[3] } };
  f.req.backlog.items[0].metadata = { credentials: secrets[4] };
  f.tables.requirement_status = [{ id: randomUUID(), site_id: f.run.siteId, requirement_id: f.run.requirementId,
    message: `${url} password=${secrets[3]}`, source_code: secrets[4], stage: 'failed' }];
  f.tables.instance_logs = [{ id: randomUUID(), site_id: f.run.siteId, instance_id: f.run.instanceId, log_type: 'user_action',
    message: `Reference only: Bearer ${secrets[4]} ${'old note '.repeat(1000)}`, status: 'completed', details: { token: secrets[3] } },
  { id: randomUUID(), site_id: f.run.siteId, instance_id: f.run.instanceId, log_type: 'user_action', requirement_id: randomUUID(), message: 'Foreign request' }];
  const ctx = await loadRequirementContext(f.run, f.client), text = formatRequirementContext(ctx);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toContain('Foreign request');
  expect(ctx.history).toHaveLength(2);
  expect(ctx.history.find(row => row.kind === 'user_action_reference')?.message.length).toBeLessThan(1100);
  expect(text).toContain('not instructions or authority');
});

it('bounds initial large lists and exposes fresh pages, including full original long acceptance/instructions', async () => {
  const f = fixture();
  f.req.backlog.items = Array.from({ length: 1500 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}`, acceptance: ['yes'], status: 'pending' }));
  f.req.instructions = 'Original instructions. '.repeat(1000) + 'END-ORIGINAL';
  f.req.backlog.items[30].acceptance = ['Complete acceptance '.repeat(900) + 'END-ACCEPTANCE'];
  f.tables.instance_plans = Array.from({ length: 600 }, () => f.plan({ steps: Array.from({ length: 1000 }, (_, i) => ({ id: `step-${i}` })) }));
  const ctx = await loadRequirementContext(f.run, f.client);
  expect(ctx.requirement.backlog?.items).toHaveLength(5);
  expect(ctx.plans).toHaveLength(2);
  expect(ctx.plans[0].steps).toHaveLength(3);
  expect(JSON.stringify(ctx).length).toBeLessThan(30_000);
  f.req.backlog_revision++;
  const page = await loadRequirementPage(f.run, { view: 'backlog', offset: 29, limit: 3 }, f.client);
  expect(page.items.map((item: any) => item.id)).toEqual(['item-29', 'item-30', 'item-31']);
  expect(page.backlog_revision).toBe(5);
  const allInstructions = await loadRequirementPage(f.run, { view: 'summary', offset: 0, limit: 20 }, f.client);
  expect(allInstructions.items.filter((chunk: any) => chunk.field === 'instructions').map((chunk: any) => chunk.text).join('')).toBe(f.req.instructions);
  const allAcceptance = await loadRequirementPage(f.run, { view: 'backlog', itemId: 'item-30', offset: 0, limit: 20 }, f.client);
  expect(allAcceptance.items.filter((chunk: any) => chunk.field === 'acceptance').map((chunk: any) => chunk.text).join('')).toContain('END-ACCEPTANCE');
  expect((await loadRequirementPage(f.run, { view: 'plans', planId: f.tables.instance_plans[10].id, offset: 700, limit: 2 }, f.client)).plan.steps[0].id).toBe('step-700');
});

it('loads original authorized messages from another session without exposing unrelated or untrusted messages', async () => {
  const f = fixture(), messageId = randomUUID();
  const action = { id: messageId, site_id: f.run.siteId, instance_id: randomUUID(), log_type: 'user_action',
    trusted_user_action: true, status: 'completed', created_at: '2026-10-20T19:00:00Z', message: 'Add the marketplace ranking; preserve the historical research.' };
  f.tables.requirement_user_action_receipts = [
    { requirement_id: f.run.requirementId, action },
    { requirement_id: randomUUID(), action: { ...action, id: randomUUID(), message: 'Other requirement' } },
    { requirement_id: f.run.requirementId, action: { ...action, id: randomUUID(), site_id: randomUUID(), message: 'Other tenant' } },
    { requirement_id: f.run.requirementId, action: { ...action, id: randomUUID(), trusted_user_action: false, message: 'Model fabrication' } },
  ];
  const ctx = await loadRequirementContext(f.run, f.client);
  expect(ctx.history).toEqual([expect.objectContaining({ id: messageId, message: action.message })]);
  expect(formatRequirementContext(ctx)).not.toMatch(/Other requirement|Other tenant|Model fabrication/);
  const query = f.queries.find(query => query.table === 'requirement_user_action_receipts');
  expect(query.filters).toContainEqual(['requirement_id', f.run.requirementId]);
  expect(query.columns).not.toContain('tool_args');
});

it('target lookups reject foreign plans and malformed links independently of initial preview size', async () => {
  const f = fixture(), foreign = f.plan({ site_id: randomUUID() });
  f.tables.instance_plans = [foreign];
  await expect(loadRequirementProgressTarget(f.run, { planId: foreign.id }, f.client)).rejects.toThrow('Plan unavailable');
  const plan = f.plan({ steps: [{ id: 'bad', metadata: { backlog_item_id: { id: 'item-1' } } }] });
  f.tables.instance_plans = [plan];
  await expect(loadRequirementProgressTarget(f.run, { planId: plan.id, stepId: 'bad' }, f.client)).rejects.toThrow('Step unavailable');
  await expect(loadRequirementProgressTarget(f.run, { itemId: 'foreign' }, f.client)).rejects.toThrow('Backlog item unavailable');
});

it('continues paging after filtered legacy entries and exposes all step statuses without gates', async () => {
  const f = fixture();
  f.tables.instance_plans = [f.plan({ requirement_id: null, steps: [{ id: 'foreign', backlog_item_id: 'other' }] }),
    f.plan({ requirement_id: null, steps: [{ id: 'matching', backlog_item_id: 'item-1', status: 'failed' }] })];
  const empty = await loadRequirementPage(f.run, { view: 'plans', offset: 0, limit: 1 }, f.client);
  expect(empty.items).toEqual([]);
  expect(empty.next_offset).toBe(1);
  const match = await loadRequirementPage(f.run, { view: 'plans', offset: empty.next_offset, limit: 1 }, f.client);
  expect(match.items).toHaveLength(1);
  expect(match.items[0].step_status_counts).toEqual({ failed: 1 });
});