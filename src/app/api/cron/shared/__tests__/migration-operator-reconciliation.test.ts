import { createHash, randomBytes } from 'node:crypto';
import {
  applyMigrationReconciliation, inspectMigrationReconciliation, MISSING_MIGRATION_PLAN_REASON,
  reconciliationInputSchema, resumeMigrationReconciliation,
} from '@/lib/services/apps-platform/migration-operator-reconciliation';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const reqId = '00000000-0000-4000-8000-000000000001';
const instanceId = '00000000-0000-4000-8000-000000000002';
const planId = '00000000-0000-4000-8000-000000000003';
const requestId = '00000000-0000-4000-8000-000000000004';
const tenantId = '00000000-0000-4000-8000-000000000005';
const siteId = '00000000-0000-4000-8000-000000000006';
const sql = 'CREATE TABLE users (id uuid PRIMARY KEY);';
const input = { requirementId: reqId, instanceId, planId, requestId, stepId: 'step_1',
  file: 'migrations/0001.sql', operatorId: 'operator-1', reason: 'Review changed specification; pending SQL only.' };
const now = new Date('2026-10-02T00:00:00Z');

function fixture() {
  const tables: Record<string, any> = {
    requirements: { id: reqId, site_id: siteId, status: 'blocked', cron_lock_active: false,
      instructions: 'Members can read their own records.', updated_at: now.toISOString(), backlog_revision: 15,
      metadata: { runner_instance_id: instanceId }, backlog: { items: [{ id: 'base', status: 'pending', attempts: 0 }] } },
    requirement_migration_lifecycle: { requirement_id: reqId, file: input.file, version: 10, state: 'platform_review',
      attempts: 5, checksum: hash(sql), specification_checksum: hash('Old specification'), original_sql: sql,
      reason: MISSING_MIGRATION_PLAN_REASON, review: { decision: 'request_changes' }, updated_at: now.toISOString() },
    instance_plans: { id: planId, instance_id: instanceId, site_id: siteId, status: 'in_progress',
      metadata: { requirement_id: reqId }, steps: [{ id: 'step_1', status: 'pending', requires_sandbox: true, backlog_item_id: 'base' }] },
    remote_instances: { id: instanceId, site_id: siteId, status: 'running', is_archived: false },
    requirement_migration_diagnostics: null,
    requirement_migration_reconciliation_resumes: null,
    apps_tenants: { requirement_id: reqId, site_id: siteId, tenant_id: tenantId, schema: 'app_000000000000400080000000', status: 'active' },
  };
  const errors: Record<string, boolean> = {};
  const from = jest.fn((table: string) => {
    const chain: any = {};
    for (const method of ['select', 'eq']) chain[method] = jest.fn(() => chain);
    chain.single = chain.maybeSingle = jest.fn(async () => ({ data: tables[table], error: errors[table] ? { code: 'failure' } : null }));
    return chain;
  });
  const rpc = jest.fn(async () => ({ data: null, error: null } as any));
  const capabilities = { version: 1, requirement_id: reqId, tenant_id: tenantId, schema: tables.apps_tenants.schema,
    identity: { user_id: `${tables.apps_tenants.schema}._app_current_user_id`,
      claims: `${tables.apps_tenants.schema}._app_request_claims`, backend: `${tables.apps_tenants.schema}._app_is_backend_request` },
    storage: { available: false, bucket: null }, backend: { role: 'authenticated', bypasses_rls: false, operations: [] } };
  const appsRpc = jest.fn(async (name: string) => ({ data: name === 'apps_get_tenant_capabilities' ? capabilities : { found: false }, error: null } as any));
  const deps = { makinari: { from, rpc } as any, apps: { from, rpc: appsRpc } as any,
    appsProjectRef: 'a'.repeat(20), now: () => now, readMigration: jest.fn(async () => Buffer.from(sql)) };
  return { tables, errors, rpc, appsRpc, capabilities, deps };
}

it('collects tenant-bound ledger and exact workspace evidence without mutations', async () => {
  const h = fixture();
  const result = await inspectMigrationReconciliation(input, h.deps);
  expect(result.evidence).toMatchObject({ receipt_found: false, sql_checksum: hash(sql),
    specification_checksum: hash(h.tables.requirements.instructions), tenant_id: tenantId,
    sandbox_name: 'req-00000000-00000000' });
  expect(h.appsRpc).toHaveBeenCalledWith('apps_get_migration_receipt', {
    p_target_schema: h.tables.apps_tenants.schema, p_expected_tenant_id: tenantId, p_migration_key: `migration:${input.file}`,
  });
  expect(h.rpc).not.toHaveBeenCalled();
});

it.each([
  ['manual pause', (h: any) => { h.tables.remote_instances.status = 'paused'; }],
  ['active lease', (h: any) => { h.tables.requirements.cron_lock_active = true; }],
  ['unexpired lease', (h: any) => { h.tables.requirements.cron_lock_expires_at = '2026-10-02T01:00:00Z'; }],
  ['another owner', (h: any) => { h.tables.requirements.metadata.runner_instance_id = planId; }],
  ['foreign plan', (h: any) => { h.tables.instance_plans.site_id = tenantId; }],
  ['disabled sandbox', (h: any) => { h.tables.instance_plans.steps[0].requires_sandbox = false; }],
  ['trailing cancelled step', (h: any) => { h.tables.instance_plans.steps.push({ id: 'tail', status: 'cancelled' }); }],
  ['stale correction assignment', (h: any) => { h.tables.instance_plans.steps[0].metadata = { migration_correction_key: 'old' }; }],
  ['stale diagnostic assignment', (h: any) => { h.tables.instance_plans.steps[0].metadata = { migration_diagnostic_token: requestId }; }],
  ['blocked item', (h: any) => { h.tables.requirements.backlog.items[0].blocked_by = [{}]; }],
  ['dependency', (h: any) => { h.tables.requirements.backlog.items[0].depends_on = ['unfinished']; }],
  ['consumed diagnostic', (h: any) => { h.tables.requirement_migration_diagnostics = { state: 'exhausted' }; }],
  ['unknown diagnostic', (h: any) => { h.errors.requirement_migration_diagnostics = true; }],
  ['security hold', (h: any) => { h.tables.requirement_migration_lifecycle.reason = 'Security review required'; }],
  ['approval', (h: any) => { h.tables.requirement_migration_lifecycle.review = { decision: 'approved_for_validation' }; }],
  ['same spec', (h: any) => { h.tables.requirement_migration_lifecycle.specification_checksum = hash(h.tables.requirements.instructions); }],
  ['tenant mismatch', (h: any) => { h.tables.apps_tenants.site_id = tenantId; }],
])('denies %s before any mutation', async (_name, change) => {
  const h = fixture(); change(h);
  await expect(inspectMigrationReconciliation(input, h.deps)).rejects.toThrow();
  expect(h.rpc).not.toHaveBeenCalled();
});

it.each([{ found: true, value: { checksum: hash(sql) } }, {}, { found: false, value: {} }, null])(
  'rejects applied, malformed or uncertain ledger receipts (%j)', async receipt => {
    const h = fixture(); h.appsRpc.mockImplementation(async name => ({ data: name === 'apps_get_tenant_capabilities' ? h.capabilities : receipt, error: null }));
    await expect(inspectMigrationReconciliation(input, h.deps)).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
  },
);

it('rejects SQL mismatch, ledger errors and unsafe file paths', async () => {
  const h = fixture(); h.deps.readMigration.mockResolvedValue(Buffer.from('SELECT 1;'));
  await expect(inspectMigrationReconciliation(input, h.deps)).rejects.toThrow('does not match');
  h.deps.readMigration.mockResolvedValue(Buffer.from(sql)); h.appsRpc.mockImplementation(async name => (
    name === 'apps_get_tenant_capabilities' ? { data: h.capabilities, error: null } : { data: { found: false }, error: { code: '42501' } }));
  await expect(inspectMigrationReconciliation(input, h.deps)).rejects.toThrow('receipt unavailable');
  expect(reconciliationInputSchema.safeParse({ ...input, file: 'migrations/../secret.sql' }).success).toBe(false);
});

it('rejects synthetic credentials in operator prose without accepting them into audit', () => {
  const sensitive = `Bearer ${randomBytes(24).toString('hex')}`;
  const parsed = reconciliationInputSchema.safeParse({ ...input, reason: sensitive });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.message).not.toContain(sensitive);
});

it('calls only the scoped audited RPC, preserving immutable SQL and attempts', async () => {
  const h = fixture(); const inspection = await inspectMigrationReconciliation(input, h.deps);
  h.rpc.mockResolvedValue({ data: { receipt_id: requestId, resumed: false, lifecycle: {
    ...inspection.prior, version: 11, state: 'correction_required', review: null,
    specification_checksum: inspection.evidence.specification_checksum,
  } }, error: null });
  expect(await applyMigrationReconciliation(inspection, h.deps)).toEqual({ receipt_id: requestId, state: 'correction_required', attempts: 5, resumed: false });
  expect(h.rpc).toHaveBeenCalledWith('reconcile_requirement_migration', expect.objectContaining({
    p_expected_version: 10, p_expected_execution_generation: 0, p_expected_backlog_revision: 15,
    p_request_id: requestId, p_evidence: inspection.evidence,
  }));
  h.rpc.mockResolvedValue({ data: { receipt_id: requestId, resumed: false, lifecycle: {
    ...inspection.prior, version: 11, state: 'correction_required', attempts: 0, review: null,
    specification_checksum: inspection.evidence.specification_checksum,
  } }, error: null });
  await expect(applyMigrationReconciliation(inspection, h.deps)).rejects.toThrow('Invalid reconciliation receipt');
});

it('resume rechecks remote evidence and calls the no-reset RPC; duplicate resume never starts work', async () => {
  const h = fixture();
  h.tables.requirement_migration_reconciliations = { id: requestId, requirement_id: reqId,
    instance_id: instanceId, execution_generation: 0, specification_checksum: hash(h.tables.requirements.instructions),
    prior_lifecycle: h.tables.requirement_migration_lifecycle, file: input.file,
    evidence: { tenant_id: tenantId, schema: h.tables.apps_tenants.schema, apps_project_ref: h.deps.appsProjectRef } };
  h.rpc.mockResolvedValue({ data: { receipt_id: requestId, resumed: true, execution_generation: 1 }, error: null });
  expect(await resumeMigrationReconciliation(reqId, requestId, h.deps)).toMatchObject({ resumed: true, execution_generation: 1 });
  expect(h.rpc).toHaveBeenCalledWith('resume_reconciled_requirement_migration', expect.objectContaining({
    p_requirement_id: reqId, p_receipt_id: requestId,
    p_evidence: expect.objectContaining({ receipt_found: false, observed_at: now.toISOString() }),
  }));
  h.tables.requirement_migration_reconciliation_resumes = { receipt_id: requestId, execution_generation: 1 };
  h.rpc.mockClear(); h.appsRpc.mockClear();
  expect(await resumeMigrationReconciliation(reqId, requestId, h.deps)).toMatchObject({ resumed: false, already_resumed: true });
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.appsRpc).not.toHaveBeenCalled();
});

it('resume refuses changed specification without taking the diagnostic or resetting counters', async () => {
  const h = fixture();
  h.tables.requirement_migration_reconciliations = { id: requestId, requirement_id: reqId, instance_id: instanceId,
    execution_generation: 0, specification_checksum: hash('different'), resumed_at: null };
  await expect(resumeMigrationReconciliation(reqId, requestId, h.deps)).rejects.toThrow('scope changed');
  expect(h.rpc).not.toHaveBeenCalled();
});

it('resume rejects a changed Apps tenant binding even when both ledger lookups say not applied', async () => {
  const h = fixture();
  h.tables.requirement_migration_reconciliations = { id: requestId, requirement_id: reqId, instance_id: instanceId,
    execution_generation: 0, specification_checksum: hash(h.tables.requirements.instructions),
    prior_lifecycle: h.tables.requirement_migration_lifecycle, file: input.file,
    evidence: { tenant_id: planId, schema: h.tables.apps_tenants.schema, apps_project_ref: h.deps.appsProjectRef } };
  await expect(resumeMigrationReconciliation(reqId, requestId, h.deps)).rejects.toThrow('tenant binding changed');
  expect(h.rpc).not.toHaveBeenCalled();
});

it('never timestamps a slow observation as fresh after collection completes', async () => {
  const h = fixture();
  let clock = now;
  h.deps.now = () => clock;
  h.deps.readMigration.mockImplementation(async () => {
    clock = new Date(now.getTime() + 6 * 60_000);
    return Buffer.from(sql);
  });
  await expect(inspectMigrationReconciliation(input, h.deps)).rejects.toThrow('Evidence collection expired');
  expect(h.rpc).not.toHaveBeenCalled();
});

it('preflights missing capabilities before spending the permanent diagnostic allowance', async () => {
  const h = fixture(); h.appsRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
  await expect(inspectMigrationReconciliation(input, h.deps)).rejects.toThrow('Tenant capabilities unavailable');
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.deps.readMigration).not.toHaveBeenCalled();
});

it('rejects specification or SQL that the independent diagnostic would redact', async () => {
  const h = fixture(); const sensitive = `Bearer ${randomBytes(24).toString('hex')}`;
  h.tables.requirements.instructions += ` ${sensitive}`;
  await expect(inspectMigrationReconciliation(input, h.deps)).rejects.toThrow('usable by the diagnostic');
  h.tables.requirements.instructions = 'Members own data.';
  const unsafeSql = `${sql}\n-- ${sensitive}`;
  h.tables.requirement_migration_lifecycle.checksum = hash(unsafeSql);
  h.deps.readMigration.mockResolvedValue(Buffer.from(unsafeSql));
  try { await inspectMigrationReconciliation(input, h.deps); throw new Error('Expected rejection'); }
  catch (error) { expect(String(error)).toContain('does not match'); expect(String(error)).not.toContain(sensitive); }
  expect(h.rpc).not.toHaveBeenCalled();
});