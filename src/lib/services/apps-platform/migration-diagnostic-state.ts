import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { MigrationLifecycleRecord, MigrationLifecycleTransitionInput } from './migration-lifecycle';
import { parseMigrationLifecycleRecord } from './migration-lifecycle';
import { migrationDiagnosisSchema, type MigrationDiagnosis } from './migration-diagnostic-policy';

const schema = z.object({
  requirement_id: z.string().uuid(), file: z.string().min(1).max(512), token: z.string().uuid(),
  execution_generation: z.number().int().nonnegative(),
  state: z.enum(['running', 'followup_ready', 'followup_assigned', 'followup_reviewing', 'exhausted']),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), specification_checksum: z.string().regex(/^[a-f0-9]{64}$/),
  result: migrationDiagnosisSchema.nullable(), created_at: z.string(), updated_at: z.string(),
}).superRefine((row, ctx) => {
  if (['followup_ready', 'followup_assigned', 'followup_reviewing'].includes(row.state)
    && row.result?.decision !== 'repair_candidate') ctx.addIssue({ code: 'custom', message: 'Missing follow-up diagnosis' });
  if (row.state === 'exhausted' && (!row.result || row.result.decision === 'repair_candidate')) {
    ctx.addIssue({ code: 'custom', message: 'Missing unresolved diagnosis' });
  }
});
export type MigrationDiagnosticRecord = z.infer<typeof schema>;
export interface MigrationDiagnosticScope { requirementId: string; file: string; executionGeneration: number; runId: string }

function parse(value: unknown, requirementId: string, file: string): MigrationDiagnosticRecord {
  const row = schema.parse(value);
  if (row.requirement_id !== requirementId || row.file !== file) throw new Error('Migration diagnostic scope mismatch.');
  return row;
}
function args(scope: MigrationDiagnosticScope) {
  z.string().uuid().parse(scope.requirementId);
  z.string().min(1).parse(scope.runId);
  return { p_requirement_id: scope.requirementId, p_file: scope.file,
    p_execution_generation: scope.executionGeneration, p_run_id: scope.runId };
}
export async function loadMigrationDiagnostic(requirementId: string, file: string): Promise<MigrationDiagnosticRecord | null> {
  const { data, error } = await supabaseAdmin.from('requirement_migration_diagnostics')
    .select('requirement_id,file,token,execution_generation,state,checksum,specification_checksum,result,created_at,updated_at')
    .eq('requirement_id', requirementId).eq('file', file).maybeSingle();
  if (error) throw new Error('Migration diagnostic state unavailable.');
  return data ? parse(data, requirementId, file) : null;
}
export async function claimMigrationDiagnostic(scope: MigrationDiagnosticScope, row: MigrationLifecycleRecord): Promise<MigrationDiagnosticRecord | null> {
  const { data, error } = await supabaseAdmin.rpc('claim_migration_diagnostic', { ...args(scope), p_expected_version: row.version });
  if (error) throw new Error('Migration diagnostic claim failed.');
  if (!data) return null;
  const claimed = parse(data, scope.requirementId, scope.file);
  if (claimed.state !== 'running' || claimed.execution_generation !== scope.executionGeneration
    || claimed.checksum !== row.checksum || claimed.specification_checksum !== row.specification_checksum) throw new Error('Invalid diagnostic claim receipt.');
  return claimed;
}
export async function completeMigrationDiagnostic(scope: MigrationDiagnosticScope, token: string, result: MigrationDiagnosis): Promise<MigrationDiagnosticRecord> {
  const { data, error } = await supabaseAdmin.rpc('complete_migration_diagnostic', {
    ...args(scope), p_token: token, p_result: migrationDiagnosisSchema.parse(result),
  });
  if (error) throw new Error('Migration diagnostic completion failed.');
  const completed = parse(data, scope.requirementId, scope.file);
  if (completed.token !== token || completed.execution_generation !== scope.executionGeneration
    || JSON.stringify(completed.result) !== JSON.stringify(migrationDiagnosisSchema.parse(result))) throw new Error('Invalid diagnostic completion receipt.');
  return completed;
}
export async function assignMigrationDiagnosticFollowup(scope: MigrationDiagnosticScope, token: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('assign_migration_diagnostic_followup', { ...args(scope), p_token: token });
  if (error) throw new Error('Diagnostic follow-up assignment failed.');
  const assigned = parse(data, scope.requirementId, scope.file);
  if (assigned.state !== 'followup_assigned' || assigned.token !== token || assigned.execution_generation !== scope.executionGeneration) throw new Error('Invalid diagnostic follow-up receipt.');
}
export async function beginMigrationDiagnosticReview(input: MigrationLifecycleTransitionInput): Promise<MigrationLifecycleRecord> {
  const { data, error } = await supabaseAdmin.rpc('begin_migration_diagnostic_review', {
    p_requirement_id: input.requirementId, p_file: input.file, p_expected_version: input.expectedVersion,
    p_execution_generation: input.executionGeneration, p_value: input.value,
  });
  if (error) throw new Error('Diagnostic follow-up review is unavailable or already consumed.');
  const row = parseMigrationLifecycleRecord(data);
  if (row.requirement_id !== input.requirementId || row.file !== input.file || row.version !== input.expectedVersion + 1 ||
    row.state !== 'reviewing' || row.attempts !== 5 || row.checksum !== input.value.checksum ||
    row.specification_checksum !== input.value.specification_checksum) throw new Error('Invalid diagnostic review receipt.');
  return row;
}

export async function holdMigrationDiagnostic(scope: MigrationDiagnosticScope, row: MigrationLifecycleRecord,
  planId: string, stepId: string, reason: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('hold_migration_diagnostic', {
    ...args(scope), p_expected_version: row.version, p_plan_id: planId, p_step_id: stepId, p_reason: reason.slice(0, 2000),
  });
  if (error) throw new Error('Could not settle the unresolved diagnostic safely.');
  const saved = parseMigrationLifecycleRecord(data);
  if (saved.requirement_id !== scope.requirementId || saved.file !== scope.file || saved.state !== 'platform_review'
    || saved.version !== row.version + 1) throw new Error('Invalid diagnostic hold receipt.');
}