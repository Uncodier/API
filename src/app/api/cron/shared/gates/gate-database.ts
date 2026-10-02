import { verifyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { loadMigrationExecutionContext, migrationFailure } from '@/lib/services/apps-platform/migration-execution';
import { assertCronExecutionOwnership } from '../cron-execution-ownership';
import type { FlowGateInput, FlowGateResult } from './types';

/** A pending migration is implementation feedback, not a new repair workflow. */
export async function verifyDatabaseGate(input: FlowGateInput): Promise<FlowGateResult | null> {
  try {
    const ownership = input.audit?.executionOwnership;
    const context = await loadMigrationExecutionContext(input.requirementId,
      ownership ? () => assertCronExecutionOwnership(ownership) : undefined);
    const result = await verifyPendingMigrations(input.sandbox, input.requirementId, context);
    if (!result.errors.length && !result.pending?.length) return null;
    const infrastructure = result.failureKind !== 'product';
    const message = (result.errors.join('\n') || `Pending migrations: ${result.pending!.join(', ')}`) + (infrastructure
      ? '\nReconcile infrastructure/receipts before retrying; do not rewrite SQL to bypass permissions.'
      : result.diagnostic?.code === 'MIGRATION_RETRY_REQUIRED'
        ? '\nContinue this step by retrying sandbox_db_migrate without changing SQL. Infrastructure errors do not authorize permission changes.'
        : '\nContinue this implementation step: inspect the database, correct only pending SQL, then call sandbox_db_migrate. Do not delete migrations or edit applied history.');
    return {
      flow: input.flow, ok: false, error: message, reason: message,
      disposition: infrastructure ? 'unknown' : 'hard_fail',
      failureKind: infrastructure ? 'infrastructure_unavailable' : 'product_defect',
      infrastructureFailure: infrastructure,
      continueImplementation: !infrastructure,
      signals: [{ name: 'database_migrations', ok: false, detail: message,
        disposition: infrastructure ? 'unknown' : 'hard_fail',
        failureKind: infrastructure ? 'infrastructure_unavailable' : 'product_defect' }],
    };
  } catch (error) {
    const message = migrationFailure(error).error;
    return { flow: input.flow, ok: false, error: message, reason: message,
      disposition: 'unknown', failureKind: 'infrastructure_unavailable', infrastructureFailure: true,
      signals: [{ name: 'database_migrations', ok: false, disposition: 'unknown', detail: message }] };
  }
}