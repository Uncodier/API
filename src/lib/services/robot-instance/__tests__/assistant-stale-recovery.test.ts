import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execution, recoveryDatabase, scope, seedRecoveryNodes } from '../test-support/assistant-recovery-fixture';
import { IN_FLIGHT_STALL_MS } from '../assistant-respawn-policy';

let database: ReturnType<typeof recoveryDatabase>;
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: (table: string) => database.from(table) },
}));
let recovery: typeof import('../assistant-recovery');
beforeAll(async () => { recovery = await import('../assistant-recovery'); });
const now = Date.parse('2026-10-03T02:00:00Z');
const messages = [{ role: 'user', content: 'Archive the remaining draft sequences' }];
const staleOptions = { allowStaleInFlight: true };
beforeEach(() => {
  database = recoveryDatabase();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected live request'));
});
afterEach(() => { jest.restoreAllMocks(); });

async function ready() {
  await recovery.initializeAssistantRecovery(scope, execution);
  await recovery.markAssistantRecoveryInFlight(scope, messages);
}
function expire(age = IN_FLIGHT_STALL_MS) {
  database.snapshot().inFlightSince = new Date(now - age).toISOString();
  database.snapshot().lastActivityAt = new Date(now - age).toISOString();
}
function toolLog(extra: Record<string, unknown> = {}) {
  return { id: 'tool-log', instance_id: scope.instanceId, site_id: scope.siteId, log_type: 'tool_call',
    trusted_user_action: false, created_at: new Date(now - IN_FLIGHT_STALL_MS).toISOString(),
    tool_name: 'content', tool_args: { action: 'update', content_id: 'draft-1', status: 'archived' },
    tool_result: {}, ...extra };
}

describe('expired in-flight turns resume the agent, not the tool', () => {
  it('preserves the original messages, takes one generation and includes uncertain last-tool context', async () => {
    await ready(); expire(); database.tables.instance_logs.push(toolLog());
    const claim = await recovery.claimAssistantRecovery(scope, staleOptions);
    expect(claim.snapshot).toMatchObject({ messages, inFlight: false, respawnCount: 1 });
    expect(claim.snapshot.interruptionContext).toContain('draft-1');
    expect(claim.snapshot.interruptionContext).toContain('may have succeeded even if its result is missing');
    expect(claim.snapshot.messages).toEqual(messages); // No invented tool replies.
    expect(database.writes().at(-1)?.filters).toContainEqual({ column: 'details->>status', value: 'running', operator: 'eq' });
    await expect(recovery.assertAssistantRecoveryActive(scope)).rejects.toMatchObject({ code: 'conflict' });
    await recovery.loadAssistantRecovery(scope, claim.resumeToken);
    await expect(recovery.checkpointAssistantRecovery(scope, { messages })).rejects.toMatchObject({ code: 'conflict' });
    await recovery.assertAssistantRecoveryActive({ ...scope, generation: 1 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('still refuses in-flight work without the explicit server-side stale policy', async () => {
    await ready(); expire();
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it.each([0, IN_FLIGHT_STALL_MS - 1, -60_000])('rejects fresh or future activity, age %i', async age => {
    await ready(); expire(age);
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'in_flight' });
    expect(database.snapshot().respawnCount).toBe(0);
  });

  it('rechecks latest logs even if the cron supplied an old snapshot', async () => {
    await ready(); expire();
    database.tables.instance_logs.push(toolLog({ created_at: new Date(now - 1000).toISOString() }));
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it('counts a recent streaming update on an old log as activity', async () => {
    await ready(); expire();
    database.tables.instance_logs.push(toolLog({ log_type: 'thinking',
      details: { last_activity_at: new Date(now - 1000).toISOString() } }));
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it('does not import another tenant or earlier action into recovery context', async () => {
    await ready(); expire();
    database.tables.instance_logs.push(toolLog({ site_id: 'other-site', message: 'foreign-tenant' }),
      toolLog({ created_at: '2020-01-01T00:00:00Z', message: 'prior-action' }), toolLog());
    const { snapshot } = await recovery.claimAssistantRecovery(scope, staleOptions);
    expect(snapshot.interruptionContext).not.toContain('foreign-tenant');
    expect(snapshot.interruptionContext).not.toContain('prior-action');
    expect(snapshot.interruptionContext).toContain('draft-1');
  });

  it('recovers a legacy first turn without timestamps/messages from the trusted original action', async () => {
    await recovery.initializeAssistantRecovery(scope, execution);
    database.snapshot().inFlight = true;
    database.tables.instance_logs.push(toolLog());
    const { snapshot } = await recovery.claimAssistantRecovery(scope, staleOptions);
    expect(snapshot.messages).toEqual([{ role: 'user', content: database.action().message }]);
    expect(snapshot.interruptionContext).toContain('draft-1');
  });

  it.each(['completed', 'cancelled', 'stopped', 'paused', 'failed'])('never resumes a %s action', async status => {
    await ready(); expire(); database.action().details.status = status;
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'inactive' });
  });

  it('rejects a superseded action and observes cancellation during CAS', async () => {
    await ready(); expire();
    database.beforeUpdate = () => { database.action().details.status = 'cancelled'; };
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'conflict' });
    database.action().details.status = 'running';
    database.tables.instance_logs.push({ ...database.action(), id: 'new-action', created_at: new Date(now).toISOString() });
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'inactive' });
  });

  it('allows exactly one simultaneous stale claimant and preserves recent progress racing the claim', async () => {
    await ready(); expire();
    const claims = await Promise.allSettled([recovery.claimAssistantRecovery(scope, staleOptions), recovery.claimAssistantRecovery(scope, staleOptions)]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(database.snapshot().respawnCount).toBe(1);
  });

  it('rejects the stale claim when the owner writes a newer revision during evidence lookup', async () => {
    await ready(); expire();
    database.beforeUpdate = () => {
      database.snapshot().revision = 'a599c3ec-cbbe-4078-829f-3beff8bb8c7f';
      database.snapshot().lastActivityAt = new Date(now).toISOString();
    };
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'conflict' });
    expect(database.snapshot().respawnCount).toBe(0);
  });

  it('does not bypass leases, respawn caps or plan-owned execution', async () => {
    await ready(); expire(); database.snapshot().inFlightKind = 'plan';
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'in_flight' });
    database.snapshot().inFlightKind = 'turn'; database.snapshot().respawnCount = 2;
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'limit' });
    database.snapshot().respawnCount = 0;
    database.snapshot().lease_token = 'a599c3ec-cbbe-4078-829f-3beff8bb8c7f';
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not guess whether a legacy in-flight checkpoint belonged to an active plan', async () => {
    await ready(); expire(); delete database.snapshot().inFlightKind;
    database.tables.instance_plans.push({ id: 'plan', instance_id: scope.instanceId, site_id: scope.siteId, status: 'in_progress' });
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it('retains previous uncertain evidence across checkpoints and another stale takeover', async () => {
    await ready(); expire(); database.tables.instance_logs.push(toolLog());
    const first = await recovery.claimAssistantRecovery(scope, staleOptions);
    await recovery.loadAssistantRecovery(scope, first.resumeToken);
    const resumedScope = { ...scope, generation: 1 };
    await recovery.markAssistantRecoveryInFlight(resumedScope, messages);
    await recovery.checkpointAssistantRecovery(resumedScope, { messages: [...messages, { role: 'assistant', content: 'Checking current state' }] });
    expect(database.snapshot().interruptionContext).toContain('draft-1');
    await recovery.markAssistantRecoveryInFlight(resumedScope, database.snapshot().messages);
    expire(); database.tables.instance_logs = [database.action()];
    const second = await recovery.claimAssistantRecovery(scope, staleOptions);
    expect(second.snapshot.interruptionContext).toContain('draft-1');
    expect(second.snapshot.respawnCount).toBe(2);
  });

  it('keeps in-flight canvas nodes out of heuristic takeover until their output writers are fenced', async () => {
    seedRecoveryNodes(database);
    await recovery.initializeAssistantRecovery(scope, { ...execution, instanceNodeId: 'target-1' });
    await recovery.checkpointAssistantRecovery(scope, { messages, continuation: { responseNodeIds: ['same-response'] } });
    await recovery.markAssistantRecoveryInFlight(scope, messages); expire();
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'in_flight' });
  });

  it('preserves a node binding and refuses changed node content after expiry', async () => {
    seedRecoveryNodes(database);
    await recovery.initializeAssistantRecovery(scope, { ...execution, instanceNodeId: 'target-1' });
    await recovery.checkpointAssistantRecovery(scope, { messages, continuation: { responseNodeIds: ['same-response'] } });
    await recovery.markAssistantRecoveryInFlight(scope, messages); expire();
    database.tables.instance_nodes[0].prompt = { text: 'Different request' };
    await expect(recovery.claimAssistantRecovery(scope, staleOptions)).rejects.toMatchObject({ code: 'context_changed' });
  });
});

describe('per-tool recovery evidence', () => {
  it('records start before executing and returned result before the turn checkpoint', async () => {
    await ready();
    const execute = jest.fn(async () => {
      expect(database.snapshot().toolObservations.at(-1).outcome).toBe('unknown');
      return { success: true, content_id: 'draft-1', status: 'archived' };
    });
    const result = await recovery.runAssistantRecoveryTool(scope, 'content', { content_id: 'draft-1' }, execute);
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(database.snapshot().inFlight).toBe(true);
    expect(database.snapshot().messages).toEqual(messages);
    expect(database.snapshot().toolObservations[0]).toMatchObject({ name: 'content', outcome: 'returned' });
    expire();
    const { snapshot } = await recovery.claimAssistantRecovery(scope, staleOptions);
    expect(snapshot.interruptionContext).toContain('draft-1');
    expect(snapshot.interruptionContext).toContain('returned');
  });

  it('records a thrown operation as uncertain and preserves the original exception', async () => {
    await ready(); const error = new Error('Connection lost after provider accepted');
    await expect(recovery.runAssistantRecoveryTool(scope, 'send', {}, async () => { throw error; })).rejects.toBe(error);
    expect(database.snapshot().toolObservations[0].outcome).toBe('threw');
  });

  it('does not run a tool if recording its start fails', async () => {
    await ready(); const execute = jest.fn(async () => 'sent');
    database.beforeUpdate = () => { database.action().details.status = 'cancelled'; };
    await expect(recovery.runAssistantRecoveryTool(scope, 'send', {}, execute)).rejects.toMatchObject({ code: 'conflict' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the unknown evidence when a successful effect cannot persist its returned result', async () => {
    await ready(); let effects = 0;
    await expect(recovery.runAssistantRecoveryTool(scope, 'send', {}, async () => {
      effects++;
      database.error = { message: 'Temporary database outage after provider accepted' };
      return { accepted: true };
    })).rejects.toMatchObject({ name: 'RecoveryError', code: 'conflict' });
    expect(effects).toBe(1);
    expect(database.snapshot().toolObservations[0].outcome).toBe('unknown');
    expect(database.snapshot().inFlight).toBe(true);
    expect(database.snapshot().messages).toEqual(messages);
    database.error = undefined; expire();
    const claim = await recovery.claimAssistantRecovery(scope, staleOptions);
    expect(claim.snapshot.interruptionContext).toContain('send');
    expect(claim.snapshot.interruptionContext).toContain('unknown');
  });

  it('retains an unknown result if the worker dies or loses ownership during the effect', async () => {
    await ready();
    await expect(recovery.runAssistantRecoveryTool(scope, 'send', {}, async () => {
      expire(); await recovery.claimAssistantRecovery(scope, staleOptions);
      return 'accepted';
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(database.snapshot().toolObservations[0].outcome).toBe('unknown');
    expect(database.snapshot().respawnCount).toBe(1);
  });

  it('bounds observations and clears them only when a complete turn checkpoint is saved', async () => {
    await ready();
    for (let i = 0; i < 10; i++) await recovery.runAssistantRecoveryTool(scope, 'content', { index: i }, async () => i);
    expect(database.snapshot().toolObservations).toHaveLength(8);
    await recovery.checkpointAssistantRecovery(scope, { messages });
    expect(database.snapshot().toolObservations).toBeUndefined();
    expect(database.snapshot().inFlight).toBe(false);
  });
});