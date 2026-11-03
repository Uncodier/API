// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';

const from = jest.fn();
const materializeRunFromGraph = jest.fn();
const runWorkflowPlan = jest.fn();
const assertProcurementWorkflowActorAccess = jest.fn();
jest.unstable_mockModule('../procurement-access', () => ({
  assertProcurementWorkflowActorAccess,
  isProcurementWorkflowTable: table => table === 'suppliers',
}));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('../materialize', () => ({ materializeRunFromGraph }));
jest.unstable_mockModule('../run-plan', () => ({ runWorkflowPlan }));
const { dispatchWorkflowEvent } = await import('../dispatch');

const trigger = {
  id: 'trigger-1', instance_id: 'instance-1', template_plan_id: 'template-1',
  config: { table: 'leads', op: ['insert', 'update', 'delete'] },
};
const event = {
  table: 'leads', op: 'update', site_id: 'site-1',
  row: { id: 'lead-1', status: 'open', updated_at: '2026-11-04T10:00:00Z' },
};
const keys = () => materializeRunFromGraph.mock.calls.map(([args]) => args.idempotency_key);
const queryFor = (triggers = [trigger]) => {
  const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    then: resolve => Promise.resolve({ data: triggers, error: null }).then(resolve) };
  from.mockReturnValue(query);
  return query;
};

beforeEach(() => {
  jest.clearAllMocks();
  queryFor();
  materializeRunFromGraph.mockResolvedValue({ run_plan_id: 'run-1', steps: [{ id: 'step-1' }] });
  runWorkflowPlan.mockResolvedValue(undefined);
  assertProcurementWorkflowActorAccess.mockResolvedValue(undefined);
});

it.each(['insert', 'update', 'delete'])('keeps the same %s event key on retries, but permits another mutation', async op => {
  const event_id = randomUUID();
  await dispatchWorkflowEvent({ ...event, op, event_id });
  await dispatchWorkflowEvent({ ...event, op, event_id });
  await dispatchWorkflowEvent({ ...event, op, event_id: randomUUID() });
  expect(keys()[0]).toBe(keys()[1]);
  expect(keys()[0]).not.toBe(keys()[2]);
  expect(materializeRunFromGraph.mock.calls[0][0].trigger_payload).toEqual(expect.objectContaining({ event_id, row: event.row }));
});

it('canonicalizes nested object ordering but preserves array ordering for legacy emitters', async () => {
  await dispatchWorkflowEvent({ ...event, row: { ...event.row, metadata: { b: 2, a: 1 }, tags: ['a', 'b'] } });
  await dispatchWorkflowEvent({ ...event, row: { tags: ['a', 'b'], metadata: { a: 1, b: 2 }, ...event.row } });
  await dispatchWorkflowEvent({ ...event, row: { ...event.row, metadata: { a: 1, b: 2 }, tags: ['b', 'a'] } });
  expect(keys()[0]).toBe(keys()[1]);
  expect(keys()[0]).not.toBe(keys()[2]);
});

it('distinguishes changed values and version timestamps for the same legacy row', async () => {
  await dispatchWorkflowEvent(event);
  await dispatchWorkflowEvent(event);
  await dispatchWorkflowEvent({ ...event, row: { ...event.row, status: 'closed' } });
  await dispatchWorkflowEvent({ ...event, row: { ...event.row, updated_at: '2026-11-04T11:00:00Z' } });
  expect(keys()[0]).toBe(keys()[1]);
  expect(new Set(keys()).size).toBe(3);
  expect(keys()[0]).not.toContain(event.row.updated_at);
});

it('isolates triggers sharing a template and operations on the same snapshot', async () => {
  queryFor([trigger, { ...trigger, id: 'trigger-2' }]);
  const event_id = randomUUID();
  await dispatchWorkflowEvent({ ...event, event_id });
  await dispatchWorkflowEvent({ ...event, event_id, op: 'delete' });
  expect(new Set(keys()).size).toBe(4);
});

it('skips an already materialized retry rather than launching it again', async () => {
  const existing = new Set();
  materializeRunFromGraph.mockImplementation(async ({ idempotency_key }) => {
    const duplicate = existing.has(idempotency_key);
    existing.add(idempotency_key);
    return { run_plan_id: 'run-1', steps: duplicate ? [] : [{ id: 'step-1' }] };
  });
  expect(await dispatchWorkflowEvent(event)).toEqual({ started: 1, skipped: 0 });
  expect(await dispatchWorkflowEvent(event)).toEqual({ started: 0, skipped: 1 });
  expect(runWorkflowPlan).toHaveBeenCalledTimes(1);
});

it('checks the canonical instance actor before materializing a procurement event', async () => {
  const procurementTrigger = { ...trigger, user_id: 'subscription-author', config: { table: 'suppliers', op: 'update' } };
  const triggersQuery = queryFor([procurementTrigger]);
  const instanceQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { user_id: 'instance-owner' }, error: null }) };
  from.mockImplementation(table => table === 'remote_instances' ? instanceQuery : triggersQuery);
  await dispatchWorkflowEvent({ ...event, table: 'suppliers' });
  expect(instanceQuery.eq).toHaveBeenCalledWith('id', trigger.instance_id);
  expect(instanceQuery.eq).toHaveBeenCalledWith('site_id', event.site_id);
  expect(assertProcurementWorkflowActorAccess).toHaveBeenCalledWith(event.site_id, 'instance-owner');
  expect(materializeRunFromGraph).toHaveBeenCalledTimes(1);
  assertProcurementWorkflowActorAccess.mockRejectedValueOnce(new Error('Access denied'));
  expect(await dispatchWorkflowEvent({ ...event, table: 'suppliers' })).toEqual({ started: 0, skipped: 1 });
  expect(materializeRunFromGraph).toHaveBeenCalledTimes(1);
  instanceQuery.single.mockResolvedValue({ data: null, error: null });
  expect(await dispatchWorkflowEvent({ ...event, table: 'suppliers' })).toEqual({ started: 0, skipped: 1 });
  expect(materializeRunFromGraph).toHaveBeenCalledTimes(1);
});

it('preserves materializer-directed resume on a retry with the same identity', async () => {
  materializeRunFromGraph.mockResolvedValue({ run_plan_id: 'run-1', steps: [], resume_existing_run: true });
  expect(await dispatchWorkflowEvent(event)).toEqual({ started: 1, skipped: 0 });
  expect(runWorkflowPlan).toHaveBeenCalledWith('run-1');
});