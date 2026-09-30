'use step';

import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { applyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import type { DatabaseMigrationOutcome } from './database-migration-outcome';
import { assertCronExecutionOwnership, type CronExecutionOwnership } from './cron-execution-ownership';
import type { MigrationRepairTarget } from '@/lib/services/apps-platform/migration-repair-types';
import { loadMigrationApplicationContext } from '@/lib/services/apps-platform/migration-application-guard';

export async function applyDatabaseMigrationsStep(
  sandboxId: string,
  reqId: string,
  instanceType: string,
  title: string,
  audit?: CronAuditContext,
  executionOwnership?: CronExecutionOwnership,
  expectedRepairs: MigrationRepairTarget[] = [],
): Promise<DatabaseMigrationOutcome & { effectiveSandboxId: string }> {
  'use step';
  if (executionOwnership) await assertCronExecutionOwnership(executionOwnership);
  let effectiveSandboxId = sandboxId;
  let outcome: DatabaseMigrationOutcome;
  try {
    const connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId: reqId,
      instanceType,
      title: title?.trim() || reqId,
      audit,
    });
    effectiveSandboxId = connected.sandboxId;
    if (executionOwnership) await assertCronExecutionOwnership(executionOwnership);
    const context = await loadMigrationApplicationContext(reqId, executionOwnership
      ? () => assertCronExecutionOwnership(executionOwnership) : undefined);
    const result = await applyPendingMigrations(connected.sandbox, reqId, expectedRepairs, context);
    outcome = result.errors.length > 0
      ? { status: 'failed', applied: result.applied, errors: result.errors,
          failureKind: result.failureKind || 'infrastructure',
          ...(result.repairTarget ? { repairTarget: result.repairTarget } : {}),
          ...(result.correction ? { correction: result.correction } : {}) }
      : { status: 'passed', applied: result.applied, errors: [] };
  } catch (err: any) {
    console.error('[CronStep] applyDatabaseMigrationsStep FAILED:', err?.message || err);
    outcome = { status: 'failed', applied: [], errors: [err?.message || String(err)], failureKind: 'infrastructure' };
  }
  await logCronInfrastructureEvent(audit, {
    event: 'cron_database_migration_validation',
    level: outcome.status === 'passed' ? 'info' : 'error',
    message: outcome.status === 'passed' ? 'Database migrations verified' : 'Database migration delivery gate failed',
    details: { ...outcome, errors: outcome.errors.map(error => error.slice(0, 2000)) },
  });
  return { ...outcome, effectiveSandboxId };
}
