import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { evaluateHandoff, sampleHandoff, main } from '../../scripts/harness-requirement-handoff.mjs';

const scope = { siteId: randomUUID(), userId: randomUUID(), requirementId: randomUUID() };
const hash = text => createHash('sha256').update(text).digest('hex');
function samples() {
  const baseline = { schemaVersion: 1, ...scope, type: 'develop', revision: 0,
    observedAt: '2026-11-01T00:00:00Z', receiptFingerprints: [hash('old')] };
  const actionId = randomUUID();
  const current = { ...baseline, revision: 1, actionId, actionCompleted: true,
    observedAt: '2026-11-01T00:01:00Z', command: { actionId, revision: 1, appliedAt: '2026-11-01T00:00:20Z' },
    sessionId: randomUUID(), sessionUpdatedAt: '2026-11-01T00:00:45Z', receiptFingerprints: [hash('old'), hash('new')] };
  return { baseline, current };
}
test('fresh workspace execution passes liveness, never delivery or overall E2E health', () => {
  const { baseline, current } = samples();
  const report = evaluateHandoff(baseline, current);
  assert.equal(report.passed, true);
  assert.equal(report.healthGreen, false);
  assert.equal(report.deliveryVerified, false);
});
for (const [name, patch] of [
  ['request received only', { command: null, sessionId: null, receiptFingerprints: [] }],
  ['command applied with no harness mapping', { sessionId: null, sessionUpdatedAt: null, receiptFingerprints: [] }],
  ['submitting conversation unfinished', { actionCompleted: false }],
  ['old successful transcript reused', { receiptFingerprints: [hash('old')] }],
  ['old completed session reused', { sessionUpdatedAt: '2026-10-01T00:00:00Z' }],
  ['wrong tenant', { siteId: randomUUID() }],
  ['wrong requirement', { requirementId: randomUUID() }],
  ['synthetic task substituted for develop', { type: 'task' }],
  ['deadline exceeded', { observedAt: '2026-11-01T00:06:00Z' }],
]) test(`rejects ${name}`, () => {
  const { baseline, current } = samples();
  assert.equal(evaluateHandoff(baseline, { ...current, ...patch }).passed, false);
});

function client(rows, trace) {
  return { from(table) {
    trace.push([table, 'select']);
    const query = { select() { return query; }, eq(key, value) { trace.push([table, key, value]); return query; },
      order() { return query; }, limit() { return query; },
      async maybeSingle() { return { data: rows[table] ?? null, error: null }; } };
    return query;
  } };
}
test('observer reads applied develop command with no mapping without inventing execution', async () => {
  const actionId = randomUUID(), trace = [];
  const rows = {
    requirements: { id: scope.requirementId, site_id: scope.siteId, user_id: scope.userId,
      type: 'develop', external_user_action_revision: 1, last_external_user_action_id: actionId },
    requirement_commands: { revision: 1, action_id: actionId, applied_at: '2026-11-01T00:00:20Z' },
    instance_logs: { id: actionId, trusted_user_action: true, log_type: 'user_action', details: { status: 'completed' } },
  };
  const sample = await sampleHandoff(client(rows, trace), scope, new Date('2026-11-01T00:06:00Z'));
  assert.equal(sample.actionCompleted, true);
  assert.equal(sample.sessionId, null);
  assert.deepEqual(sample.receiptFingerprints, []);
  assert.equal(trace.some(([table]) => table === 'harness_sessions'), false);
  for (const table of ['requirements', 'requirement_commands', 'instance_logs', 'harness_requirement_runs']) {
    assert.ok(trace.some(item => item[0] === table && item[1] === 'site_id' && item[2] === scope.siteId));
  }
  const report = evaluateHandoff(samples().baseline, sample);
  assert.equal(report.state, 'timed_out');
  assert.equal(report.passed, false);
});
test('observer refuses mismatched session ownership before evaluating transcript', async () => {
  const sessionId = randomUUID(), trace = [];
  const rows = {
    requirements: { id: scope.requirementId, site_id: scope.siteId, user_id: scope.userId },
    harness_requirement_runs: { requirement_id: scope.requirementId, site_id: scope.siteId, session_id: sessionId },
    harness_sessions: { id: sessionId, site_id: scope.siteId, user_id: randomUUID(), snapshot: {} },
  };
  await assert.rejects(sampleHandoff(client(rows, trace), scope), /ownership mismatch/);
});
test('an arbitrary successful read or finish_task is not workspace execution', async () => {
  const sessionId = randomUUID(), actionId = randomUUID(), trace = [];
  const messages = ['read_files', 'finish_task', 'exec'].flatMap((name, index) => [
    { role: 'assistant', toolCalls: [{ id: String(index), name }] },
    { role: 'tool', toolCallId: String(index), content: JSON.stringify({ ok: true, output: { exitCode: 7 } }) },
  ]);
  const rows = {
    requirements: { id: scope.requirementId, site_id: scope.siteId, user_id: scope.userId,
      type: 'develop', external_user_action_revision: 1, last_external_user_action_id: actionId },
    harness_requirement_runs: { requirement_id: scope.requirementId, site_id: scope.siteId, session_id: sessionId },
    harness_sessions: { id: sessionId, site_id: scope.siteId, user_id: scope.userId,
      snapshot: { id: sessionId, request: { requirementId: scope.requirementId }, messages } },
  };
  const sample = await sampleHandoff(client(rows, trace), scope);
  assert.deepEqual(sample.receiptFingerprints, []);
  assert.equal(JSON.stringify(sample).includes('finish_task'), false);
});
test('CLI rejects missing read-only acknowledgement before connecting', async () => {
  await assert.rejects(main(['baseline', '/tmp/unused-baseline.json'], {}), /Usage/);
});
test('CLI rejects relative baseline paths before connecting', async () => {
  await assert.rejects(main(['baseline', 'relative.json', '--ack-private-read-only'], {}), /absolute/);
});
test('CLI rejects missing explicit tenant and owner before connecting', async () => {
  await assert.rejects(main(['check', '/tmp/unused-baseline.json', '--ack-private-read-only'], {}), /UUIDs/);
});
test('CLI rejects a mismatched database project before connecting', async () => {
  await assert.rejects(main(['check', '/tmp/unused-baseline.json', '--ack-private-read-only'], {
    HARNESS_E2E_SITE_ID: scope.siteId, HARNESS_E2E_USER_ID: scope.userId, HARNESS_E2E_REQUIREMENT_ID: scope.requirementId,
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', HARNESS_E2E_PROJECT_REF: 'other',
  }), /configuration unavailable/);
});