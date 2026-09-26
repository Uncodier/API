import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

function workspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const cronCapacitySql = workspaceFile(
  'supabase/migrations/20260917204500_atomic_requirement_cron_capacity.sql',
);
const cronMonthlyScopeSql = workspaceFile(
  'supabase/migrations/20260926070000_harness_execution_ownership.sql',
);
const scopedCycleSql = workspaceFile(
  'supabase/migrations/20260919165000_scope_cron_no_progress.sql',
);
const scopedBlockerSql = workspaceFile(
  'supabase/migrations/20260919192000_atomic_scoped_backlog_circuits.sql',
);
const scopedCompatibilitySql = workspaceFile(
  'supabase/migrations/20260919203000_restore_scoped_rpc_compatibility.sql',
);
const legacyCycleIdentitySql = workspaceFile(
  'supabase/migrations/20260920002500_enforce_legacy_cron_cycle_identity.sql',
);
const atomicPlanCancellationSql = workspaceFile(
  'supabase/migrations/20260919235500_atomic_backlog_plan_step_cancellation.sql',
);
const infrastructureRetryStreakSql = workspaceFile(
  'supabase/migrations/20260922041000_reset_infrastructure_retry_streak_on_remediation.sql',
);
const durableReviewQuarantineSql = workspaceFile(
  'supabase/migrations/20260923230000_durable_review_quarantine.sql',
);
const reviewQuarantineBackfillSql = workspaceFile(
  'supabase/migrations/20260923230050_backfill_review_quarantine.sql',
);
const reviewQuarantineReceiptsSql = workspaceFile(
  'supabase/migrations/20260923225900_review_quarantine_receipts.sql',
);
const reviewQuarantineStampSql = workspaceFile(
  'supabase/migrations/20260923230100_stamp_review_quarantine.sql',
);

describe('atomic cron SQL contracts', () => {
  const cycleSql = workspaceFile(
    'supabase/migrations/20260917203000_atomic_cron_cycle_accounting.sql',
  );
  const infrastructureSql = workspaceFile(
    'supabase/migrations/20260917203100_atomic_plan_infrastructure_state.sql',
  );
  const recoverySql = workspaceFile(
    'supabase/migrations/20260917203200_atomic_deployment_infrastructure_recovery.sql',
  );
  const blockSql = workspaceFile(
    'supabase/migrations/20260917203300_atomic_infrastructure_block_transition.sql',
  );
  const accumulatedBlockSql = workspaceFile(
    'supabase/migrations/20260917203350_generation_guarded_accumulated_blocks.sql',
  );
  const requirementBlockSql = workspaceFile(
    'supabase/migrations/20260917203400_atomic_requirement_block.sql',
  );
  const stepPatchSql = workspaceFile(
    'supabase/migrations/20260917203500_atomic_plan_step_patch.sql',
  );
  const userRecoverySql = workspaceFile(
    'supabase/migrations/20260917203600_atomic_instance_execution_resume.sql',
  );
  const planGateSql = workspaceFile(
    'supabase/migrations/20260918020000_atomic_plan_gate_completion.sql',
  );
  const recoveryLeaseSql = workspaceFile(
    'supabase/migrations/20260917203800_deployment_recovery_scan_lease.sql',
  );
  const appWorkflowSource = workspaceFile(
    'src/app/api/cron/requirements-apps/workflow.ts',
  );
  const securityDefinerMigrations = [
    cycleSql,
    infrastructureSql,
    cronCapacitySql,
    cronMonthlyScopeSql,
    recoverySql,
    blockSql,
    accumulatedBlockSql,
    requirementBlockSql,
    stepPatchSql,
    userRecoverySql,
    recoveryLeaseSql,
    scopedCycleSql,
    scopedBlockerSql,
    scopedCompatibilitySql,
    legacyCycleIdentitySql,
    atomicPlanCancellationSql,
    infrastructureRetryStreakSql,
  ];

  it('uses a unique version prefix for every Supabase migration', () => {
    const migrations = readdirSync(resolve(process.cwd(), 'supabase/migrations'))
      .filter((name) => /^\d{14}_.+\.sql$/.test(name));
    const versions = migrations.map((name) => name.split('_', 1)[0]);

    expect(new Set(versions).size).toBe(versions.length);
  });

  it('uses a durable non-evicting cycle ledger with RLS', () => {
    expect(cycleSql).toMatch(
      /PRIMARY KEY\s*\(\s*requirement_id,\s*cycle_id\s*\)/,
    );
    expect(cycleSql).toContain(
      'ALTER TABLE public.requirement_cron_cycle_outcomes ENABLE ROW LEVEL SECURITY',
    );
    expect(cycleSql).toContain(
      'ON CONFLICT (requirement_id, cycle_id) DO NOTHING',
    );
    expect(cycleSql).not.toContain('cron_accounted_cycle_ids');
    expect(cycleSql).toContain('execution_generation');
    expect(cycleSql).toContain('p_expected_execution_generation');
  });

  it('upgrades an existing cycle ledger before creating its generation index', () => {
    const addGenerationColumn = cycleSql.indexOf(
      'ADD COLUMN IF NOT EXISTS execution_generation integer',
    );
    const createGenerationIndex = cycleSql.indexOf(
      'CREATE INDEX requirement_cron_cycle_outcomes_order_idx',
    );

    expect(addGenerationColumn).toBeGreaterThan(-1);
    expect(createGenerationIndex).toBeGreaterThan(addGenerationColumn);
    expect(cycleSql).toContain('SET execution_generation = 0');
    expect(cycleSql).toContain(
      'ALTER COLUMN execution_generation SET NOT NULL',
    );
    expect(cycleSql).toContain(
      'DROP INDEX IF EXISTS public.requirement_cron_cycle_outcomes_order_idx',
    );
    expect(cycleSql.trimEnd().split(/\r?\n/).length).toBeLessThan(500);
  });

  it('restricts every privileged RPC to non-public execution roles', () => {
    for (const sql of securityDefinerMigrations) {
      const definitions = sql.match(/\bSECURITY DEFINER\b/g) ?? [];
      const hardenedRevokes =
        sql.match(
          /REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated;/g,
        ) ?? [];

      expect(hardenedRevokes).toHaveLength(definitions.length);
      expect(sql).not.toMatch(
        /REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC;/,
      );
    }
    expect(cycleSql).toContain(
      "p.proname = 'record_requirement_cron_cycle_outcome'",
    );
    expect(cycleSql).toContain(
      "'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated'",
    );
  });

  it('recomputes both product budgets in cycle order under the row lock', () => {
    expect(cycleSql).toContain('FOR UPDATE');
    expect(cycleSql).toMatch(
      /\(cycle_started_at,\s*cycle_id\)\s*>\s*\(v_last_progress_at,\s*v_last_progress_cycle_id\)/,
    );
    expect(cycleSql).toContain(
      "'no_progress_cycles', COALESCE(v_no_progress_cycles, 0)",
    );
    expect(cycleSql).toContain(
      "'cron_infrastructure_failure_cycles'",
    );
  });

  it('resets infrastructure retry streaks after successful remediation', () => {
    expect(infrastructureRetryStreakSql).toMatch(
      /outcome IN \(\s*'progress',\s*'product_no_progress',\s*'product_failure',\s*'remediation_handoff'\s*\)/,
    );
    expect(infrastructureRetryStreakSql).toContain(
      "'cron_infrastructure_failure_cycles'",
    );
    expect(infrastructureRetryStreakSql).toContain(
      "'infrastructure-counter-normalization-v2'",
    );
    expect(infrastructureRetryStreakSql).toContain(
      "pg_catalog.set_config(\n    'request.jwt.claims'",
    );
    expect(infrastructureRetryStreakSql).toContain(
      `'{"role":"service_role"}'`,
    );
    expect(infrastructureRetryStreakSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThan(500);
  });

  it('releases review quarantine only through a newer trusted user action', () => {
    expect(durableReviewQuarantineSql).toContain(
      'trusted_user_action boolean NOT NULL DEFAULT false',
    );
    expect(durableReviewQuarantineSql).toContain(
      'external_user_action_revision bigint NOT NULL DEFAULT 0',
    );
    expect(reviewQuarantineReceiptsSql).toContain(
      'PRIMARY KEY (requirement_id, action_id)',
    );
    expect(reviewQuarantineReceiptsSql).toContain(
      'ENABLE ROW LEVEL SECURITY',
    );
    expect(reviewQuarantineReceiptsSql).toContain(
      'CREATE POLICY requirement_user_action_receipts_service_role',
    );
    expect(durableReviewQuarantineSql).toContain(
      'CREATE TRIGGER requirements_review_quarantine_guard',
    );
    expect(durableReviewQuarantineSql).toContain(
      'log.trusted_user_action = true',
    );
    expect(durableReviewQuarantineSql).toMatch(
      /v_action_created_at\s*>\s*public\.requirement_quarantine_timestamp\(v_item\)/,
    );
    expect(durableReviewQuarantineSql).toContain(
      "'released_by_action_id', p_action_id",
    );
    expect(durableReviewQuarantineSql).toContain('FOR UPDATE');
    expect(durableReviewQuarantineSql).toContain(
      'FROM PUBLIC, anon, authenticated;',
    );
    expect(durableReviewQuarantineSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThan(500);
    expect(reviewQuarantineBackfillSql).toContain(
      "'request.jwt.claims'",
    );
    expect(reviewQuarantineBackfillSql).toContain(
      `'{"role":"service_role"}'`,
    );
    expect(reviewQuarantineBackfillSql).toContain(
      'ADD COLUMN IF NOT EXISTS external_user_action_revision',
    );
    expect(reviewQuarantineBackfillSql).toContain(
      "'Backfilled review quarantine'",
    );
    expect(reviewQuarantineStampSql).toContain(
      'CREATE TRIGGER requirements_review_quarantine_stamp',
    );
    expect(reviewQuarantineStampSql).toContain(
      "'plan_cancellation_pending'",
    );
  });

  it('scopes no-progress accounting and blocking to one plan step', () => {
    expect(scopedCycleSql).toContain(
      'ADD COLUMN IF NOT EXISTS plan_id uuid',
    );
    expect(scopedCycleSql).toContain(
      'ADD COLUMN IF NOT EXISTS step_id text',
    );
    expect(scopedCycleSql).toContain(
      'plan_id IS NOT DISTINCT FROM v_latest_plan_id',
    );
    expect(scopedCycleSql).toContain(
      'step_id IS NOT DISTINCT FROM v_latest_step_id',
    );
    expect(scopedCycleSql).toMatch(
      /AND plan_id = p_plan_id[\s\S]*AND step_id = p_step_id[\s\S]*AND outcome = 'product_no_progress'/,
    );
    expect(scopedCycleSql).toContain(
      'product_no_progress requires plan and step scope',
    );
    expect(scopedCycleSql).not.toContain(
      'DROP FUNCTION IF EXISTS public.block_requirement_for_product_no_progress',
    );
    expect(scopedCycleSql).not.toContain(
      'DROP FUNCTION IF EXISTS public.record_requirement_cron_cycle_outcome',
    );
    expect(scopedCycleSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThanOrEqual(500);
  });

  it('atomically fences scoped blockers and cancels propagated descendants', () => {
    expect(scopedBlockerSql).toContain(
      'block_backlog_item_for_circuit_atomic',
    );
    expect(scopedBlockerSql).toContain('FOR UPDATE');
    expect(scopedBlockerSql).toContain(
      'v_generation IS DISTINCT FROM p_expected_step_generation',
    );
    expect(scopedBlockerSql).toMatch(
      /v_step->'metadata'->>'backlog_item_id',\s*v_step->>'backlog_item_id'\s*\)\s+IS DISTINCT FROM p_backlog_item_id/,
    );
    expect(scopedBlockerSql).toContain(
      "->>'state', ''\n    ) <> 'consumed'",
    );
    expect(scopedBlockerSql).toContain(
      'v_latest_cycle_id IS DISTINCT FROM p_cycle_id',
    );
    expect(scopedBlockerSql).toContain('WITH RECURSIVE affected');
    expect(scopedBlockerSql).toContain(
      ") = ANY(v_affected)",
    );
    expect(scopedBlockerSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThanOrEqual(500);
  });

  it('restores scoped RPC compatibility overloads in a forward migration', () => {
    expect(scopedCompatibilitySql).toContain(
      'CREATE OR REPLACE FUNCTION public.record_requirement_cron_cycle_outcome',
    );
    expect(scopedCompatibilitySql).toContain(
      'RETURN public.record_requirement_cron_cycle_outcome(',
    );
    expect(scopedCompatibilitySql).toContain(
      'CREATE OR REPLACE FUNCTION public.block_requirement_for_product_no_progress',
    );
    expect(scopedCompatibilitySql).toContain(
      'RETURN public.block_requirement_for_product_no_progress(',
    );
    expect(scopedCompatibilitySql).toContain(
      'plan.created_at <= p_cycle_started_at',
    );
    expect(scopedCompatibilitySql).toContain(
      "(entry.value->>'started_at')::timestamptz >=",
    );
    expect(scopedCompatibilitySql).toContain(
      "(entry.value->>'started_at')::timestamptz <",
    );
    expect(scopedCompatibilitySql).toContain(
      'count(*) OVER () AS candidate_count',
    );
    expect(scopedCompatibilitySql).toContain('WHERE candidate_count = 1');
    expect(scopedCompatibilitySql).not.toContain(
      'plan.updated_at >= p_cycle_started_at',
    );
    expect(scopedCompatibilitySql).toContain(
      "'accepted', false",
    );
    expect(scopedCompatibilitySql).not.toContain(
      'product_no_progress requires an active plan step',
    );
  });

  it('requires exact cycle identity for legacy scope inference', () => {
    expect(legacyCycleIdentitySql).toContain(
      "entry.value->'metadata'->>'cron_cycle_id' = p_cycle_id",
    );
    expect(legacyCycleIdentitySql).toContain(
      "entry.value->'metadata'->>'cron_execution_generation'",
    );
    expect(legacyCycleIdentitySql).toContain(
      'count(*) OVER () AS candidate_count',
    );
    expect(legacyCycleIdentitySql).toContain('WHERE candidate_count = 1');
    expect(legacyCycleIdentitySql).not.toContain(
      "(entry.value->>'started_at')::timestamptz",
    );
    expect(appWorkflowSource).toContain('cycleId: cronLockRunId');
  });

  it('cancels backlog-bound plan steps atomically under row locks', () => {
    expect(atomicPlanCancellationSql).toContain(
      'cancel_requirement_plan_steps_for_backlog_items',
    );
    expect(atomicPlanCancellationSql).toContain('FOR UPDATE');
    expect(atomicPlanCancellationSql).toContain(
      "step.value->>'status' IN (\n            'pending', 'in_progress', 'failed'",
    );
    expect(atomicPlanCancellationSql).toMatch(
      /step\.value->>'status' <> 'failed'[\s\S]*step\.value->>'retry_count'[\s\S]*END < 2/,
    );
    expect(atomicPlanCancellationSql).toContain(
      "v_plan.updated_at + interval '1 millisecond'",
    );
    expect(atomicPlanCancellationSql).not.toContain('MAX_CAS_ATTEMPTS');
    expect(atomicPlanCancellationSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThanOrEqual(500);
  });

  it('routes preflight infrastructure circuits through item scoping', () => {
    expect(appWorkflowSource).toContain(
      'await scopeInfrastructureCircuitStep({',
    );
    expect(appWorkflowSource).not.toContain(
      'await blockRequirementForInfrastructureCircuitStep({',
    );
  });

  it('pushes safe workspace changes while missing preconditions block delivery', () => {
    expect(appWorkflowSource).toMatch(
      /gateFailureKind === 'missing_precondition'[\s\S]*?persistWorkspaceOnInfrastructureHalt = true/,
    );
    expect(appWorkflowSource).toMatch(
      /if \((?:[^\n]*&& )?shouldPersistCycleWorkspace\(\{/,
    );
  });

  it('deduplicates infrastructure failures with null-safe generation guards', () => {
    expect(infrastructureSql).toMatch(
      /PRIMARY KEY\s*\(\s*plan_id,\s*step_id,\s*event_id\s*\)/,
    );
    expect(infrastructureSql).toContain('FOR UPDATE');
    expect(infrastructureSql).toContain(
      'v_generation IS DISTINCT FROM p_expected_generation',
    );
    expect(blockSql).toContain(
      'v_generation IS DISTINCT FROM p_expected_generation',
    );
    expect(stepPatchSql).toContain(
      'v_generation IS DISTINCT FROM p_expected_generation',
    );
    expect(infrastructureSql).not.toMatch(
      /v_generation(?:::\w+)?\s*<>\s*p_expected_generation/,
    );
    expect(infrastructureSql).toContain('jsonb_set(');
    expect(infrastructureSql).toContain(
      'update_instance_plan_step_status_atomic',
    );
    expect(infrastructureSql).toMatch(
      /'status', p_status,\s*'infrastructure_generation', v_generation \+ 1/,
    );
    expect(infrastructureSql).toMatch(
      /WHEN jsonb_typeof\(steps\) = 'array' THEN steps/,
    );
    expect(stepPatchSql).toContain('patch_instance_plan_step_atomic');
    expect(stepPatchSql).toContain(
      "'infrastructure_generation', v_generation + 1",
    );
    expect(userRecoverySql).toContain(
      'resume_instance_execution_on_user_action',
    );
    expect(userRecoverySql).toContain(
      "'infrastructure_generation', v_generation + 1",
    );
    expect(userRecoverySql).toContain(
      "'requirement_last_resume_action_id', p_action_id",
    );
    expect(userRecoverySql).toContain('v_duplicate_action := COALESCE(');
    expect(userRecoverySql).toContain(
      "metadata->>'requirement_id' = p_requirement_id::text",
    );
    expect(userRecoverySql).not.toContain(
      "status IN ('pending', 'in_progress', 'active', 'paused', 'failed')",
    );
    expect(infrastructureSql).toContain(
      'ALTER TABLE public.instance_plan_step_infrastructure_events',
    );
    expect(infrastructureSql).toContain('DROP CONSTRAINT IF EXISTS');
    expect(infrastructureSql).toMatch(
      /event_type IN \([\s\S]*'deployment_recovery',[\s\S]*'step_patch'/,
    );
    expect(infrastructureSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThanOrEqual(500);
  });

  it('treats a retried terminal status write as a successful duplicate', () => {
    const statusFunction = infrastructureSql.slice(
      infrastructureSql.indexOf(
        'CREATE OR REPLACE FUNCTION public.update_instance_plan_step_status_atomic',
      ),
    );
    const retryGuard = statusFunction.indexOf(
      'v_generation::bigint IS NOT DISTINCT FROM',
    );
    const staleGuard = statusFunction.indexOf(
      'IF v_generation IS DISTINCT FROM p_expected_generation',
    );
    expect(retryGuard).toBeGreaterThan(-1);
    expect(retryGuard).toBeLessThan(staleGuard);
    expect(statusFunction.slice(retryGuard, staleGuard)).toContain(
      'p_expected_generation::bigint + 1',
    );
    expect(statusFunction.slice(retryGuard, staleGuard)).toContain(
      "'state', 'duplicate'",
    );
  });

  it('makes final-step completion and no-progress blocking generation guarded', () => {
    expect(planGateSql).toContain(
      'complete_instance_plan_step_after_gate',
    );
    expect(planGateSql).toContain('p_final_gate_approved');
    expect(planGateSql).toContain(
      'reconcile_instance_plan_status_atomic',
    );
    expect(planGateSql).toContain(
      'p_expected_step_generation',
    );
    expect(planGateSql).toMatch(
      /no_progress_adjudication'->>'state',[\s\S]*\) <> 'consumed'/,
    );
    expect(planGateSql).toContain("'execution_generation'");
    expect(planGateSql).toContain(
      "v_plan_status IN ('paused', 'cancelled', 'failed')",
    );
    expect(planGateSql).toContain(
      "v_status IN ('paused', 'cancelled', 'completed', 'failed')",
    );
    expect(planGateSql).toContain(
      'block_requirement_for_product_no_progress(uuid, uuid, uuid, text, integer, text, integer)',
    );
    expect(planGateSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThanOrEqual(500);
  });

  it('atomically guards product blockers and limits counter resets to legacy recovery', () => {
    expect(recoverySql).toMatch(
      /FROM public\.requirements[\s\S]*FOR UPDATE/,
    );
    expect(recoverySql).toContain("'product_no_progress_circuit'");
    expect(recoverySql).toContain('v_has_product_failure');
    expect(recoverySql).toMatch(
      /IF v_legacy_matched THEN[\s\S]*'cron_attempts', 0,[\s\S]*'no_progress_cycles', 0/,
    );
    expect(recoverySql).toContain(
      'instance_plan_step_infrastructure_events',
    );
    expect(recoverySql).not.toMatch(
      /IF v_requirement_metadata->>'deployment_recovery_completed_key'\s*=\s*p_recovery_id\s*THEN/,
    );
    expect(recoverySql).toMatch(
      /WHEN jsonb_typeof\(v_plan\.steps\) = 'array' THEN v_plan\.steps/,
    );
    expect(recoverySql).toContain(
      "'infrastructure-circuit:' || v_blocker_event_id",
    );
    expect(recoverySql).toContain(
      "'requirement_execution_generation'",
    );
    expect(recoverySql.match(/v_structured_match := COALESCE\(\(/g)).toHaveLength(2);
    expect(recoverySql.match(/v_legacy_match := COALESCE\(\(/g)).toHaveLength(2);
  });

});
