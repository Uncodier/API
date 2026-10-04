import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { recoveryDatabase, scope } from '@/lib/services/robot-instance/test-support/assistant-recovery-fixture';

let db: ReturnType<typeof recoveryDatabase>;
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (table: string) => db.from(table) } }));
let tools: typeof import('../conversation-recovery-tools');
beforeAll(async () => { tools = await import('../conversation-recovery-tools'); });
beforeEach(() => {
  db = recoveryDatabase();
  db.tables.instance_plans = [{ id: 'plan-1', instance_id: scope.instanceId, site_id: scope.siteId,
    title: 'Repair storage', status: 'pending', metadata: { requirement_id: 'req-1' }, steps_completed: 0, steps_total: 2 }];
  db.tables.requirements = [{ id: 'req-1', site_id: scope.siteId, title: 'Product roadmap', status: 'blocked',
    metadata: { execution_hold: { kind: 'migration_platform_review', reason: 'Diagnostic missing required fields' } } }];
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('conversation-only status capability', () => {
  it('returns current blocked state without exposing any executable or routed tool', async () => {
    const before = JSON.stringify(db.tables);
    const available = tools.getConversationRecoveryTools(scope);
    expect(available.map(tool => tool.name)).toEqual(['conversation_status']);
    const result = await available[0].execute({ action: 'status' });
    expect(result).toMatchObject({ success: true, read_only: true, managed_work_resumed: false,
      plans: [{ id: 'plan-1', status: 'pending', steps_completed: 0 }],
      requirements: [{ id: 'req-1', status: 'blocked' }] });
    expect(result.requirements[0].execution_hold).toContain('migration_platform_review');
    expect(JSON.stringify(db.tables)).toBe(before);
    expect(db.writes()).toEqual([]);
    expect(db.queries.every(query => query.filters.some(filter => filter.column === 'site_id' && filter.value === scope.siteId))).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'execute_step' }, { action: 'update' }, { action: 'status', requirement_id: 'foreign' },
    { action: 'status', sql: 'select 1' }, { action: 'status', site_id: 'foreign' },
    { action: 'status', name: 'sandbox', args: { command: 'anything' } }, {}, null,
  ])('rejects arguments that could widen the read-only scope: %j', async input => {
    expect(await tools.getConversationRecoveryTools(scope)[0].execute(input)).toMatchObject({ success: false });
    expect(db.queries).toEqual([]);
  });

  it('omits other instances and other tenants even when a plan contains a foreign requirement ID', async () => {
    db.tables.instance_plans.push({ id: 'foreign-plan', site_id: 'other', instance_id: scope.instanceId, metadata: { requirement_id: 'req-foreign' } },
      { id: 'other-instance-plan', site_id: scope.siteId, instance_id: 'other', metadata: { requirement_id: 'req-other' } });
    db.tables.instance_plans[0].metadata.requirement_id = 'req-foreign';
    db.tables.requirements.push({ id: 'req-foreign', site_id: 'other', title: 'Must not disclose', status: 'blocked' });
    const result = await tools.getConversationRecoveryTools(scope)[0].execute({ action: 'status' });
    expect(result.plans).toHaveLength(1);
    expect(result.requirements).toEqual([]);
    expect(result.missing_requirement_ids).toEqual(['req-foreign']);
    expect(JSON.stringify(result)).not.toContain('Must not disclose');
  });

  it('redacts hold credentials and never includes unrelated metadata', async () => {
    const sensitive = randomBytes(24).toString('hex');
    db.tables.requirements[0].metadata.execution_hold.secret = sensitive;
    db.tables.requirements[0].metadata.private_provider_data = sensitive;
    const result = await tools.getConversationRecoveryTools(scope)[0].execute({ action: 'status' });
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(JSON.stringify(result)).not.toContain('private_provider_data');
    expect(result.requirements[0].execution_hold).toContain('migration_platform_review');
  });

  it('reports unavailable reads without implying the hold was cleared', async () => {
    db.error = { message: 'Private connection failure' };
    const result = await tools.getConversationRecoveryTools(scope)[0].execute({ action: 'status' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('do not infer');
    expect(JSON.stringify(result)).not.toContain('Private connection');
    expect(db.writes()).toEqual([]);
  });

  it('never treats a missing requirement read as permission to resume', async () => {
    db.beforeQuery = query => { if (query.table === 'requirements') db.error = { message: 'unavailable' }; };
    expect(await tools.getConversationRecoveryTools(scope)[0].execute({ action: 'status' })).toMatchObject({ success: false });
  });
});