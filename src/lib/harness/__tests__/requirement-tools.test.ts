import { randomBytes, randomUUID } from 'node:crypto';
import { createRequirementTools } from '../requirement-tools';
import type { RequirementRun } from '../requirement-types';
import type { ToolContext } from '../types';

function fixture() {
  const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(),
    instanceId: randomUUID(), runId: randomUUID(), sessionId: randomUUID(), executionGeneration: 2 };
  const requirement: any = { id: run.requirementId, site_id: run.siteId, user_id: run.userId, title: 'Requested task',
    instructions: 'Preserve constraints', status: 'in-progress', backlog_revision: 12, runner_instance_id: run.instanceId,
    backlog: { items: [{ id: 'item-1', title: 'Work', status: 'done', attempts: 40, acceptance: ['Works'],
      review_quarantine: { active: true }, evidence: { tests: { passed: false } } }] } };
  const plan: any = { id: randomUUID(), site_id: run.siteId, instance_id: run.instanceId, requirement_id: run.requirementId,
    title: 'Existing', steps: [{ id: 'step-1', status: 'failed', metadata: { backlog_item_id: 'item-1' } }] };
  const from = jest.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    const rows = () => (table === 'requirements' ? [requirement] : table === 'instance_plans' ? [plan] : []).filter(row =>
      filters.every(([key, value]) => row[key.includes('->>') ? key.split('->>')[1] : key] === value));
    const query: any = { select: jest.fn(() => query), eq: jest.fn((key, value) => { filters.push([key, value]); return query; }),
      is: jest.fn((key, value) => { filters.push([key, value]); return query; }), order: jest.fn(() => query), range: jest.fn(() => query),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: rows(), error: null }).then(resolve) };
    return query;
  });
  const rpc = jest.fn(async (name: string, _args: Record<string, unknown>): Promise<{ data: any; error: any }> => ({ data: name === 'assert_agent_requirement_run' ? true : { state: 'updated', backlog_revision: 13, plan_id: plan.id }, error: null }));
  const client = { from, rpc }, tools = createRequirementTools({ run, client });
  const context: ToolContext = { sessionId: run.sessionId, operationId: randomUUID(), signal: new AbortController().signal, assertActive: jest.fn(async () => {}) };
  const execute = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(args, context);
  return { run, requirement, plan, client, context, execute, tools };
}

it('fences with host identity and atomic latest backlog revision; accepted failed checks never block recording', async () => {
  const f = fixture();
  f.requirement.backlog_revision = 99;
  const result = await f.execute('requirement_progress', { planId: f.plan.id, stepId: 'step-1', itemId: 'item-1', status: 'done', message: 'Implemented; tests still fail.' });
  expect(result.ok).toBe(true);
  expect(f.client.rpc).toHaveBeenNthCalledWith(1, 'assert_agent_requirement_run', {
    p_requirement_id: f.run.requirementId, p_run_id: f.run.runId, p_generation: 2, p_session_id: f.run.sessionId });
  expect(f.client.rpc).toHaveBeenNthCalledWith(2, 'patch_agent_requirement_progress', {
    p_requirement_id: f.run.requirementId, p_run_id: f.run.runId, p_generation: 2, p_session_id: f.run.sessionId,
    p_expected_backlog_revision: 99, p_plan_id: f.plan.id, p_step_id: 'step-1', p_item_id: 'item-1', p_status: 'done', p_message: 'Implemented; tests still fail.' });
  expect(JSON.stringify(result)).toContain('not independently verified acceptance');
  expect(f.requirement.backlog.items[0].review_quarantine.active).toBe(true);
});

it('requires no plan for work or progress messages and never accepts host owner arguments', async () => {
  const f = fixture();
  expect((await f.execute('requirement_progress', { itemId: 'item-1', status: 'in_progress' })).ok).toBe(true);
  expect((await f.execute('requirement_progress', { message: 'Investigating next item' })).ok).toBe(true);
  for (const args of [{ requirementId: randomUUID(), message: 'replace owner' }, { stepId: 'step-1', message: 'bad' },
    { planId: 'malformed', message: 'bad' }, { itemId: 'bad,site.eq.other', status: 'done' }, { status: 'done' }]) {
    f.client.rpc.mockClear();
    expect(await f.execute('requirement_progress', args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
    expect(f.client.rpc).not.toHaveBeenCalled();
  }
});

it('does not mutate when owner/session/tenant/revision or target checks fail; errors are returned as data', async () => {
  const f = fixture();
  f.context.sessionId = randomUUID();
  expect(await f.execute('requirement_progress', { message: 'no' })).toMatchObject({ ok: false, error: { code: 'OWNER_LOST' } });
  expect(f.client.rpc).not.toHaveBeenCalled();
  f.context.sessionId = f.run.sessionId;
  f.client.rpc.mockResolvedValueOnce({ data: false, error: null });
  expect(await f.execute('requirement_progress', { message: 'no' })).toMatchObject({ ok: false, error: { code: 'OWNER_LOST' } });
  f.plan.site_id = randomUUID(); f.client.rpc.mockClear();
  expect((await f.execute('requirement_progress', { planId: f.plan.id, message: 'no' })).ok).toBe(false);
  expect(f.client.rpc.mock.calls.map(call => call[0])).toEqual(['assert_agent_requirement_run']);
  f.plan.site_id = f.run.siteId;
  f.client.rpc.mockImplementation(async name => ({ data: name === 'assert_agent_requirement_run' ? true : { state: 'revision_conflict' } as any, error: null }));
  const result = await f.execute('requirement_progress', { itemId: 'item-1', status: 'done' });
  expect(result).toMatchObject({ ok: false, error: { code: 'PROGRESS_REJECTED', effectStarted: false } });
  expect(result.error?.ambiguous).toBeUndefined();
});

it('reads each page fresh, bounded, with no progress writes', async () => {
  const f = fixture();
  expect((await f.execute('requirement_context', { view: 'backlog', offset: 0, limit: 1 })).output).toMatchObject({ backlog_revision: 12 });
  f.requirement.backlog_revision = 15;
  expect((await f.execute('requirement_context', { view: 'backlog', offset: 0, limit: 1 })).output).toMatchObject({ backlog_revision: 15 });
  expect(f.client.rpc.mock.calls.every(call => call[0] === 'assert_agent_requirement_run')).toBe(true);
  expect(await f.execute('requirement_context', { view: 'backlog', limit: 1000 })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
});

it('redacts synthetic secrets and never returns RPC snapshots or error details', async () => {
  const f = fixture(), secret = randomBytes(24).toString('hex');
  const url = new URL('https://example.test/path'); url.password = secret; url.username = randomBytes(8).toString('hex');
  f.client.rpc.mockImplementation(async name => ({ data: name === 'assert_agent_requirement_run' ? true : { state: 'updated', metadata: { secret } } as any, error: null }));
  const result = await f.execute('requirement_progress', { message: `password=${secret} URL: ${url}` });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(f.client.rpc.mock.calls[1])).not.toContain(secret);
  f.client.rpc.mockImplementation(async name => ({ data: name === 'assert_agent_requirement_run' ? true : null, error: name === 'assert_agent_requirement_run' ? null : new Error(secret) }));
  expect(JSON.stringify(await f.execute('requirement_progress', { message: 'safe' }))).not.toContain(secret);
});

it('optionally seeds a plan or adds steps using only validated backlog IDs and host-owned metadata', async () => {
  const f = fixture();
  expect((await f.execute('requirement_plan', { title: 'Optional plan', steps: [{ title: 'First', itemId: 'item-1' }] })).ok).toBe(true);
  expect(f.client.rpc).toHaveBeenLastCalledWith('patch_agent_requirement_plan', expect.objectContaining({
    p_plan_id: null, p_title: 'Optional plan', p_expected_backlog_revision: 12,
    p_steps: [{ title: 'First', description: '', metadata: { backlog_item_id: 'item-1' } }],
  }));
  expect((await f.execute('requirement_plan', { planId: f.plan.id, title: 'Existing plan', steps: [{ id: 'new-step', title: 'Next' }] })).ok).toBe(true);
  f.client.rpc.mockClear();
  expect((await f.execute('requirement_plan', { title: 'Wrong item', steps: [{ title: 'Other', itemId: 'foreign' }] })).ok).toBe(false);
  expect(f.client.rpc.mock.calls.map(call => call[0])).toEqual(['assert_agent_requirement_run']);
});

it('closes an explicitly selected plan without accidentally updating a step or item', async () => {
  const f = fixture();
  expect((await f.execute('requirement_progress', { target: 'plan', planId: f.plan.id, status: 'completed' })).ok).toBe(true);
  expect(f.client.rpc).toHaveBeenLastCalledWith('patch_agent_requirement_progress', expect.objectContaining({
    p_plan_id: f.plan.id, p_step_id: null, p_item_id: null, p_status: 'completed' }));
  expect(f.client.rpc.mock.calls.at(-1)?.[1]).not.toHaveProperty('target');
});

it.each([
  ['plan', { stepId: 'step-1' }, 'omit stepId'],
  ['item', { itemId: 'item-1' }, 'omit planId'],
  ['step', {}, 'provide planId and stepId'],
  ['message', { message: 'Keep working' }, 'provide message only'],
])('explains ambiguous explicit %s targets without dispatch', async (target, extra, hint) => {
  const f = fixture();
  const result = await f.execute('requirement_progress', { target, planId: f.plan.id, status: 'completed', ...extra });
  expect(result.ok).toBe(false); expect(result.error?.message).toContain(hint);
  expect(f.client.rpc).not.toHaveBeenCalled();
});

it('reports unchanged as successful state, not an error, retry instruction or execution gate', async () => {
  const f = fixture();
  f.client.rpc.mockImplementation(async name => ({ error: null, data: name === 'assert_agent_requirement_run' ? true : {
    state: 'unchanged', status_changed: false, message_recorded: true, backlog_revision: 12,
    plan_id: f.plan.id, plan_status: 'pending', step_id: 'step-1', step_status: 'completed',
    item_id: 'item-1', item_status: 'done', plan_steps_total: 1, plan_steps_completed: 1,
    backlog_items_total: 1, backlog_items_completed: 1,
  } }));
  for (let n = 0; n < 4; n++) {
    const result = await f.execute('requirement_progress', { target: 'step', planId: f.plan.id, stepId: 'step-1', itemId: 'item-1', status: 'done', message: 'Verified actual state.' });
    expect(result).toMatchObject({ ok: true, output: { state: 'unchanged', statusChanged: false, messageRecorded: true,
      plan: { id: f.plan.id, status: 'pending', stepsCompleted: 1 }, step: { status: 'completed' }, item: { status: 'done' },
      availableAction: { tool: 'requirement_progress', arguments: { target: 'plan', planId: f.plan.id, status: 'completed' } } } });
  }
  expect(f.client.rpc).toHaveBeenCalledTimes(8);
});

it('explains the context selector mistake that preceded the production loop', async () => {
  const f = fixture();
  const result = await f.execute('requirement_context', { view: 'plans', planId: f.plan.id, itemId: 'item-1' });
  expect(result.error?.message).toBe('itemId applies to backlog details only.');
  expect(f.client.rpc).not.toHaveBeenCalled();
});

it('does not echo submitted invalid enum values or unknown fields in validation errors', async () => {
  const f = fixture(), secret = randomBytes(24).toString('hex');
  const result = await f.execute('requirement_progress', { target: secret, status: secret, [secret]: secret });
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(secret);
});