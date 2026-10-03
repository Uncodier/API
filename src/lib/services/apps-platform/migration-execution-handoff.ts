/** Host/operator only. No default clients, environment loading, SQL execution or worker admission. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { sanitizeMigrationRepairContext } from './migration-repair-policy';
import { parseTenantCapabilities } from './tenant-capabilities';
import { requirementSandboxName } from '../sandbox-constants';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.string().max(512).regex(
  /^(?:migrations|supabase\/migrations|src\/db\/migrations|platform)\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$/,
).refine(value => !/[\r\n]/.test(value));
const cleanText = (max: number) => z.string().trim().min(1).max(max).refine(value =>
  sanitizeMigrationRepairContext(value) === value &&
  !/\b[a-z][a-z0-9+.-]*:\/\/|\b\w*(?:password|token|secret|api_key)\w*\s*[:=]/i.test(value));
export const executionHandoffInputSchema = z.object({
  requirementId: uuid, instanceId: uuid, file, requestId: uuid,
  operatorId: cleanText(200), reason: cleanText(2000),
}).strict();
export type ExecutionHandoffInput = z.infer<typeof executionHandoffInputSchema>;
export interface ExecutionHandoffDependencies {
  makinari: SupabaseClient;
  apps: SupabaseClient;
  appsProjectRef: string;
  /** Exact named sandbox file bytes, confined with realpath. Never restore/reconstruct SQL. */
  readMigration: (sandboxName: string, path: string) => Promise<Buffer>;
  now?: () => Date;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const clock = (deps: ExecutionHandoffDependencies) => (deps.now?.() || new Date()).getTime();
function inputValue(raw: ExecutionHandoffInput): ExecutionHandoffInput {
  const parsed = executionHandoffInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid handoff arguments.');
  return parsed.data;
}
function fresh(observedAt: string, deps: ExecutionHandoffDependencies) {
  const age = clock(deps) - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 300_000) throw new Error('Handoff evidence expired or is future-dated.');
}
async function read(query: () => PromiseLike<{ data: any; error: any }>, label: string, optional = false): Promise<any> {
  try {
    const result = await query();
    if (result.error || (!optional && result.data == null)) throw new Error();
    return result.data;
  } catch { throw new Error(`${label} unavailable; handoff denied.`); }
}
const result = (id: string, alreadyRecorded: boolean) => ({
  receipt_id: id, state: 'transferred' as const, resumed: false as const, already_recorded: alreadyRecorded,
});

/** Historical identity lookup, including after uncertain RPC responses. Never replay mutations. */
export async function findMigrationExecutionHandoff(raw: ExecutionHandoffInput, deps: ExecutionHandoffDependencies) {
  const input = inputValue(raw);
  const saved = await read(() => deps.makinari.from('requirement_migration_execution_handoffs')
    .select('id,requirement_id,file,instance_id,operator_id,reason,evidence,execution_generation,transferred_version')
    .eq('id', input.requestId).maybeSingle(), 'Handoff receipt', true);
  if (!saved) return null;
  if (saved.id !== input.requestId || saved.requirement_id !== input.requirementId || saved.file !== input.file ||
      saved.instance_id !== input.instanceId || saved.operator_id !== input.operatorId || saved.reason !== input.reason ||
      saved.evidence?.apps_project_ref !== deps.appsProjectRef || saved.evidence?.file !== input.file ||
      saved.evidence?.sandbox_name !== requirementSandboxName(input.requirementId, input.instanceId) ||
      saved.evidence?.receipt_found !== false || saved.evidence?.feedback_registered !== true ||
      !digest.safeParse(saved.evidence?.sql_checksum).success ||
      saved.evidence?.feedback_checksum !== saved.evidence?.sql_checksum ||
      !Number.isInteger(saved.transferred_version) || saved.transferred_version < 2 ||
      !Number.isInteger(saved.execution_generation) || saved.execution_generation < 0) {
    throw new Error('Handoff request identity conflict or invalid receipt.');
  }
  return result(input.requestId, true);
}

async function current(input: ExecutionHandoffInput, observedAt: string, deps: ExecutionHandoffDependencies) {
  fresh(observedAt, deps);
  const db = deps.makinari;
  const [req, life, owner, diagnostics, plans, reconciliations, resumes] = await Promise.all([
    read(() => db.from('requirements').select('id,site_id,user_id,status,instructions,metadata,cron_lock_active,cron_lock_expires_at')
      .eq('id', input.requirementId).single(), 'Requirement'),
    read(() => db.from('requirement_migration_lifecycle').select('requirement_id,file,version,state,review')
      .eq('requirement_id', input.requirementId).eq('file', input.file).single(), 'Lifecycle'),
    read(() => db.from('remote_instances').select('id,site_id,user_id,status,is_archived')
      .eq('id', input.instanceId).single(), 'Runner'),
    read(() => db.from('requirement_migration_diagnostics').select('state').eq('requirement_id', input.requirementId), 'Diagnostics'),
    read(() => db.from('instance_plans').select('status,metadata').eq('metadata->>requirement_id', input.requirementId), 'Plans'),
    read(() => db.from('requirement_migration_reconciliations').select('id').eq('requirement_id', input.requirementId), 'Reconciliations'),
    read(() => db.from('requirement_migration_reconciliation_resumes').select('receipt_id').eq('requirement_id', input.requirementId), 'Reconciliation resumes'),
  ]);
  fresh(observedAt, deps);
  const gen = req.metadata?.requirement_execution_generation === undefined ? 0 : req.metadata.requirement_execution_generation;
  if (req.id !== input.requirementId || req.status !== 'blocked' || req.cron_lock_active !== false ||
      (req.cron_lock_expires_at != null && (!Number.isFinite(Date.parse(req.cron_lock_expires_at)) || Date.parse(req.cron_lock_expires_at) > clock(deps))) ||
      !object(req.metadata) || req.metadata.runner_instance_id !== input.instanceId ||
      !Number.isInteger(gen) || gen < 0 || gen > 2147483646 ||
      !uuid.safeParse(req.site_id).success || !uuid.safeParse(req.user_id).success ||
      owner.id !== input.instanceId || owner.site_id !== req.site_id || owner.user_id !== req.user_id ||
      owner.is_archived !== false || !['pending', 'running'].includes(owner.status)) {
    throw new Error('Requirement or scoped owner is not idle and blocked.');
  }
  if (life.requirement_id !== input.requirementId || life.file !== input.file ||
      !Number.isInteger(life.version) || life.version < 1 || life.version > 2147483646 ||
      !['platform_review', 'correction_required'].includes(life.state) ||
      (life.review !== null && (!object(life.review) || life.review.decision === 'approved_for_validation'))) {
    throw new Error('Lifecycle is not eligible for execution handoff.');
  }
  if (!Array.isArray(diagnostics) || diagnostics.some(row => !object(row) || typeof row.state !== 'string' || ['running', 'followup_reviewing'].includes(row.state)) ||
      !Array.isArray(plans) || plans.some(row => !object(row) || (row.status === 'paused' && String(row.metadata?.workflow_template) !== 'true')) ||
      !Array.isArray(reconciliations) || !Array.isArray(resumes) ||
      reconciliations.some(row => !uuid.safeParse(row?.id).success || !resumes.some(resume => resume?.receipt_id === row.id)) ||
      ('execution_hold' in req.metadata && (req.metadata.execution_hold?.kind !== 'migration_platform_review' || req.metadata.execution_hold?.file !== input.file)) ||
      (req.metadata.cron_blocker_provenance != null && req.metadata.cron_blocker_provenance !== '')) {
    throw new Error('Active diagnosis, pause, reconciliation or unrelated hold prevents handoff.');
  }
  if (typeof req.instructions !== 'string' || !req.instructions.trim() || Buffer.byteLength(req.instructions) > 65536) {
    throw new Error('Current bounded specification is required.');
  }
  return { siteId: req.site_id as string, userId: req.user_id as string,
    expectedVersion: life.version as number, expectedExecutionGeneration: gen as number,
    specificationChecksum: hash(req.instructions) };
}
type Current = Awaited<ReturnType<typeof current>>;
const contextKey = (input: ExecutionHandoffInput) => `operator-handoff:${input.requestId}`;
const pending = () => ({ code: 'OPERATOR_EXECUTION_HANDOFF', kind: 'pending',
  message: 'Operator handed off legacy execution authority. SQL remains pending normal execution checks; no validation granted.' });
function pendingMatches(value: any): boolean {
  const expected = pending();
  return object(value) && Object.keys(value).length === 3 &&
    value.code === expected.code && value.kind === expected.kind && value.message === expected.message;
}

async function observe(input: ExecutionHandoffInput, scope: Current, observedAt: string, deps: ExecutionHandoffDependencies,
  requireFeedback = false) {
  fresh(observedAt, deps);
  if (!/^[a-z]{20}$/.test(deps.appsProjectRef)) throw new Error('Explicit Apps project ref required.');
  const tenant = await read(() => deps.apps.from('apps_tenants').select('tenant_id,requirement_id,site_id,user_id,schema,status')
    .eq('requirement_id', input.requirementId).single(), 'Apps tenant');
  const schema = `app_${input.requirementId.replace(/-/g, '').slice(0, 24)}`;
  if (tenant.requirement_id !== input.requirementId || tenant.site_id !== scope.siteId || tenant.user_id !== scope.userId ||
      tenant.status !== 'active' || tenant.schema !== schema || !uuid.safeParse(tenant.tenant_id).success) {
    throw new Error('Apps tenant scope mismatch.');
  }
  fresh(observedAt, deps);
  const capabilities = parseTenantCapabilities(await read(() => deps.apps.rpc('apps_get_tenant_capabilities', {
    p_requirement_id: input.requirementId, p_expected_tenant_id: tenant.tenant_id,
  }), 'Tenant capabilities'), { requirementId: input.requirementId, tenantId: tenant.tenant_id, schema });
  const sandboxName = requirementSandboxName(input.requirementId, input.instanceId);
  fresh(observedAt, deps);
  let bytes: Buffer;
  try { bytes = await deps.readMigration(sandboxName, input.file); }
  catch { throw new Error('Named sandbox migration unavailable.'); }
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536) throw new Error('Migration bytes missing or outside bounded size.');
  const sqlChecksum = hash(bytes); // Do not decode, sanitize, reconstruct or return SQL.
  fresh(observedAt, deps);
  const workspace = await read(() => deps.apps.rpc('apps_get_migration_workspace', {
    p_target_schema: schema, p_expected_tenant_id: tenant.tenant_id,
  }), 'Apps workspace');
  if (!object(workspace) || !/^[a-f0-9]{32}$/.test(workspace.schema_fingerprint) ||
      !Array.isArray(workspace.files) || !Array.isArray(workspace.receipts)) throw new Error('Invalid Apps workspace.');
  const key = `migration:${input.file}`;
  const seen = new Set<string>();
  for (const row of workspace.receipts) {
    if (!object(row) || typeof row.migration_key !== 'string' || !row.migration_key.startsWith('migration:') ||
        seen.has(row.migration_key) || !digest.safeParse(row.value?.checksum).success) throw new Error('Unverifiable Apps receipt.');
    seen.add(row.migration_key);
    if (row.migration_key === key || row.value.checksum === sqlChecksum) throw new Error('Applied migration or checksum rename prevents handoff.');
  }
  seen.clear();
  for (const row of workspace.files) {
    if (!object(row) || typeof row.migration_key !== 'string' || !row.migration_key.startsWith('migration:') ||
        !file.safeParse(row.migration_key.slice(10)).success || seen.has(row.migration_key) ||
        !digest.safeParse(row.checksum).success || typeof row.context_key !== 'string' ||
        !row.context_key || Buffer.byteLength(row.context_key) > 256 || !(row.error === null || object(row.error))) {
      throw new Error('Invalid Apps feedback.');
    }
    seen.add(row.migration_key);
  }
  const feedback = workspace.files.find((row: any) => row.migration_key === key);
  if (requireFeedback && (!feedback || feedback.checksum !== sqlChecksum ||
      feedback.context_key !== contextKey(input) || !pendingMatches(feedback.error))) {
    throw new Error('Durable pending feedback changed or is missing.');
  }
  fresh(observedAt, deps);
  return { evidence: { observed_at: observedAt, apps_project_ref: deps.appsProjectRef, tenant_id: tenant.tenant_id as string,
    schema, sandbox_name: sandboxName, file: input.file, sql_checksum: sqlChecksum, receipt_found: false as const,
    specification_checksum: scope.specificationChecksum },
  workspaceFingerprint: workspace.schema_fingerprint as string, capabilitiesChecksum: hash(JSON.stringify(capabilities)) };
}

/** Read-only observation, timestamped BEFORE I/O; dry run never registers feedback. */
export async function inspectMigrationExecutionHandoff(raw: ExecutionHandoffInput, deps: ExecutionHandoffDependencies) {
  const input = inputValue(raw);
  const observedAt = new Date(clock(deps)).toISOString();
  const scope = await current(input, observedAt, deps);
  const observation = await observe(input, scope, observedAt, deps);
  return { input, scope, ...observation };
}
export type ExecutionHandoffInspection = Awaited<ReturnType<typeof inspectMigrationExecutionHandoff>>;

/** Cross-project preflight is not an atomic SQL validation. Only the Makinari RPC owns the row CAS. */
export async function applyMigrationExecutionHandoff(inspection: ExecutionHandoffInspection, deps: ExecutionHandoffDependencies) {
  const input = inputValue(inspection.input);
  const existing = await findMigrationExecutionHandoff(input, deps);
  if (existing) return existing;
  const { observed_at: observedAt } = inspection.evidence;
  const recheck = async (requireFeedback: boolean) => {
    fresh(observedAt, deps);
    const scope = await current(input, observedAt, deps);
    if (JSON.stringify(scope) !== JSON.stringify(inspection.scope)) throw new Error('Requirement binding or lifecycle changed.');
    const observation = await observe(input, scope, observedAt, deps, requireFeedback);
    if (JSON.stringify(observation.evidence) !== JSON.stringify(inspection.evidence) ||
        observation.workspaceFingerprint !== inspection.workspaceFingerprint ||
        observation.capabilitiesChecksum !== inspection.capabilitiesChecksum) throw new Error('Workspace binding or checksum changed.');
  };
  await recheck(false);
  fresh(observedAt, deps);
  const e = inspection.evidence;
  const feedback = await read(() => deps.apps.rpc('apps_record_migration_feedback', {
    p_target_schema: e.schema, p_expected_tenant_id: e.tenant_id, p_migration_key: `migration:${input.file}`,
    p_migration_checksum: e.sql_checksum, p_context_key: contextKey(input), p_error: pending(),
  }), 'Pending feedback');
  if (feedback.target_schema !== e.schema || feedback.tenant_id !== e.tenant_id ||
      feedback.migration_key !== `migration:${input.file}` || feedback.checksum !== e.sql_checksum ||
      feedback.context_key !== contextKey(input) || !pendingMatches(feedback.error)) throw new Error('Invalid pending feedback receipt.');
  // The feedback RPC may return a synthetic row if an applied receipt raced it. Read the durable workspace again.
  await recheck(true);
  fresh(observedAt, deps);
  const receipt = await read(() => deps.makinari.rpc('transfer_requirement_migration_execution', {
    p_requirement_id: input.requirementId, p_file: input.file, p_expected_version: inspection.scope.expectedVersion,
    p_expected_execution_generation: inspection.scope.expectedExecutionGeneration,
    p_instance_id: input.instanceId, p_request_id: input.requestId, p_operator_id: input.operatorId, p_reason: input.reason,
    p_evidence: { ...e, feedback_registered: true, feedback_checksum: e.sql_checksum },
  }), 'Transfer RPC; inspect request receipt before retrying');
  if (!object(receipt) || Object.keys(receipt).length !== 3 || receipt.receipt_id !== input.requestId ||
      receipt.state !== 'transferred' || receipt.resumed !== false) throw new Error('Invalid transfer receipt; inspect request before retrying.');
  return result(input.requestId, false);
}