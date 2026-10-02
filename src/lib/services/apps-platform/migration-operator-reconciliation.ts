import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseMigrationLifecycleRecord } from './migration-lifecycle';
import { sanitizeMigrationRepairContext } from './migration-repair-policy';
import { parseTenantCapabilities } from './tenant-capabilities';
import { requirementSandboxName } from '../sandbox-constants';

// Operator CLI only. Never import this module into model tools or public routes.
export const MISSING_MIGRATION_PLAN_REASON =
  'A pending migration has no requirement-bound implementation plan; technical review is required.';
const uuid = z.string().uuid();
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.string().max(512).regex(/^migrations\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$/)
  .refine(value => !/[\r\n]/.test(value));
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const diagnosticSafe = (text: string) => !/\[REDACTED(?:_[A-Z_]+)?\]/.test(text) && sanitizeMigrationRepairContext(text) === text;
const cleanText = (max: number) => z.string().trim().min(1).max(max)
  .refine(text => sanitizeMigrationRepairContext(text) === text, 'Do not include credentials');

export const reconciliationInputSchema = z.object({
  requirementId: uuid, instanceId: uuid, planId: uuid, stepId: z.string().min(1).max(200),
  file, requestId: uuid, operatorId: cleanText(200), reason: cleanText(2000),
}).strict();
export type ReconciliationInput = z.infer<typeof reconciliationInputSchema>;
export interface ReconciliationDependencies {
  makinari: SupabaseClient;
  apps: SupabaseClient;
  appsProjectRef: string;
  /** Reads the exact named workspace. No source creation or SQL execution. */
  readMigration: (sandboxName: string, path: string) => Promise<Buffer>;
  now?: () => Date;
}

async function one(query: PromiseLike<{ data: any; error: any }>, label: string): Promise<any> {
  const { data, error } = await query;
  if (error || !data) throw new Error(`${label} unavailable; reconciliation denied.`);
  return data;
}

function generation(metadata: any): number {
  const value = metadata?.requirement_execution_generation ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid execution generation.');
  return value;
}

function assertIdle(req: any, instance: any, plan: any, input: Pick<ReconciliationInput, 'requirementId' | 'instanceId' | 'stepId'>, now: Date) {
  if (req.status !== 'blocked' || req.cron_lock_active ||
      (req.cron_lock_expires_at && new Date(req.cron_lock_expires_at).getTime() > now.getTime()) ||
      req.metadata?.runner_instance_id !== input.instanceId || instance.site_id !== req.site_id ||
      instance.is_archived || !['pending', 'running'].includes(instance.status) ||
      plan.instance_id !== input.instanceId || plan.site_id !== req.site_id ||
      plan.metadata?.requirement_id !== input.requirementId ||
      !['pending', 'in_progress', 'active'].includes(plan.status)) {
    throw new Error('Requirement, owner or plan is not idle and eligible.');
  }
  const steps = Array.isArray(plan.steps) ? plan.steps.filter((s: any) => s.id === input.stepId) : [];
  const step = steps[0];
  const itemId = step?.backlog_item_id || step?.metadata?.backlog_item_id;
  const item = req.backlog?.items?.find((i: any) => i.id === itemId);
  const done = new Set(req.backlog?.items?.filter((i: any) => i.status === 'done').map((i: any) => i.id));
  const staleAssignmentKeys = ['migration_correction_key', 'migration_correction_run_id', 'migration_correction_files',
    'migration_diagnostic_token', 'migration_diagnostic_file', 'repair_run', 'repair_source_step_id'];
  if (steps.length !== 1 || plan.steps[plan.steps.length - 1]?.id !== input.stepId ||
      plan.steps.some((s: any) => s.id !== input.stepId && !['completed', 'cancelled'].includes(s.status)) ||
      staleAssignmentKeys.some(key => Object.prototype.hasOwnProperty.call(step.metadata || {}, key)) ||
      step.status !== 'pending' || step.requires_sandbox !== true ||
      !item || item.status !== 'pending' || item.review_quarantine?.active || item.blocked_by?.length ||
      item.depends_on?.some((id: string) => !done.has(id))) {
    throw new Error('The bound sandbox step/backlog item is not runnable.');
  }
}

async function observeUnapplied(input: Pick<ReconciliationInput, 'requirementId' | 'instanceId' | 'file'>,
  req: any, expectedSqlChecksum: string, deps: ReconciliationDependencies) {
  const observedAt = deps.now?.() || new Date();
  z.string().regex(/^[a-z]{20}$/).parse(deps.appsProjectRef);
  const tenant = await one(deps.apps.from('apps_tenants')
    .select('tenant_id,requirement_id,site_id,schema,status').eq('requirement_id', input.requirementId).single(), 'Apps tenant');
  const expectedSchema = `app_${input.requirementId.replace(/-/g, '').slice(0, 24)}`;
  if (tenant.requirement_id !== input.requirementId || tenant.site_id !== req.site_id ||
      tenant.status !== 'active' || tenant.schema !== expectedSchema || !uuid.safeParse(tenant.tenant_id).success) {
    throw new Error('Apps tenant scope mismatch.');
  }
  const capabilities = await one(deps.apps.rpc('apps_get_tenant_capabilities', {
    p_requirement_id: input.requirementId, p_expected_tenant_id: tenant.tenant_id,
  }), 'Tenant capabilities');
  parseTenantCapabilities(capabilities, { requirementId: input.requirementId, tenantId: tenant.tenant_id, schema: tenant.schema });
  const sandboxName = requirementSandboxName(input.requirementId, input.instanceId);
  const sql = await deps.readMigration(sandboxName, input.file);
  if (!Buffer.isBuffer(sql) || sql.length === 0 || sql.length > 65536 || hash(sql) !== expectedSqlChecksum ||
      !diagnosticSafe(sql.toString('utf8'))) {
    throw new Error('Workspace migration does not match the held SQL.');
  }
  // A transport error, missing RPC or malformed receipt never means "not applied".
  const receipt = await one(deps.apps.rpc('apps_get_migration_receipt', {
    p_target_schema: tenant.schema, p_expected_tenant_id: tenant.tenant_id,
    p_migration_key: `migration:${input.file}`,
  }), 'Apps migration receipt');
  if (receipt.found !== false || Object.keys(receipt).some(key => key !== 'found')) {
    throw new Error('Applied or uncertain SQL cannot use this recovery.');
  }
  const elapsed = (deps.now?.() || new Date()).getTime() - observedAt.getTime();
  if (elapsed < 0 || elapsed > 5 * 60_000) throw new Error('Evidence collection expired; collect a new observation.');
  return { apps_project_ref: deps.appsProjectRef, tenant_id: tenant.tenant_id, schema: tenant.schema,
    observed_at: observedAt.toISOString(), sql_checksum: expectedSqlChecksum,
    receipt_found: false as const, sandbox_name: sandboxName, specification_checksum: hash(req.instructions) };
}

/** Read-only preflight. SDK inspection may resume a stopped sandbox; the CLI stops it again. */
export async function inspectMigrationReconciliation(raw: ReconciliationInput, deps: ReconciliationDependencies) {
  const input = reconciliationInputSchema.parse(raw);
  const db = deps.makinari;
  const [req, rawLife, plan, instance, diagnostic] = await Promise.all([
    one(db.from('requirements').select('id,site_id,status,instructions,metadata,backlog,backlog_revision,updated_at,cron_lock_active,cron_lock_expires_at').eq('id', input.requirementId).single(), 'Requirement'),
    one(db.from('requirement_migration_lifecycle').select('*').eq('requirement_id', input.requirementId).eq('file', input.file).single(), 'Lifecycle'),
    one(db.from('instance_plans').select('id,site_id,instance_id,status,metadata,steps').eq('id', input.planId).single(), 'Plan'),
    one(db.from('remote_instances').select('id,site_id,status,is_archived').eq('id', input.instanceId).single(), 'Instance'),
    db.from('requirement_migration_diagnostics').select('state').eq('requirement_id', input.requirementId).eq('file', input.file).maybeSingle(),
  ]);
  const life = parseMigrationLifecycleRecord(rawLife);
  const now = deps.now?.() || new Date();
  assertIdle(req, instance, plan, input, now);
  if (life.requirement_id !== input.requirementId || life.file !== input.file ||
      life.state !== 'platform_review' || life.attempts !== 5 || life.reason !== MISSING_MIGRATION_PLAN_REASON ||
      diagnostic.error || diagnostic.data || (life.review && (typeof life.review !== 'object' ||
        (life.review as any).decision !== 'request_changes' || (life.review as any).binding))) {
    throw new Error('Not an eligible missing-plan hold with an unused diagnostic.');
  }
  if (typeof req.instructions !== 'string' || !req.instructions.trim() || Buffer.byteLength(req.instructions) > 65536 ||
      !diagnosticSafe(req.instructions) || hash(req.instructions) === life.specification_checksum) {
    throw new Error('A changed bounded specification usable by the diagnostic is required.');
  }
  const evidence = await observeUnapplied(input, req, life.checksum, deps);
  return { input, prior: life, evidence, expectedExecutionGeneration: generation(req.metadata),
    expectedUpdatedAt: req.updated_at as string, expectedBacklogRevision: req.backlog_revision as number };
}

export type ReconciliationInspection = Awaited<ReturnType<typeof inspectMigrationReconciliation>>;

/** Only the audited DB operation changes the active binding; ordinary transitions stay immutable. */
export async function applyMigrationReconciliation(inspection: ReconciliationInspection, deps: ReconciliationDependencies) {
  const { input, evidence, prior } = inspection;
  reconciliationInputSchema.parse(input);
  const result = await one(deps.makinari.rpc('reconcile_requirement_migration', {
    p_requirement_id: input.requirementId, p_file: input.file, p_expected_version: prior.version,
    p_expected_execution_generation: inspection.expectedExecutionGeneration,
    p_expected_updated_at: inspection.expectedUpdatedAt, p_expected_backlog_revision: inspection.expectedBacklogRevision,
    p_instance_id: input.instanceId, p_plan_id: input.planId, p_step_id: input.stepId,
    p_request_id: input.requestId, p_operator_id: input.operatorId, p_reason: input.reason, p_evidence: evidence,
  }), 'Reconciliation RPC');
  const life = parseMigrationLifecycleRecord(result.lifecycle);
  if (result.receipt_id !== input.requestId || result.resumed !== false ||
      life.requirement_id !== input.requirementId || life.file !== input.file ||
      life.version !== prior.version + 1 || life.state !== 'correction_required' || life.review !== null ||
      life.attempts !== prior.attempts || life.original_sql !== prior.original_sql ||
      life.checksum !== prior.checksum || life.specification_checksum !== evidence.specification_checksum) {
    throw new Error('Invalid reconciliation receipt; inspect request ID before retrying.');
  }
  return { receipt_id: input.requestId, state: life.state, attempts: life.attempts, resumed: false as const };
}

/** Separate explicit resume; never uses the generic counter-resetting user-resume RPC. */
export async function resumeMigrationReconciliation(requirementId: string, receiptId: string, deps: ReconciliationDependencies) {
  uuid.parse(requirementId); uuid.parse(receiptId);
  const receipt = await one(deps.makinari.from('requirement_migration_reconciliations').select('*')
    .eq('id', receiptId).eq('requirement_id', requirementId).single(), 'Reconciliation receipt');
  const resumed = await deps.makinari.from('requirement_migration_reconciliation_resumes')
    .select('receipt_id,execution_generation').eq('receipt_id', receiptId).eq('requirement_id', requirementId).maybeSingle();
  if (resumed.error) throw new Error('Resume receipt unavailable.');
  if (resumed.data) {
    if (resumed.data.receipt_id !== receiptId || resumed.data.execution_generation !== receipt.execution_generation + 1) {
      throw new Error('Invalid previous resume receipt.');
    }
    return { receipt_id: receiptId, resumed: false, already_resumed: true };
  }
  const req = await one(deps.makinari.from('requirements').select('id,site_id,instructions,status,metadata')
    .eq('id', requirementId).single(), 'Requirement');
  if (req.status !== 'blocked' || req.metadata?.runner_instance_id !== receipt.instance_id ||
      generation(req.metadata) !== receipt.execution_generation ||
      typeof req.instructions !== 'string' || hash(req.instructions) !== receipt.specification_checksum) {
    throw new Error('Reconciliation scope changed before resume.');
  }
  checksum.parse(receipt.prior_lifecycle?.checksum); file.parse(receipt.file);
  const evidence = await observeUnapplied({ requirementId, instanceId: receipt.instance_id, file: receipt.file },
    req, receipt.prior_lifecycle.checksum, deps);
  if (evidence.tenant_id !== receipt.evidence?.tenant_id || evidence.schema !== receipt.evidence?.schema ||
      evidence.apps_project_ref !== receipt.evidence?.apps_project_ref) {
    throw new Error('Apps tenant binding changed since reconciliation.');
  }
  const result = await one(deps.makinari.rpc('resume_reconciled_requirement_migration', {
    p_requirement_id: requirementId, p_receipt_id: receiptId, p_evidence: evidence,
  }), 'Reconciliation resume RPC');
  if (result.receipt_id !== receiptId || result.resumed !== true ||
      result.execution_generation !== receipt.execution_generation + 1) throw new Error('Invalid reconciliation resume receipt.');
  return result as { receipt_id: string; resumed: true; execution_generation: number };
}