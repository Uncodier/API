import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getTenantCapabilities } from '@/lib/services/apps-platform/tenant-capabilities-service';
import { loadMigrationApplicationContext } from '@/lib/services/apps-platform/migration-application-guard';
import { diagnoseMigration } from '@/lib/services/apps-platform/migration-diagnostic-agent';
import { unresolvedMigration, sanitizeDiagnosticData, type MigrationDiagnosis } from '@/lib/services/apps-platform/migration-diagnostic-policy';
import { claimMigrationDiagnostic, completeMigrationDiagnostic, loadMigrationDiagnostic } from '@/lib/services/apps-platform/migration-diagnostic-state';
import type { MigrationLifecycleRecord } from '@/lib/services/apps-platform/migration-lifecycle';
import { assertCronExecutionOwnership, type CronExecutionOwnership } from './cron-execution-ownership';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { requirementSandboxName } from '@/lib/services/sandbox-constants';
import { logCronInfrastructureEvent } from '@/lib/services/cron-audit-log';

/** Called inside the non-replayed scheduling step; its claim is durable across cycles. */
export async function obtainMigrationDiagnosis(params: {
  row: MigrationLifecycleRecord; executionOwnership: CronExecutionOwnership;
  previousInstructions: string; sandboxId?: string;
}): Promise<{ token?: string; result: MigrationDiagnosis; assigned?: boolean }> {
  const { row, executionOwnership } = params;
  if (!executionOwnership.runId) throw new Error('Diagnostic requires an execution owner.');
  const scope = { requirementId: row.requirement_id, file: row.file,
    executionGeneration: executionOwnership.executionGeneration, runId: executionOwnership.runId };
  let existing = await loadMigrationDiagnostic(row.requirement_id, row.file);
  if (existing) {
    if (existing.execution_generation !== executionOwnership.executionGeneration) return { result: unresolvedMigration('Execution changed after the independent diagnostic. Its allowance cannot be reset by a generic resume; reconcile the existing evidence.') };
    if (existing.specification_checksum !== row.specification_checksum) return { result: unresolvedMigration('The specification changed after diagnosis; reconcile its original evidence without resetting the budget.') };
    if (existing.state === 'followup_ready' || existing.state === 'followup_assigned') {
      if (existing.state === 'followup_ready' && existing.checksum !== row.checksum) return { result: unresolvedMigration('The failed migration changed before diagnostic assignment. Its evidence must be reconciled, not silently reused.') };
      return { token: existing.token, result: existing.result!, assigned: existing.state === 'followup_assigned' };
    }
    return { result: existing.result?.decision !== 'repair_candidate' && existing.result
      ? existing.result : unresolvedMigration(existing.state === 'running'
        ? 'The independent diagnostic was interrupted or is already owned. Its allowance cannot be silently reacquired.'
        : 'The single diagnostic follow-up has been consumed without validated success.') };
  }
  const claimed = await claimMigrationDiagnostic(scope, row);
  if (!claimed) throw new Error('Another worker claimed the independent diagnostic.');
  let result: MigrationDiagnosis;
  let instanceId: string | undefined;
  let siteId: string | undefined;
  try {
    const context = await loadMigrationApplicationContext(row.requirement_id, () => assertCronExecutionOwnership(executionOwnership));
    instanceId = context.instance.id;
    siteId = context.instance.site_id;
    if (!instanceId) throw new Error('Diagnostic runner unavailable.');
    const sandbox = await getSandboxHandle(params.sandboxId || requirementSandboxName(row.requirement_id, instanceId));
    const capabilities = await getTenantCapabilities(row.requirement_id);
    const { data: logs, error } = await supabaseAdmin.from('instance_logs')
      .select('id,created_at,tool_name,tool_args,tool_result,details').eq('instance_id', instanceId!)
      .eq('details->>requirement_id', row.requirement_id).order('created_at', { ascending: false }).limit(12);
    if (error || !instanceId) throw new Error('Diagnostic evidence history unavailable.');
    result = await diagnoseMigration({ sandbox, row, context, capabilities, previousInstructions: params.previousInstructions,
      history: (logs || []).map(log => ({ id: log.id, at: log.created_at, tool: log.tool_name,
        operation: sanitizeDiagnosticData(log.tool_args ?? {}), result: sanitizeDiagnosticData(log.tool_result ?? {}) })) });
  } catch {
    // Do not reinterpret missing evidence or transport as impossibility, or replay the diagnostic.
    result = unresolvedMigration('Independent diagnosis could not collect complete evidence or finish safely. Technical reconciliation is needed, not generic permission to retry.');
  }
  await assertCronExecutionOwnership(executionOwnership);
  existing = await completeMigrationDiagnostic(scope, claimed.token, result);
  if (siteId && instanceId) await logCronInfrastructureEvent({ instanceId, siteId, requirementId: row.requirement_id, executionOwnership }, {
    event: 'cron_migration_diagnostic', message: 'Independent migration diagnosis completed',
    details: { diagnostic_id: claimed.token, decision: result.decision, reason: result.reason, next_action: result.next_action,
      evidence: result.evidence, resolution_actor: result.decision === 'needs_product_decision' ? 'user' : 'platform',
      user_action_required: result.decision === 'needs_product_decision', proven_irreparable: false },
  });
  return { token: existing.token, result: existing.result! };
}