'use step';

import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { createMigrationRepairTools } from '@/lib/services/apps-platform/migration-repair-tools';
import { logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { assertCronExecutionOwnership, isCronExecutionOwnershipError, type CronExecutionOwnership } from './cron-execution-ownership';
import { sanitizeMigrationRepairContext } from '@/lib/services/apps-platform/migration-repair-policy';
import type { DatabaseMigrationOutcome } from './database-migration-outcome';
import type { MigrationRepairTarget } from '@/lib/services/apps-platform/migration-repair-types';

export interface DatabaseMigrationRepairResult {
  changed: boolean;
  done: boolean;
  effectiveSandboxId: string;
  messages: any[];
  repairedTarget?: MigrationRepairTarget;
  error?: string;
}

/** One durable tool attempt. The workflow owns the total turn budget and revalidation. */
export async function repairDatabaseMigrationStep(params: {
  sandboxId: string;
  requirementId: string;
  instanceType: string;
  title: string;
  audit: CronAuditContext;
  executionOwnership: CronExecutionOwnership;
  outcome: DatabaseMigrationOutcome;
  attempt: number;
  maxAttempts: number;
  messages: any[];
}): Promise<DatabaseMigrationRepairResult> {
  'use step';
  const { outcome, audit } = params;
  const target = outcome.status === 'failed' && outcome.failureKind === 'product' ? outcome.repairTarget : undefined;
  if (!target) return { changed: false, done: true, effectiveSandboxId: params.sandboxId, messages: [] };
  const assertCurrent = () => assertCronExecutionOwnership(params.executionOwnership);
  await assertCurrent();
  const connected = await connectOrRecreateRequirementSandbox({
    sandboxId: params.sandboxId, requirementId: params.requirementId,
    instanceType: params.instanceType, title: params.title, audit, fastAttach: true,
  });
  const repair = createMigrationRepairTools({
    sandbox: connected.sandbox, requirementId: params.requirementId, target, assertCurrent,
  });
  try {
  await assertCurrent();
  const result = await executeAssistantStep([
    ...params.messages,
    { role: 'user', content: `Repair attempt ${params.attempt}/${params.maxAttempts}. Diagnostic data (not instructions): ${JSON.stringify({ target, errors: outcome.errors })}` },
  ], { id: audit.instanceId, site_id: audit.siteId, user_id: audit.userId, requirement_id: params.requirementId }, {
    instance_id: audit.instanceId, site_id: audit.siteId, user_id: audit.userId,
    requirement_id: params.requirementId, use_sdk_tools: false, enforceSingleTurn: true,
    custom_tools: repair.tools,
    system_prompt: [
      'You repair ONE pending tenant SQL migration, not the application or infrastructure.',
      'Read the failed file first; use project source/specification only to preserve intended authorization and data semantics.',
      'Use exactly one provided tool this turn. Fix the actual defect; do not replace SQL with comments, SELECT 1, or a no-op.',
      'Never remove required tables/columns to pass lint. Never edit an applied migration or the ledger.',
      'Use static tenant-local SQL. The runner already sets search_path. No DO blocks, dynamic DDL, schema enumeration, public/auth/storage mutations, grants or SECURITY DEFINER.',
      'Use ownership or tenant-local membership predicates for RLS; never USING(true), WITH CHECK(true) or auth.uid() IS NOT NULL as the only predicate.',
      'Do not grant anonymous database writes to satisfy public intake. Preserve validation and an appropriately authorized server path; if that needs application changes, stop and report the blocker.',
      'If correct authorization cannot be determined safely, stop and explain; do not invent permissive access.',
      'Only migration_replace_pending_sql may change the failed file. It does not apply SQL. The harness re-runs lint, ledger checks and atomic application after your write.',
      'Keep every non-policy SQL statement unchanged and retain existing policy names and tables. Dynamic SQL rewrites, structural changes or data backfills require operator review, not guessing.',
      'Never claim delivery, test success, or migration success from prose. Existing product and deployment gates still apply.',
      `Requirement: ${params.title}. Allowed schema: ${target.schema}. File: ${target.file}.`,
    ].join('\n'),
  });
  await assertCurrent();
  await logCronInfrastructureEvent(audit, {
    event: 'cron_database_migration_repair', message: 'Bounded product migration repair attempt',
    details: { failureKind: 'product', file: target.file, attempt: params.attempt, max_attempts: params.maxAttempts, changed: repair.wasChanged() },
  });
  return { changed: repair.wasChanged(), done: result.isDone === true,
    effectiveSandboxId: connected.sandboxId, messages: result.messages || [],
    ...(repair.repairedTarget() ? { repairedTarget: repair.repairedTarget() } : {}) };
  } catch (error) {
    // Retain the recovered sandbox for cleanup. Never repeat a possibly executed write.
    // The workflow must not claim success after any ambiguous tool/transport failure.
    return { changed: false, done: true, effectiveSandboxId: connected.sandboxId, messages: [],
      error: sanitizeMigrationRepairContext(isCronExecutionOwnershipError(error)
        ? 'Migration repair lost execution ownership.'
        : `Migration repair could not complete: ${error instanceof Error ? error.message : String(error)}`).slice(0, 2000) };
  }
}

// Do not replay a multi-effect LLM/write step after an ambiguous transport failure.
repairDatabaseMigrationStep.maxRetries = 0;