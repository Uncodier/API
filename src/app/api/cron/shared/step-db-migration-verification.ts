'use step';

import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { verifyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { loadMigrationExecutionContext, migrationFailure } from '@/lib/services/apps-platform/migration-execution';
import { logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { assertCronExecutionOwnership, type CronExecutionOwnership } from './cron-execution-ownership';
import type { DatabaseMigrationOutcome } from './database-migration-outcome';
import { listMigrationLifecycle } from '@/lib/services/apps-platform/migration-lifecycle';

/** Legacy admission only; do not import the retired repair/model dependency graph. */
export async function loadMigrationLifecycleStep(requirementId: string) {
  'use step';
  return listMigrationLifecycle(requirementId);
}

/** Finalization verifies receipts; it never executes tenant SQL after product tests. */
export async function verifyDatabaseMigrationsStep(
  sandboxId: string,
  requirementId: string,
  instanceType: string,
  title: string,
  audit: CronAuditContext,
  ownership: CronExecutionOwnership,
): Promise<DatabaseMigrationOutcome & { effectiveSandboxId: string }> {
  'use step';
  await assertCronExecutionOwnership(ownership);
  let effectiveSandboxId = sandboxId;
  let outcome: DatabaseMigrationOutcome;
  try {
    const connected = await connectOrRecreateRequirementSandbox({ sandboxId, requirementId, instanceType, title, audit });
    effectiveSandboxId = connected.sandboxId;
    const context = await loadMigrationExecutionContext(requirementId, () => assertCronExecutionOwnership(ownership));
    const result = await verifyPendingMigrations(connected.sandbox, requirementId, context);
    outcome = result.errors.length || result.pending?.length
      ? { status: 'failed', applied: result.applied,
          errors: result.errors.length ? result.errors : [`Pending migrations: ${result.pending!.join(', ')}`],
          failureKind: result.failureKind || 'infrastructure' }
      : { status: 'passed', applied: result.applied, errors: [] };
  } catch (error) {
    outcome = { status: 'failed', applied: [], errors: [migrationFailure(error).error], failureKind: 'infrastructure' };
  }
  await assertCronExecutionOwnership(ownership);
  await logCronInfrastructureEvent(audit, {
    event: 'cron_database_migration_validation',
    level: outcome.status === 'passed' ? 'info' : 'error',
    message: outcome.status === 'passed' ? 'Database migration receipts verified' : 'Database migration receipts are not ready',
    details: { ...outcome, verification_only: true },
  });
  return { ...outcome, effectiveSandboxId };
}