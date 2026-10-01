import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execution, recoveryDatabase, scope } from '../test-support/assistant-recovery-fixture';

let database: ReturnType<typeof recoveryDatabase>;
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: (table: string) => database.from(table) },
}));
let recovery: typeof import('../assistant-recovery');
beforeAll(async () => { recovery = await import('../assistant-recovery'); });
beforeEach(() => { database = recoveryDatabase(); });

const receipts = [
  { role: 'user', content: 'Publish the image' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'publish', arguments: '{"text":"hello"}' } }] },
  { role: 'tool', tool_call_id: 'call-1', content: '{"success":true,"post_id":"posted-once"}' },
];
async function ready() {
  await recovery.initializeAssistantRecovery(scope, execution);
  await recovery.checkpointAssistantRecovery(scope, { messages: receipts, continuation: { responseNodeIds: ['response-1'] } });
}

describe('trusted action lifecycle and CAS', () => {
  it.each([null, {}])('initializes missing status safely from %j', async details => {
    database.action().details = details;
    await recovery.initializeAssistantRecovery(scope, execution);
    expect(database.action().details).toEqual({ status: 'running', assistant_recovery: {
      version: 1, revision: expect.any(String), execution, messages: [], inFlight: false, respawnCount: 0,
    } });
    expect(database.writes()[0].filters).toContainEqual({ column: 'details->assistant_recovery', value: null, operator: 'is' });
    expect(database.writes()[0].filters).toContainEqual({ column: 'details->>status', value: null, operator: 'is' });
  });

  it('writes once, preserves unrelated details, and allows an identical pristine retry', async () => {
    await recovery.initializeAssistantRecovery(scope, { ...execution, systemPrompt: undefined });
    await recovery.initializeAssistantRecovery(scope, execution);
    expect(database.writes()).toHaveLength(1);
    expect(database.action().details.request_id).toBe('request-1');
    expect(database.writes()[0].filters).toEqual(expect.arrayContaining([
      { column: 'id', value: scope.userMessageLogId, operator: 'eq' },
      { column: 'instance_id', value: scope.instanceId, operator: 'eq' },
      { column: 'site_id', value: scope.siteId, operator: 'eq' },
      { column: 'user_id', value: scope.userId, operator: 'eq' },
      { column: 'log_type', value: 'user_action', operator: 'eq' },
      { column: 'trusted_user_action', value: true, operator: 'eq' },
      { column: 'details->assistant_recovery', value: null, operator: 'is' },
      { column: 'details->>status', value: 'running', operator: 'eq' },
    ]));
  });

  it('refuses to reset changed execution, progress, or in-flight effects', async () => {
    await recovery.initializeAssistantRecovery(scope, execution);
    await expect(recovery.initializeAssistantRecovery(scope, { ...execution, systemPrompt: 'different' })).rejects.toMatchObject({ code: 'conflict' });
    await recovery.markAssistantRecoveryInFlight(scope);
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'conflict' });
    await recovery.checkpointAssistantRecovery(scope, { messages: receipts });
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'conflict' });
    expect(database.snapshot().messages).toEqual(receipts);
  });

  it.each(['stopped', 'cancelled', 'completed', 'failed', 'paused', 'queued', null])('blocks every operation for status %s', async status => {
    await ready();
    database.action().details.status = status;
    const operations = [
      () => recovery.initializeAssistantRecovery(scope, execution),
      () => recovery.assertAssistantRecoveryActive(scope),
      () => recovery.markAssistantRecoveryInFlight(scope),
      () => recovery.checkpointAssistantRecovery(scope, { messages: receipts }),
      () => recovery.claimAssistantRecovery(scope),
      () => recovery.loadAssistantRecovery(scope, 'token'),
    ];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'inactive' });
    expect(database.writes()).toHaveLength(2);
  });

  it.each(['instanceId', 'siteId', 'userId', 'userMessageLogId'] as const)('does not infer a trusted scope when %s differs', async key => {
    await expect(recovery.initializeAssistantRecovery({ ...scope, [key]: 'foreign' }, execution)).rejects.toMatchObject({ code: 'missing' });
    expect(database.writes()).toHaveLength(0);
  });

  it.each([{ trusted_user_action: false }, { log_type: 'agent_action' }, { user_id: null }])('rejects nontrusted action %j', async change => {
    Object.assign(database.action(), change);
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'missing' });
    expect(database.writes()).toHaveLength(0);
  });

  it('rejects missing and malformed legacy state and status', async () => {
    await expect(recovery.assertAssistantRecoveryActive(scope)).rejects.toMatchObject({ code: 'missing' });
    database.action().details.assistant_recovery = { version: 1 };
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'invalid_state' });
    database.action().details = [];
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'invalid_state' });
    database.action().details = {};
    await expect(recovery.assertAssistantRecoveryActive(scope)).rejects.toMatchObject({ code: 'inactive' });
  });

  it('ignores untrusted/new other-site actions but blocks a newer trusted action by another user', async () => {
    await ready();
    database.tables.instance_logs.push({ ...database.action(), id: 'untrusted', trusted_user_action: false, created_at: '2026-10-01T00:00:00Z' });
    database.tables.instance_logs.push({ ...database.action(), id: 'other-site', site_id: 'foreign', created_at: '2026-10-01T00:00:00Z' });
    await recovery.assertAssistantRecoveryActive(scope);
    database.tables.instance_logs.push({ ...database.action(), id: 'newer', user_id: 'another-member', created_at: '2026-10-01T00:00:00Z' });
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'inactive' });
  });

  it.each(['cancelled', 'stopped', 'paused', 'completed'])('CAS cannot overwrite concurrent %s', async status => {
    await ready();
    database.beforeUpdate = () => { database.action().details.status = status; };
    await expect(recovery.markAssistantRecoveryInFlight(scope)).rejects.toMatchObject({ code: 'conflict' });
    expect(database.action().details.status).toBe(status);
    expect(database.snapshot().inFlight).toBe(false);
  });

  it('does not discard a concurrent revision-aware update or retry over it', async () => {
    await ready();
    database.beforeUpdate = () => {
      database.action().details.new_field = 'retain';
      database.snapshot().revision = 'bd1c7396-5551-487d-a24d-7e447d511c14';
    };
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'conflict' });
    expect(database.action().details.new_field).toBe('retain');
    expect(database.snapshot().respawnCount).toBe(0);
    expect(database.writes()).toHaveLength(3);
  });

  it('keeps CAS filters bounded for near-limit messages and rotates the revision on every write', async () => {
    await recovery.initializeAssistantRecovery(scope, execution);
    const firstRevision = database.snapshot().revision;
    await recovery.checkpointAssistantRecovery(scope, { messages: ['x'.repeat(500 * 1024)] });
    const secondRevision = database.snapshot().revision;
    expect(secondRevision).not.toBe(firstRevision);
    await recovery.markAssistantRecoveryInFlight(scope);
    expect(database.snapshot().revision).not.toBe(secondRevision);
    const filters = database.writes()[2].filters;
    expect(filters).toContainEqual({ column: 'details->assistant_recovery->>revision', operator: 'eq', value: secondRevision });
    expect(JSON.stringify(filters).length).toBeLessThan(1000);
  });

  it('rechecks cancellation and new actions immediately after CAS', async () => {
    await ready();
    database.afterUpdate = () => { database.action().details.status = 'cancelled'; };
    await expect(recovery.markAssistantRecoveryInFlight(scope)).rejects.toMatchObject({ code: 'inactive' });
    database.action().details.status = 'running';
    database.afterUpdate = () => database.tables.instance_logs.push({ ...database.action(), id: 'new', created_at: '2026-10-01' });
    await expect(recovery.checkpointAssistantRecovery(scope, { messages: receipts })).rejects.toMatchObject({ code: 'inactive' });
  });

  it('sanitizes DB errors and thrown failures', async () => {
    database.error = { message: 'secret database URL' };
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toEqual(new recovery.RecoveryError('conflict'));
    database.error = undefined;
    database.throwError = true;
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toEqual(new recovery.RecoveryError('conflict'));
  });
});

describe('checkpoint, token ownership, and effect fencing', () => {
  it('never replays ambiguous in-flight work and does permit current-owner tool guards', async () => {
    await ready();
    await recovery.markAssistantRecoveryInFlight(scope);
    await recovery.assertAssistantRecoveryActive(scope);
    await expect(recovery.markAssistantRecoveryInFlight(scope)).rejects.toMatchObject({ code: 'in_flight' });
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'in_flight' });
    await recovery.checkpointAssistantRecovery(scope, { messages: receipts });
    expect(database.snapshot()).toMatchObject({ messages: receipts, continuation: { responseNodeIds: ['response-1'] }, inFlight: false });
  });

  it('claims once, consumes only the exact token once, and fences the stale generation', async () => {
    await ready();
    const claim = await recovery.claimAssistantRecovery(scope);
    expect(claim).toMatchObject({ snapshot: { messages: receipts, inFlight: false, respawnCount: 1, lease_token: claim.resumeToken } });
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'conflict' });
    await expect(recovery.assertAssistantRecoveryActive(scope)).rejects.toMatchObject({ code: 'conflict' });
    await expect(recovery.markAssistantRecoveryInFlight(scope)).rejects.toMatchObject({ code: 'conflict' });
    await expect(recovery.checkpointAssistantRecovery(scope, { messages: [] })).rejects.toMatchObject({ code: 'conflict' });
    await expect(recovery.loadAssistantRecovery(scope, 'wrong-token')).rejects.toMatchObject({ code: 'conflict' });
    const snapshot = await recovery.loadAssistantRecovery(scope, claim.resumeToken);
    expect(snapshot.lease_token).toBeUndefined();
    expect(snapshot.messages).toEqual(receipts);
    await expect(recovery.loadAssistantRecovery(scope, claim.resumeToken)).rejects.toMatchObject({ code: 'conflict' });
    await expect(recovery.assertAssistantRecoveryActive(scope)).rejects.toMatchObject({ code: 'conflict' });
    await expect(recovery.markAssistantRecoveryInFlight(scope)).rejects.toMatchObject({ code: 'conflict' });
    await expect(recovery.checkpointAssistantRecovery(scope, { messages: [] })).rejects.toMatchObject({ code: 'conflict' });
    const resumed = { ...scope, generation: snapshot.respawnCount };
    await recovery.markAssistantRecoveryInFlight(resumed);
    await recovery.checkpointAssistantRecovery(resumed, { messages: [...receipts, { role: 'assistant', content: 'Done' }] });
    expect(database.snapshot().messages).toHaveLength(4);
  });

  it('rejects an empty checkpoint and caps claims persistently at two', async () => {
    await recovery.initializeAssistantRecovery(scope, execution);
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'missing' });
    await recovery.checkpointAssistantRecovery(scope, { messages: receipts });
    for (let generation = 1; generation <= 2; generation++) {
      const { resumeToken } = await recovery.claimAssistantRecovery(scope);
      const loaded = await recovery.loadAssistantRecovery(scope, resumeToken);
      expect(loaded.respawnCount).toBe(generation);
    }
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'limit' });
  });

  it('allows only one simultaneous claimant', async () => {
    await ready();
    const results = await Promise.allSettled([recovery.claimAssistantRecovery(scope), recovery.claimAssistantRecovery(scope)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(database.snapshot().respawnCount).toBe(1);
  });

  it('rejects in-flight token loads even with a matching persisted token', async () => {
    await ready();
    const claim = await recovery.claimAssistantRecovery(scope);
    database.snapshot().inFlight = true;
    await expect(recovery.loadAssistantRecovery(scope, claim.resumeToken)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it('never reclaims an ambiguous lease after wall-clock time passes', async () => {
    await ready();
    await recovery.claimAssistantRecovery(scope);
    database.action().created_at = '2000-01-01';
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'conflict' });
    expect(database.snapshot().respawnCount).toBe(1);
  });

  it.each([
    [{ role: 'tool', content: 'data:image/png;base64,AAAA' }],
    [{ role: 'tool', content: 'x'.repeat(512 * 1024) }],
    [{ role: 'tool', content: undefined }],
    [{ role: 'tool', content: () => 'receipt' }],
  ])('rejects unsafe messages without losing the previous receipt or in-flight fence', async message => {
    await ready();
    await recovery.markAssistantRecoveryInFlight(scope);
    await expect(recovery.checkpointAssistantRecovery(scope, { messages: [message] })).rejects.toMatchObject({ code: 'invalid_state' });
    expect(database.snapshot().messages).toEqual(receipts);
    expect(database.snapshot().inFlight).toBe(true);
  });
});