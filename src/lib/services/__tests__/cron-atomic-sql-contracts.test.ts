import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function workspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const cronCapacitySql = workspaceFile(
  'supabase/migrations/20260917204500_atomic_requirement_cron_capacity.sql',
);
const cronMonthlyScopeSql = workspaceFile(
  'supabase/migrations/20260917204600_current_month_requirement_cron_scope.sql',
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
  const recoveryFenceSql = workspaceFile(
    'supabase/migrations/20260918234000_reassert_deployment_recovery_generation.sql',
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
  const activePlanSql = workspaceFile(
    'supabase/migrations/20260917203700_single_active_instance_plan.sql',
  );
  const planGateSql = workspaceFile(
    'supabase/migrations/20260918020000_atomic_plan_gate_completion.sql',
  );
  const recoveryLeaseSql = workspaceFile(
    'supabase/migrations/20260917203800_deployment_recovery_scan_lease.sql',
  );
  const blockerSql = workspaceFile(
    'supabase/migrations/20260917203300_atomic_infrastructure_block_transition.sql',
  );
  const singleTurnSource = workspaceFile(
    'src/app/api/cron/shared/single-turn-executor.ts',
  );
  const singleTurnGateSource = workspaceFile(
    'src/app/api/cron/shared/single-turn-gate.ts',
  );
  const postGateSource = workspaceFile(
    'src/app/api/cron/shared/step-archetype-postgate.ts',
  );
  const planStepsSource = workspaceFile(
    'src/app/api/robots/instance/assistant/plan-steps.ts',
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
  ];

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

  it('reasserts deployment recovery generation fencing for drifted databases', () => {
    expect(recoveryFenceSql).toContain(
      'CREATE OR REPLACE FUNCTION public.recover_ready_deployment_infrastructure',
    );
    expect(recoveryFenceSql).toContain(
      "'requirement_execution_generation'",
    );
    expect(recoveryFenceSql).toContain('v_blocker_step_matched');
    expect(recoveryFenceSql.trimEnd().split(/\r?\n/).length)
      .toBeLessThanOrEqual(500);
  });

  it('validates the latest cycle before applying product and infrastructure blocks', () => {
    expect(blockSql).toContain(
      'block_requirement_for_product_attempt_budget',
    );
    expect(accumulatedBlockSql).toContain(
      'block_requirement_for_product_no_progress',
    );
    expect(blockSql).toMatch(
      /v_latest_cycle_id IS DISTINCT FROM p_cycle_id/,
    );
    expect(requirementBlockSql).toContain(
      'block_requirement_with_provenance',
    );
    expect(requirementBlockSql).toContain(
      "'cron_blocker_event_id', p_event_id",
    );
    expect(requirementBlockSql).toContain(
      'p_expected_execution_generation',
    );
  });

  it('enforces one active plan and serializes recovery scans', () => {
    expect(activePlanSql).toContain(
      'instance_plans_one_active_per_instance_idx',
    );
    expect(activePlanSql).toContain(
      "WHERE status IN ('pending', 'in_progress', 'active', 'paused')",
    );
    expect(recoveryLeaseSql).toContain(
      'acquire_deployment_recovery_scan_lease',
    );
    expect(recoveryLeaseSql).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('prevents stale retries from restoring requirement-level blockers', () => {
    expect(blockerSql).toContain(
      'block_requirement_for_infrastructure_circuit',
    );
    expect(blockerSql).toContain(
      'v_generation IS DISTINCT FROM p_expected_generation',
    );
    expect(blockerSql).toContain(
      'block_requirement_for_cron_infrastructure_cycles',
    );
    expect(accumulatedBlockSql).toContain(
      'v_latest_cycle_id IS DISTINCT FROM p_cycle_id',
    );
    expect(accumulatedBlockSql).toContain(
      'p_expected_execution_generation integer',
    );
    expect(accumulatedBlockSql).toContain(
      'AND execution_generation = p_expected_execution_generation',
    );
  });

  it('requires an approved post-gate result before persisting completion', () => {
    const postGateGuard = singleTurnGateSource.indexOf(
      "postGate.judge_verdict !== 'approved'",
    );
    const completionWrite = singleTurnGateSource.indexOf(
      'completePlanStepAfterGateAtomically({',
      postGateGuard,
    );
    const backlogCompletion = singleTurnGateSource.indexOf(
      "status: 'done'",
      completionWrite,
    );
    expect(postGateGuard).toBeGreaterThan(-1);
    expect(completionWrite).toBeGreaterThan(postGateGuard);
    expect(backlogCompletion).toBeGreaterThan(completionWrite);
    expect(singleTurnGateSource).toContain(
      "persistedTerminalStatus = 'completed'",
    );
    expect(singleTurnGateSource).toMatch(
      /if \(!postGate\.ran\) \{[\s\S]*?transient: true/,
    );
    expect(postGateSource).not.toContain(
      "setItemStatus({ requirementId: input.requirementId",
    );
    expect(singleTurnSource).not.toContain('infra_retry_count: 0');
    expect(singleTurnSource).toContain('return await runSingleTurnGate({');
    expect(singleTurnSource).toContain('step: persistedStep');
    expect(singleTurnSource).toContain(
      'active_step_id: persistedStep.id',
    );
  });

  it('drops legacy unguarded RPC overloads', () => {
    expect(cycleSql).toContain(
      'record_requirement_cron_cycle_outcome(uuid, text, text, uuid)',
    );
    expect(blockSql).toContain(
      'block_requirement_for_infrastructure_circuit(uuid, uuid, uuid, uuid, text, integer, text, text, text)',
    );
    expect(blockSql).toContain(
      'block_requirement_for_product_attempt_budget(uuid, uuid, uuid, text, integer, text)',
    );
    expect(accumulatedBlockSql).toContain(
      'DROP FUNCTION IF EXISTS public.block_requirement_for_cron_infrastructure_cycles',
    );
    expect(requirementBlockSql).toContain(
      'DROP FUNCTION IF EXISTS public.block_requirement_with_provenance',
    );
    expect(userRecoverySql).toContain(
      'resume_instance_execution_on_user_action(uuid, boolean)',
    );
    expect(userRecoverySql).toContain(
      'resume_instance_execution_on_user_action(uuid, uuid, boolean)',
    );
  });

  it('does not convert active-plan database failures into a missing plan', () => {
    expect(planStepsSource).not.toContain(
      '[PlanSteps] Error fetching active plan:',
    );
  });
});

describe('fallback discovery contracts', () => {
  const fallbackSource = workspaceFile(
    'src/lib/services/deployment-infrastructure-fallback.ts',
  );

  it('streams active wait pages and supports runner-based legacy lookup', () => {
    expect(fallbackSource).toContain(
      "query.gt('id', cursorId)",
    );
    expect(fallbackSource).toContain(
      'for await (const candidates of streamActiveDeploymentCandidatePages',
    );
    expect(fallbackSource).toContain(
      'acquire_deployment_recovery_scan_lease',
    );
    expect(fallbackSource).toContain('runner_instance_id');
    expect(fallbackSource).toContain(
      ".eq('instance_id', runnerInstanceId)",
    );
    expect(fallbackSource).toContain(
      ".contains('steps', [{",
    );
    expect(fallbackSource).not.toContain(
      'CRON_DEPLOYMENT_RECOVERY_MAX_PAGES',
    );
  });

  it('requires an allowlist and deployment-specific blocked audit', () => {
    expect(fallbackSource).toContain(
      'CRON_LEGACY_DEPLOYMENT_RECOVERY_IDS',
    );
    expect(fallbackSource).toContain(
      "status.data?.stage === 'blocked'",
    );
    expect(fallbackSource).not.toContain(
      'main builder hit',
    );
  });
});
