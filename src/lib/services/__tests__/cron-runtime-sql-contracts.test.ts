import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function workspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const cycleSql = workspaceFile(
  'supabase/migrations/20260917203000_atomic_cron_cycle_accounting.sql',
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
const activePlanSql = workspaceFile(
  'supabase/migrations/20260917203700_single_active_instance_plan.sql',
);
const recoveryLeaseSql = workspaceFile(
  'supabase/migrations/20260917203800_deployment_recovery_scan_lease.sql',
);
const userRecoverySql = workspaceFile(
  'supabase/migrations/20260917203600_atomic_instance_execution_resume.sql',
);
const legacyGlobalBlockRecoverySql = workspaceFile(
  'supabase/migrations/20260921143000_recover_legacy_global_requirement_blocks.sql',
);
const legacyVerificationCounterSql = workspaceFile(
  'supabase/migrations/20260921143100_reset_legacy_unbounded_verification_counters.sql',
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

describe('cron runtime SQL contracts', () => {
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
    expect(blockSql).toContain(
      'block_requirement_for_infrastructure_circuit',
    );
    expect(blockSql).toContain(
      'v_generation IS DISTINCT FROM p_expected_generation',
    );
    expect(blockSql).toContain(
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

  it('recovers only active legacy global blocks with runnable alternatives', () => {
    expect(legacyGlobalBlockRecoverySql).toContain(
      "requirement.status = 'blocked'",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      "instance.status = 'running'",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      'requirement.cron IS NULL',
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      "metadata ? 'cron_blocker_provenance'",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      "item.value->>'status' IN ('pending', 'in_progress')",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      "item.value->'depends_on'",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      "step.value->'metadata'->>'backlog_item_id'",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      "IN ('pending', 'in_progress', 'failed')",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      "'status', 'cancelled'",
    );
    expect(legacyGlobalBlockRecoverySql).toContain(
      'resume_instance_execution_on_user_action',
    );
    expect(legacyGlobalBlockRecoverySql).not.toContain(
      "instance.status = 'paused'",
    );
  });

  it('resets active legacy verification counters at or above the new cap', () => {
    expect(legacyVerificationCounterSql).toContain(
      "IN ('pending', 'in_progress')",
    );
    expect(legacyVerificationCounterSql).toContain(
      "'{tool_failures,evidence_collector}'",
    );
    expect(legacyVerificationCounterSql).toContain(
      "'{tool_failures,acceptance_contract}'",
    );
    expect(legacyVerificationCounterSql).toContain('::integer >= 3');
    expect(legacyVerificationCounterSql).not.toContain('::integer > 3');
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
    expect(singleTurnSource).toContain(
      'const gateResult = await runSingleTurnGate({',
    );
    expect(singleTurnSource).toContain(
      'return { ...gateResult, durableProductProgress };',
    );
    expect(singleTurnSource).toContain('step: persistedStep');
    expect(singleTurnSource).toContain(
      'active_step_id: persistedStep.id',
    );
    expect(postGateSource).toMatch(
      /computeFeatureCoverage\(\{[\s\S]*?item: adjudicatedItem,[\s\S]*?contractScoped:/,
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
    expect(fallbackSource).toContain("query.gt('id', cursorId)");
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
    expect(fallbackSource).toContain(".contains('steps', [{");
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
    expect(fallbackSource).not.toContain('main builder hit');
  });
});
