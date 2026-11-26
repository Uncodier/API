import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execution, recoveryDatabase, scope } from '../test-support/assistant-recovery-fixture';
import { MAX_RECOVERY_MESSAGES_BYTES, MAX_RECOVERY_RESPAWNS } from '../assistant-recovery-schema';

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

  it('blocks fresh and previously claimed resumes for an explicitly linked interactive action', async () => {
    await recovery.initializeAssistantRecovery(scope,{...execution,callerSource:'interactive',catalogUserSession:true,executionMode:'direct'});
    await recovery.checkpointAssistantRecovery(scope,{messages:receipts});
    const explicit = `Compare /records/${randomUUID()}`;
    database.action().message = explicit;
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({code:'private_context_unavailable'});
    database.action().message = 'Unlinked user request';
    const claim = await recovery.claimAssistantRecovery(scope);
    database.action().message = explicit; // Simulate a lease issued by an earlier runtime.
    await expect(recovery.loadAssistantRecovery(scope,claim.resumeToken)).rejects.toMatchObject({code:'private_context_unavailable'});
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
  async function readyConversation() {
    const { instanceNodeId: _node, ...conversation } = execution;
    await recovery.initializeAssistantRecovery(scope, conversation);
    await recovery.checkpointAssistantRecovery(scope, { messages: receipts, continuation: { responseNodeIds: ['response-1'] } });
  }
  it('releases a settled no-tool turn while preserving prior receipts and continuation', async () => {
    await readyConversation();
    await recovery.markAssistantRecoveryInFlight(scope, receipts);
    await recovery.releaseFailedAssistantTurn(scope);
    expect(database.snapshot()).toMatchObject({ inFlight: false, messages: receipts, continuation: { responseNodeIds: ['response-1'] } });
    expect((await recovery.claimAssistantRecovery(scope)).snapshot.respawnCount).toBe(1);
  });
  it('rejects release based on persisted connector admission even if the live context lost it', async () => {
    await recovery.initializeAssistantRecovery(scope, { ...execution, callerSource: 'interactive', catalogUserSession: true });
    await recovery.markAssistantRecoveryInFlight(scope, receipts);
    await expect(recovery.releaseFailedAssistantTurn(scope)).rejects.toMatchObject({ code: 'in_flight' });
    expect(database.snapshot().inFlight).toBe(true);
    const expired = new Date(Date.now() - 60 * 60_000).toISOString();
    database.snapshot().lastActivityAt = database.snapshot().inFlightSince = expired;
    await expect(recovery.claimAssistantRecovery(scope, { allowStaleInFlight: true })).rejects.toMatchObject({ code: 'in_flight' });
    // An older release writer may already have cleared inFlight.
    database.snapshot().inFlight = false;
    database.snapshot().retryNotBefore = expired;
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it('rejects an old generation that wakes after another claim was consumed', async () => {
    await readyConversation();
    const claim = await recovery.claimAssistantRecovery({ ...scope, generation: 0 });
    await recovery.loadAssistantRecovery(scope, claim.resumeToken);
    await expect(recovery.claimAssistantRecovery({ ...scope, generation: 0 })).rejects.toMatchObject({ code: 'conflict' });
    expect(database.snapshot().respawnCount).toBe(1);
  });

  it('blocks maintenance and concurrent claims until the durable provider deadline', async () => {
    await readyConversation();
    await recovery.markAssistantRecoveryInFlight(scope, receipts);
    const deadline = Date.now() + 3600000;
    await recovery.releaseFailedAssistantTurn(scope, deadline);
    expect(database.snapshot().retryNotBefore).toBe(new Date(deadline).toISOString());
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'in_flight' });
    expect(database.snapshot().respawnCount).toBe(0);
    database.snapshot().retryNotBefore = new Date(Date.now() - 1000).toISOString();
    expect((await recovery.claimAssistantRecovery(scope)).snapshot.respawnCount).toBe(1);
  });

  it.each(['unknown', 'returned', 'threw'] as const)('never releases a failed turn after a tool %s observation', async outcome => {
    await readyConversation();
    await recovery.markAssistantRecoveryInFlight(scope, receipts);
    database.snapshot().toolObservations = [{ name: 'publish', args: '{}', outcome, observedAt: new Date().toISOString() }];
    await expect(recovery.releaseFailedAssistantTurn(scope)).rejects.toMatchObject({ code: 'in_flight' });
    expect(database.snapshot().inFlight).toBe(true);
  });

  it('rejects missing observations, plans, fan-outs, cancellation and stale owners', async () => {
    await readyConversation();
    await recovery.markAssistantRecoveryInFlight(scope, receipts);
    delete database.snapshot().toolObservations;
    await expect(recovery.releaseFailedAssistantTurn(scope)).rejects.toMatchObject({ code: 'in_flight' });
    database.snapshot().toolObservations = [];
    database.snapshot().inFlightKind = 'plan';
    await expect(recovery.releaseFailedAssistantTurn(scope)).rejects.toMatchObject({ code: 'in_flight' });
    database.snapshot().inFlightKind = 'turn';
    database.snapshot().execution.expectedResultsAmount = 2;
    await expect(recovery.releaseFailedAssistantTurn(scope)).rejects.toMatchObject({ code: 'in_flight' });
    database.snapshot().execution.expectedResultsAmount = 1;
    await expect(recovery.releaseFailedAssistantTurn({ ...scope, generation: 1 })).rejects.toMatchObject({ code: 'conflict' });
    database.action().details.status = 'cancelled';
    await expect(recovery.releaseFailedAssistantTurn(scope)).rejects.toMatchObject({ code: 'inactive' });
  });

  it('does not unlock node turns that can create or update response nodes outside tools', async () => {
    database.tables.instance_nodes.push({ id: 'node', instance_id: scope.instanceId, site_id: scope.siteId,
      type: 'prompt', parent_node_id: null, prompt: 'Publish', settings: {}, status: 'active' });
    await recovery.initializeAssistantRecovery(scope, { ...execution, instanceNodeId: 'node' });
    await recovery.checkpointAssistantRecovery(scope, { messages: receipts });
    await recovery.markAssistantRecoveryInFlight(scope, receipts);
    await expect(recovery.releaseFailedAssistantTurn(scope)).rejects.toMatchObject({ code: 'in_flight' });
  });
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

  it('rejects an empty checkpoint and caps claims persistently at five', async () => {
    expect(MAX_RECOVERY_RESPAWNS).toBe(5);
    await recovery.initializeAssistantRecovery(scope, execution);
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'missing' });
    await recovery.checkpointAssistantRecovery(scope, { messages: receipts });
    for (let generation = 1; generation <= MAX_RECOVERY_RESPAWNS; generation++) {
      const { resumeToken } = await recovery.claimAssistantRecovery(scope);
      const loaded = await recovery.loadAssistantRecovery(scope, resumeToken);
      expect(loaded.respawnCount).toBe(generation);
    }
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'limit' });
    expect(database.snapshot().respawnCount).toBe(5);
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
    [{ role: 'tool', content: 'x'.repeat(MAX_RECOVERY_MESSAGES_BYTES) }],
    [{ role: 'tool', content: undefined }],
    [{ role: 'tool', content: () => 'receipt' }],
  ])('rejects unsafe messages without losing the previous receipt or in-flight fence', async message => {
    await ready();
    await recovery.markAssistantRecoveryInFlight(scope);
    await expect(recovery.checkpointAssistantRecovery(scope, { messages: [message] })).rejects.toMatchObject({ code: 'invalid_state' });
    expect(database.snapshot().messages).toEqual(receipts);
    expect(database.snapshot().inFlight).toBe(true);
  });

  it('saves, claims and reloads a full 2 MiB transcript without losing tool receipts', async () => {
    const messages = [...receipts, { role: 'assistant', content: '' }];
    const overhead = Buffer.byteLength(JSON.stringify(messages));
    messages[messages.length - 1].content = 'x'.repeat(MAX_RECOVERY_MESSAGES_BYTES - overhead);
    expect(Buffer.byteLength(JSON.stringify(messages))).toBe(MAX_RECOVERY_MESSAGES_BYTES);
    await recovery.initializeAssistantRecovery(scope, execution);
    await recovery.markAssistantRecoveryInFlight(scope, receipts);
    await recovery.checkpointAssistantRecovery(scope, { messages });
    expect(database.snapshot().inFlight).toBe(false);
    const { resumeToken } = await recovery.claimAssistantRecovery(scope);
    const loaded = await recovery.loadAssistantRecovery(scope, resumeToken);
    expect(loaded.messages).toEqual(messages);
    expect(loaded.messages[2]).toEqual(receipts[2]);
    await recovery.assertAssistantRecoveryActive({ ...scope, generation: loaded.respawnCount });
    const write = database.writes().at(-1)!;
    expect(write.filters.some(filter => filter.column === 'details')).toBe(false);
    expect(write.filters.some(filter => filter.column === 'details->assistant_recovery->>revision')).toBe(true);
  });
});

it('never persists the live private wrapper arguments or reply at either checkpoint write', async () => {
  const privateText = randomBytes(24).toString('hex');
  const args = {action:'search',query:privateText}; // mixed discovery without an explicit account filter
  const answer = {success:true, query:privateText, tools:[{name:`connector:${privateText}`,account_label:privateText}]};
  const result = {success:true, result:{returned_count:17}, receipt:{url:`/connectors/results/${privateText}`}};
  const messages = [{role:'system',content:`Selected local account: ${privateText}`}, ...receipts,
    {role:'assistant',tool_calls:[{id:'private',type:'function',function:{name:'tools',arguments:JSON.stringify(args)}}]},
    {role:'tool',tool_call_id:'private',content:JSON.stringify(answer)},
    {role:'assistant',tool_calls:[{id:'inventory',type:'function',function:{name:'tools',arguments:JSON.stringify({action:'call',name:`connector:${privateText}:SUPABASE_LIST_TABLES`})}}]},
    {role:'tool',tool_call_id:'inventory',content:JSON.stringify(result)}];
  const original = JSON.stringify(messages);
  await recovery.initializeAssistantRecovery(scope, {...execution,callerSource:'interactive',catalogUserSession:true});
  await recovery.markAssistantRecoveryInFlight(scope, messages);
  await recovery.checkpointAssistantRecovery(scope, {messages});
  expect(JSON.stringify(database.writes())).not.toContain(privateText);
  const stored = database.snapshot().messages as any[];
  expect(stored.slice(0,3)).toEqual(receipts); // native tool evidence remains exact
  expect(JSON.parse(stored[3].tool_calls[0].function.arguments)).toEqual({action:'search',private_arguments:true});
  expect(stored[4]).toMatchObject({tool_call_id:'private',content:expect.stringContaining('not an execution receipt')});
  expect(stored[6]).toMatchObject({tool_call_id:'inventory',content:expect.stringContaining('not an execution receipt')});
  expect(JSON.stringify(database.writes())).not.toContain('returned_count');
  expect(JSON.stringify(messages)).toBe(original);
});

it('excludes the answer and all derived follow-up content from shared recovery state', async () => {
  const text = randomBytes(24).toString('hex');
  const connector = randomUUID(), claim = randomUUID();
  const messages = [{role:'user',content:'Show my numbers'},
    {role:'assistant',tool_calls:[{id:'sql',type:'function',function:{name:'tools',arguments:JSON.stringify({action:'call',name:`connector:${connector}:SUPABASE_RUN_READ_ONLY_QUERY`})}}]},
    {role:'tool',tool_call_id:'sql',content:JSON.stringify({success:true,result_visibility:'ask_owner',result_connector_id:connector,result_claim_id:claim,result:{rows:[{label:text}]}})},
    {role:'assistant',content:`Derived from ${text}`,reasoning_details:[{text}]}];
  const original = JSON.stringify(messages);
  await recovery.initializeAssistantRecovery(scope,{...execution,callerSource:'interactive',catalogUserSession:true});
  await recovery.markAssistantRecoveryInFlight(scope,messages);
  await recovery.runAssistantRecoveryTool(scope,'tools',{action:'search',query:text},async () => ({result:text}),true);
  await recovery.checkpointAssistantRecovery(scope,{messages});
  expect(JSON.stringify(database.writes())).not.toContain(text);
  expect(JSON.stringify(database.writes())).not.toContain(claim);
  expect(database.snapshot().messages).toEqual([{role:'user',content:'Show my numbers'},
    {role:'assistant',content:expect.stringContaining('Do not replay')}]);
  expect(JSON.stringify(messages)).toBe(original);
});
