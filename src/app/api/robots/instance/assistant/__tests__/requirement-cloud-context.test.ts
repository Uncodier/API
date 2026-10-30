import { randomUUID } from 'node:crypto';
import { resolveAssistantFileEnvironment } from '../cloud-context';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

type Row = { id: string; site_id: string; instance_id?: string; metadata: Record<string, unknown> };
type Query = { table: string; eq: jest.Mock; not: jest.Mock; limit: jest.Mock; order: jest.Mock; range: jest.Mock };

function fixture() {
  const scope = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID() };
  const queries: Query[] = [];
  const rows: Record<string, Row[]> = { requirements: [], instance_plans: [] };
  const failures = new Set<string>();
  const value = (row: Row, field: string) => field.startsWith('metadata->>')
    ? row.metadata[field.slice('metadata->>'.length)] : row[field as keyof Row];
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let order: { field: string; ascending: boolean } | undefined;
    const execute = async (start: number, end: number) => {
      if (failures.has(table) || failures.has(`${table}:${start}`)) {
        return { data: null, error: new Error('Offline lookup unavailable') };
      }
      const selected = rows[table].filter(row => filters.every(filter => filter(row)));
      if (order) {
        const { field, ascending } = order;
        selected.sort((a, b) => String(value(a, field)).localeCompare(String(value(b, field))) * (ascending ? 1 : -1));
      }
      return { data: selected.slice(start, end + 1), error: null };
    };
    const builder: any = {
      select: jest.fn(() => builder),
      eq: jest.fn((field: string, expected: unknown) => {
        filters.push(row => value(row, field) === expected);
        return builder;
      }),
      not: jest.fn((field: string, operator: string, expected: unknown) => {
        if (operator !== 'is' || expected !== null) throw new Error('Unsupported offline filter');
        filters.push(row => value(row, field) != null);
        return builder;
      }),
      order: jest.fn((field: string, options: { ascending: boolean }) => {
        order = { field, ...options };
        return builder;
      }),
      limit: jest.fn((count: number) => execute(0, count - 1)),
      range: jest.fn(execute),
    };
    queries.push({ table, ...builder });
    return builder;
  });
  const requirement = (environment = 'cloud', runner: string | null = scope.instanceId, site = scope.siteId) => {
    const row: Row = { id: randomUUID(), site_id: site, metadata: { execution_environment: environment } };
    if (runner) row.metadata.runner_instance_id = runner;
    rows.requirements.push(row);
    return row.id;
  };
  const plan = (id: unknown, instance = scope.instanceId, site = scope.siteId) => {
    rows.instance_plans.push({ id: String(rows.instance_plans.length).padStart(8, '0'),
      site_id: site, instance_id: instance, metadata: { requirement_id: id } });
  };
  return { scope, queries, rows, failures, requirement, plan };
}

beforeEach(() => jest.resetAllMocks());

test.each(['cloud', 'workspace'] as const)('file environment comes from persisted %s metadata after checking all bindings', async environment => {
  const f = fixture();
  const id = f.requirement(environment);
  expect(await resolveAssistantFileEnvironment(f.scope)).toEqual({ environment, requirementId: id });
  expect(f.queries.map(query => query.table)).toEqual(['requirements', 'instance_plans']);
  expect(f.queries[0].eq).toHaveBeenCalledWith('metadata->>runner_instance_id', f.scope.instanceId);
  expect(f.queries[1].eq).toHaveBeenCalledWith('instance_id', f.scope.instanceId);
  for (const query of f.queries) expect(query.eq).toHaveBeenCalledWith('site_id', f.scope.siteId);
});

test.each([false, true])('legacy plan binding resolves its scoped requirement (explicit: %s)', async explicit => {
  const f = fixture();
  const id = f.requirement('cloud', null);
  f.plan(id);
  expect(await resolveAssistantFileEnvironment({ ...f.scope, ...(explicit ? { requirementId: id } : {}) }))
    .toEqual({ environment: 'cloud', requirementId: id });
  expect(f.queries.map(query => query.table)).toEqual(['requirements', 'instance_plans', 'requirements']);
  for (const query of f.queries) expect(query.eq).toHaveBeenCalledWith('site_id', f.scope.siteId);
  expect(f.queries[2].eq).toHaveBeenCalledWith('id', id);
});

test('unbound standalone scope requires both runner and plan lookups to be empty', async () => {
  const f = fixture();
  expect(await resolveAssistantFileEnvironment(f.scope)).toEqual({});
  expect(f.queries).toHaveLength(2);
});

test('historical workspace ID cannot override the current cloud runner binding', async () => {
  const f = fixture();
  const stale = f.requirement('workspace', randomUUID());
  const actual = f.requirement('cloud');
  await expect(resolveAssistantFileEnvironment({ ...f.scope, requirementId: stale }))
    .rejects.toThrow(/^Requirement file environment is inaccessible$/);
  expect(await resolveAssistantFileEnvironment(f.scope)).toEqual({ environment: 'cloud', requirementId: actual });
  expect(await resolveAssistantFileEnvironment({ ...f.scope, requirementId: actual }))
    .toEqual({ environment: 'cloud', requirementId: actual });
});

test.each(['unlinked', 'other runner', 'other plan', 'foreign tenant', 'missing'] as const)
('explicit %s requirement cannot authorize standalone or another instance', async kind => {
  const f = fixture();
  const otherInstance = randomUUID();
  const id = kind === 'missing' ? randomUUID() : f.requirement('workspace',
    kind === 'other runner' ? otherInstance : null, kind === 'foreign tenant' ? randomUUID() : f.scope.siteId);
  if (kind === 'other plan') f.plan(id, otherInstance);
  if (kind === 'foreign tenant') f.plan(id); // A dangling same-instance plan is not tenant authorization.
  await expect(resolveAssistantFileEnvironment({ ...f.scope, requirementId: id }))
    .rejects.toThrow(/^Requirement file environment is inaccessible$/);
});

test('runner and plan source filters exclude foreign tenants and other instances', async () => {
  const f = fixture();
  const foreignSite = randomUUID();
  const foreign = f.requirement('workspace', f.scope.instanceId, foreignSite);
  const other = f.requirement('workspace', randomUUID());
  f.plan(foreign, f.scope.instanceId, foreignSite);
  f.plan(other, randomUUID());
  f.plan(null);
  expect(await resolveAssistantFileEnvironment(f.scope)).toEqual({});
  const actual = f.requirement('cloud', null);
  f.plan(actual);
  expect(await resolveAssistantFileEnvironment(f.scope)).toEqual({ environment: 'cloud', requirementId: actual });
});

test.each(['runner', 'plan', 'mixed'] as const)('ambiguous %s bindings fail closed with or without explicit ID', async source => {
  const f = fixture();
  const a = f.requirement('workspace', source === 'plan' ? null : f.scope.instanceId);
  const b = f.requirement('cloud', source === 'runner' ? f.scope.instanceId : null);
  if (source !== 'runner') {
    if (source === 'plan') {
      f.plan(a);
      f.plan(a);
    }
    f.plan(b);
  }
  for (const requirementId of [undefined, a, b]) {
    await expect(resolveAssistantFileEnvironment({ ...f.scope, requirementId }))
      .rejects.toThrow(/^Instance has conflicting requirement bindings$/);
  }
});

test.each([false, true])('A,A,B conflict on a later ordered page fails closed (runner: %s)', async runner => {
  const f = fixture();
  const a = f.requirement('workspace', runner ? f.scope.instanceId : null);
  const b = f.requirement('cloud', null);
  for (let i = 0; i < 1000; i++) f.plan(a);
  f.plan(b);
  f.rows.instance_plans.reverse(); // The mock executes ordering before applying range.
  await expect(resolveAssistantFileEnvironment({ ...f.scope, requirementId: a })).rejects.toThrow('conflicting');
  const plans = f.queries.filter(query => query.table === 'instance_plans');
  expect(plans).toHaveLength(2);
  expect(plans[0].range).toHaveBeenCalledWith(0, 999);
  expect(plans[1].range).toHaveBeenCalledWith(1000, 1999);
  for (const query of plans) {
    expect(query.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(query.eq).toHaveBeenCalledWith('site_id', f.scope.siteId);
    expect(query.eq).toHaveBeenCalledWith('instance_id', f.scope.instanceId);
    expect(query.limit).not.toHaveBeenCalled();
  }
});

test.each([false, true])('repeated A bindings across pages are allowed (runner: %s)', async runner => {
  const f = fixture();
  const id = f.requirement('cloud', runner ? f.scope.instanceId : null);
  for (let i = 0; i < 1001; i++) f.plan(id);
  expect(await resolveAssistantFileEnvironment({ ...f.scope, requirementId: id }))
    .toEqual({ environment: 'cloud', requirementId: id });
  expect(f.queries.filter(query => query.table === 'instance_plans')).toHaveLength(2);
});

test('exactly full page requires an exhaustion query', async () => {
  const f = fixture();
  const id = f.requirement();
  for (let i = 0; i < 1000; i++) f.plan(id);
  expect(await resolveAssistantFileEnvironment(f.scope)).toEqual({ environment: 'cloud', requirementId: id });
  expect(f.queries.filter(query => query.table === 'instance_plans')).toHaveLength(2);
});

test('plan scan is bounded to 10000 rows and fails closed rather than ignoring later bindings', async () => {
  const f = fixture();
  const id = f.requirement();
  for (let i = 0; i < 10000; i++) f.plan(id);
  f.plan(f.requirement('workspace', null));
  await expect(resolveAssistantFileEnvironment(f.scope)).rejects.toThrow(/^Requirement file environment is unavailable$/);
  const plans = f.queries.filter(query => query.table === 'instance_plans');
  expect(plans).toHaveLength(10);
  expect(plans[9].range).toHaveBeenCalledWith(9000, 9999);
});

test.each(['requirements', 'instance_plans', 'instance_plans:1000'])('unavailable %s lookup cannot authorize tools', async source => {
  const f = fixture();
  const id = f.requirement();
  if (source.endsWith(':1000')) for (let i = 0; i < 1000; i++) f.plan(id);
  f.failures.add(source);
  await expect(resolveAssistantFileEnvironment(f.scope)).rejects.toThrow(/^Requirement file environment is unavailable$/);
});

test('a plan pointing to an inaccessible requirement cannot become standalone', async () => {
  const f = fixture();
  f.plan(randomUUID());
  await expect(resolveAssistantFileEnvironment(f.scope)).rejects.toThrow(/^Requirement file environment is inaccessible$/);
});

test.each(['', 42, {}])('malformed non-null plan binding %p fails closed', async id => {
  const f = fixture();
  f.plan(id);
  await expect(resolveAssistantFileEnvironment(f.scope)).rejects.toThrow(/^Requirement file environment is unavailable$/);
});