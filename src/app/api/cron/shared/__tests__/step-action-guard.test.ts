import { captureLocalReadState, withActionLoopGuard, loadStepActionObservations, type ActionGuardContext } from '../step-action-guard';
import { createHash } from 'node:crypto';
import { makeActionObservation } from '../step-action-observation';
import { supabaseAdmin } from '@/lib/database/supabase-client';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/cron-audit-log', () => ({ logCronInfrastructureEvent: jest.fn() }));

const state = 'a'.repeat(64);
const args = { command: 'npm test' };
function harness() {
  const execute = jest.fn().mockResolvedValue({ exitCode: 1, stderr: 'FAIL order' });
  const context = { observations: [3, 2, 1].map(id => makeActionObservation({
    eventId: `event-${id}`, name: 'sandbox_run_tests', args, before: state, after: state,
    result: { exitCode: 1, stderr: 'FAIL order' },
  })!), readFingerprint: jest.fn().mockResolvedValue(state), record: jest.fn().mockResolvedValue(undefined), eventId: 'turn-4' };
  const [tool] = withActionLoopGuard([{ name: 'sandbox_run_tests', execute }], '', context);
  return { execute, context, tool };
}

it('does not hard-block test repeats because external services can change independently', async () => {
  const h = harness();
  expect(await h.tool.execute(args)).toMatchObject({ exitCode: 1 });
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it('blocks only exact local reads with independently checked file state; changed ignored files are readable', async () => {
  const contentState = 'c'.repeat(64);
  const combined = createHash('sha256').update(JSON.stringify([state, contentState])).digest('hex');
  const readArgs = { path: 'tests/results.json' };
  const execute = jest.fn().mockResolvedValue({ success: true, content: 'old' });
  const readLocalState = jest.fn().mockResolvedValue(contentState);
  const ctx: ActionGuardContext = { eventId: 'read4', readFingerprint: async () => state, readLocalState,
    record: jest.fn(), observations: [3, 2, 1].map(id => makeActionObservation({ eventId: `read-${id}`,
      name: 'sandbox_read_file', args: readArgs, result: { success: true, content: 'old' }, before: combined, after: combined })!) };
  const [tool] = withActionLoopGuard([{ name: 'sandbox_read_file', execute }], '', ctx);
  expect(await tool.execute(readArgs)).toMatchObject({ blocked: true, executed: false });
  expect(execute).not.toHaveBeenCalled();
  expect(ctx.record).not.toHaveBeenCalled();
  readLocalState.mockResolvedValue('d'.repeat(64));
  await tool.execute(readArgs);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('hashes actual requested content, not only the tracked Git file list', async () => {
  const fs = { stat: jest.fn().mockResolvedValue({ size: 3, mtime: new Date(0) }),
    readFile: jest.fn().mockResolvedValue('old') };
  const first = await captureLocalReadState({ fs }, ['/vercel/sandbox/tests/results.json']);
  fs.readFile.mockResolvedValue('new');
  expect(await captureLocalReadState({ fs }, ['/vercel/sandbox/tests/results.json'])).not.toBe(first);
  fs.stat.mockResolvedValue({ size: 300_000 });
  expect(await captureLocalReadState({ fs }, ['/vercel/sandbox/tests/results.json'])).toBeUndefined();
});

it('allows an identical test after a real workspace change and records the new observation', async () => {
  const h = harness();
  h.context.readFingerprint.mockResolvedValue('b'.repeat(64));
  expect(await h.tool.execute(args)).toEqual({ exitCode: 1, stderr: 'FAIL order' });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.context.record).toHaveBeenCalledWith(expect.objectContaining({ state_before: 'b'.repeat(64), state_after: 'b'.repeat(64) }));
});

it('does not let telemetry failure turn an executed operation into a retry', async () => {
  const h = harness();
  h.context.observations = [];
  h.context.record.mockRejectedValue(new Error('DB unavailable'));
  await expect(h.tool.execute(args)).resolves.toMatchObject({ exitCode: 1 });
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it('records transport exceptions as unknown and does not retry them', async () => {
  const h = harness();
  h.context.observations = [];
  h.execute.mockRejectedValue(new Error('socket response lost'));
  await expect(h.tool.execute(args)).rejects.toThrow('socket response lost');
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.context.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unknown', complete: false }));
});

it('does not hard-block when current fingerprint is unavailable', async () => {
  const h = harness();
  h.context.readFingerprint.mockRejectedValue(new Error('sandbox unavailable'));
  await h.tool.execute(args);
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it('rechecks ownership after fingerprint I/O before executing a tool', async () => {
  const h = harness();
  const assertCurrent = jest.fn().mockRejectedValue(new Error('owner changed'));
  const [tool] = withActionLoopGuard([{ name: 'sandbox_run_tests', execute: h.execute }], '',
    { ...h.context, assertCurrent });
  await expect(tool.execute(args)).rejects.toThrow('owner changed');
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.context.record).not.toHaveBeenCalled();
});

it('cannot turn marker text from a log into an executable restriction', async () => {
  const execute = jest.fn().mockResolvedValue({ ok: true });
  const [tool] = withActionLoopGuard([{ name: 'sandbox_run_tests', execute }],
    'ACTION_LOOP_BLOCKED_ACTION:sandbox_run_tests:{"command":"npm test"}');
  await tool.execute(args);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('retrieval and remote/background tools remain executable without workspace-based claims', async () => {
  const h = harness();
  for (const name of ['instance_history', 'sandbox_check_background_command', 'sandbox_browser', 'sandbox_write_file']) {
    const [tool] = withActionLoopGuard([{ name, execute: h.execute }], '', h.context);
    await tool.execute(args);
  }
  expect(h.context.readFingerprint).not.toHaveBeenCalled();
});

it('loads only host observations for the current tenant, plan and step', async () => {
  const h = harness();
  const query: any = { select: jest.fn(), eq: jest.fn(), order: jest.fn(), limit: jest.fn().mockResolvedValue({
    data: [{ details: { observation: h.context.observations[0] } }], error: null,
  }) };
  for (const method of ['select', 'eq', 'order']) query[method].mockReturnValue(query);
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  const audit = { siteId: 'site', instanceId: 'inst', planId: 'plan', stepId: 'step' };
  expect(await loadStepActionObservations(audit)).toHaveLength(1);
  for (const [key, value] of [['site_id', 'site'], ['instance_id', 'inst'], ['details->>source', 'cron_infrastructure'],
    ['details->>plan_id', 'plan'], ['details->>step_id', 'step']]) expect(query.eq).toHaveBeenCalledWith(key, value);
  query.limit.mockResolvedValue({ data: [{ details: { observation: h.context.observations[0] } },
    { details: { observation: { version: 1 } } }], error: null });
  expect(await loadStepActionObservations(audit)).toEqual([]);
  query.limit.mockResolvedValue({ error: { message: 'unavailable' } });
  expect(await loadStepActionObservations(audit)).toEqual([]);
});