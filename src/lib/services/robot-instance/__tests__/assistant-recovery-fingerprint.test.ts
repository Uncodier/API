import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { recoveryDatabase, scope, seedRecoveryNodes } from '../test-support/assistant-recovery-fixture';

let database: ReturnType<typeof recoveryDatabase>;
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: (table: string) => database.from(table) },
}));
let recovery: typeof import('../assistant-recovery');
beforeAll(async () => { recovery = await import('../assistant-recovery'); });
beforeEach(() => { database = recoveryDatabase(); });

async function ready() {
  await recovery.initializeAssistantRecovery(scope, seedRecoveryNodes(database));
  await recovery.checkpointAssistantRecovery(scope, {
    messages: [{ role: 'user', content: 'Continue this node' }], continuation: { responseNodeIds: ['response-1'] },
  });
}

describe('node recovery fingerprint', () => {
  it('freezes the target and direct linked content without recording prompts in the fingerprint', async () => {
    await ready();
    expect(database.snapshot().nodeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await recovery.assertAssistantRecoveryActive(scope);
    const nodeQueries = database.queries.filter(query => query.table === 'instance_nodes');
    for (const query of nodeQueries) expect(query.filters).toEqual(expect.arrayContaining([
      { column: 'instance_id', value: scope.instanceId, operator: 'eq' },
      { column: 'site_id', value: scope.siteId, operator: 'eq' },
    ]));
  });

  it.each([
    ['target', 'type', 'response'], ['target', 'parent_node_id', 'new-parent'],
    ['target', 'prompt', { text: 'Changed task' }], ['target', 'settings', { model: 'video' }],
    ['context', 'type', 'prompt'], ['context', 'prompt', { text: 'Changed prompt' }],
    ['context', 'result', { text: 'Changed content' }], ['context', 'settings', { model: 'new' }],
  ])('blocks a changed %s %s at every recovery boundary', async (which, field, value) => {
    await ready();
    database.tables.instance_nodes[which === 'target' ? 0 : 1][field as string] = value;
    for (const operation of [
      () => recovery.assertAssistantRecoveryActive(scope),
      () => recovery.markAssistantRecoveryInFlight(scope),
      () => recovery.checkpointAssistantRecovery(scope, { messages: [] }),
      () => recovery.claimAssistantRecovery(scope),
      () => recovery.loadAssistantRecovery(scope, 'token'),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'context_changed' });
    expect(database.writes()).toHaveLength(2);
  });

  it.each(['target', 'context'])('rejects missing %s nodes during capture and restore', async which => {
    const execution = seedRecoveryNodes(database);
    const index = which === 'target' ? 0 : 1;
    database.tables.instance_nodes.splice(index, 1);
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'context_changed' });
    await ready();
    const claim = await recovery.claimAssistantRecovery(scope);
    database.tables.instance_nodes.splice(index, 1);
    await expect(recovery.loadAssistantRecovery(scope, claim.resumeToken)).rejects.toMatchObject({ code: 'context_changed' });
  });

  it.each([
    ['target', 'site_id'], ['target', 'instance_id'],
    ['context', 'site_id'], ['context', 'instance_id'],
  ])('rejects cross-tenant %s %s instead of silently dropping context', async (which, column) => {
    const execution = seedRecoveryNodes(database);
    database.tables.instance_nodes[which === 'target' ? 0 : 1][column] = 'foreign';
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'context_changed' });
    expect(database.writes()).toHaveLength(0);
  });

  it('rejects a foreign-site reference even if the referenced node is local', async () => {
    const execution = seedRecoveryNodes(database);
    database.tables.instance_node_contexts[0].site_id = 'foreign';
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'context_changed' });
  });

  it.each(['remove', 'add', 'type'])('detects %s changes to direct links', async change => {
    await ready();
    const refs = database.tables.instance_node_contexts;
    if (change === 'remove') refs.pop();
    if (change === 'add') {
      database.tables.instance_nodes.push({ ...database.tables.instance_nodes[1], id: 'context-2' });
      refs.push({ ...refs[0], context_node_id: 'context-2' });
    }
    if (change === 'type') refs[0].type = 'prompt';
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'context_changed' });
  });

  it('ignores status/timestamps/target result/UI positions and JSON key order', async () => {
    await ready();
    const target = database.tables.instance_nodes[0];
    const context = database.tables.instance_nodes[1];
    target.status = 'completed';
    target.updated_at = '2026-10-02';
    target.result = { text: 'New generated output' };
    target.settings = { ui_position: { x: 400, y: 200 }, model: 'image' };
    context.status = 'running';
    context.created_at = '2026-10-02';
    context.settings.ui_position = { x: 5, y: 6 };
    context.result = { outputs: [], text: 'Blue brand' };
    database.tables.instance_node_contexts[0].created_at = '2026-10-02';
    await recovery.assertAssistantRecoveryActive(scope);
  });

  it('treats direct links as an ordered-independent collection', async () => {
    const execution = seedRecoveryNodes(database);
    database.tables.instance_nodes.push({ ...database.tables.instance_nodes[1], id: 'context-2' });
    database.tables.instance_node_contexts.push({ ...database.tables.instance_node_contexts[0], context_node_id: 'context-2', type: 'prompt' });
    await recovery.initializeAssistantRecovery(scope, execution);
    database.tables.instance_node_contexts.reverse();
    database.tables.instance_nodes.reverse();
    await recovery.assertAssistantRecoveryActive(scope);
  });

  it.each([['target', 'stopped'], ['target', 'cancelled'], ['context', 'stopped'], ['context', 'cancelled']])(
    'explicitly blocks %s status %s although statuses are not hashed', async (which, status) => {
      await ready();
      database.tables.instance_nodes[which === 'target' ? 0 : 1].status = status;
      await expect(recovery.assertAssistantRecoveryActive(scope)).rejects.toMatchObject({ code: 'context_changed' });
    },
  );

  it('fails closed on reference read errors and malformed node context', async () => {
    const execution = seedRecoveryNodes(database);
    database.beforeQuery = query => {
      if (query.table === 'instance_node_contexts') database.error = { message: 'private URL' };
    };
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'context_changed' });
    database.error = undefined;
    database.beforeQuery = undefined;
    database.tables.instance_nodes[1].result = { image: 'data:image/png;base64,AA' };
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'context_changed' });
  });

  it('does not read any node data for non-node execution', async () => {
    await recovery.initializeAssistantRecovery(scope, { customTools: [], useSdkTools: true });
    await recovery.assertAssistantRecoveryActive(scope);
    expect(database.snapshot().nodeFingerprint).toBeUndefined();
    expect(database.queries.every(query => query.table === 'instance_logs')).toBe(true);
  });

  it('fingerprints implicit parent content and refuses foreign or missing parents', async () => {
    const execution = seedRecoveryNodes(database);
    database.tables.instance_nodes[0].parent_node_id = 'parent';
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'context_changed' });
    const parent: Record<string, any> = { ...database.tables.instance_nodes[1], id: 'parent', site_id: 'foreign' };
    database.tables.instance_nodes.push(parent);
    await expect(recovery.initializeAssistantRecovery(scope, execution)).rejects.toMatchObject({ code: 'context_changed' });
    parent.site_id = scope.siteId;
    await recovery.initializeAssistantRecovery(scope, execution);
    parent.result = { text: 'Changed parent content', outputs: [] };
    await expect(recovery.assertAssistantRecoveryActive(scope)).rejects.toMatchObject({ code: 'context_changed' });
  });

  it.each([undefined, [], ['r1', 'r2']])('rejects node claims without exactly one response identity: %j', async ids => {
    await recovery.initializeAssistantRecovery(scope, seedRecoveryNodes(database));
    await recovery.checkpointAssistantRecovery(scope, {
      messages: [{ role: 'user', content: 'Continue' }], ...(ids ? { continuation: { responseNodeIds: ids } } : {}),
    });
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('does not recover partial multi-result fanout from a single transcript', async () => {
    await recovery.initializeAssistantRecovery(scope, { ...seedRecoveryNodes(database), expectedResultsAmount: 2 });
    await recovery.checkpointAssistantRecovery(scope, {
      messages: [{ role: 'user', content: 'Continue' }], continuation: { responseNodeIds: ['r1'] },
    });
    await expect(recovery.claimAssistantRecovery(scope)).rejects.toMatchObject({ code: 'invalid_state' });
  });
});