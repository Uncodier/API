import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function workspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('requirements workflow ordering contracts', () => {
  const cronCapacitySql = workspaceFile(
    'supabase/migrations/20260917204500_atomic_requirement_cron_capacity.sql',
  );
  const cronMonthlyScopeSql = workspaceFile(
    'supabase/migrations/20260926070000_harness_execution_ownership.sql',
  );
  const workflowSource = workspaceFile(
    'src/app/api/cron/requirements-apps/workflow.ts',
  );
  const finalizerSource = workspaceFile(
    'src/app/api/cron/shared/cron-workflow-finalize.ts',
  );
  const routeSource = workspaceFile(
    'src/app/api/cron/requirements-apps/route.ts',
  );
  const routeStateSource = workspaceFile(
    'src/app/api/cron/requirements-apps/route-state.ts',
  );
  const runLockSource = workspaceFile(
    'src/app/api/cron/shared/cron-run-lock.ts',
  );
  const singleTurnExecutorSource = workspaceFile(
    'src/app/api/cron/shared/single-turn-executor.ts',
  );
  const noProgressGateSource = workspaceFile(
    'src/app/api/cron/shared/no-progress-gate-adjudicator.ts',
  );
  const stepGitGateSource = workspaceFile(
    'src/app/api/cron/shared/step-git-gate.ts',
  );

  it('derives progress from the persisted final plan delta', () => {
    const finalPlanRead = workflowSource.indexOf(
      'getInstancePlanByIdStep(activePlan.id)',
    );
    const progressAssignment = workflowSource.indexOf(
      'cycleOutcome = finalizePlanCycleOutcome({',
      finalPlanRead,
    );
    expect(finalPlanRead).toBeGreaterThan(-1);
    expect(progressAssignment).toBeGreaterThan(finalPlanRead);
  });

  it('records the cycle before releasing its lock', () => {
    const accountingCall = workflowSource.lastIndexOf(
      'recordCronCycleOutcomeStep({',
    );
    const lockRelease = workflowSource.lastIndexOf(
      'releaseRunLockStep(reqId, cronLockRunId)',
    );
    expect(accountingCall).toBeGreaterThan(-1);
    expect(lockRelease).toBeGreaterThan(accountingCall);
  });

  it('runs no-progress adjudication through the gate without another assistant turn', () => {
    const adjudicationBranch = singleTurnExecutorSource.indexOf(
      'if (noProgressAdjudication) {',
    );
    const assistantTurn = singleTurnExecutorSource.indexOf(
      'const result = await executeAssistantStep',
      adjudicationBranch,
    );
    const branchSource = singleTurnExecutorSource.slice(
      adjudicationBranch,
      assistantTurn,
    );

    expect(adjudicationBranch).toBeGreaterThan(-1);
    expect(assistantTurn).toBeGreaterThan(adjudicationBranch);
    expect(branchSource).toContain(
      'return runGateOnlyNoProgressAdjudication({',
    );
    expect(branchSource).not.toContain('executeAssistantStep(');
    const gateCall = noProgressGateSource.indexOf(
      'const result = await runSingleTurnGate({',
    );
    const consumeCall = noProgressGateSource.indexOf(
      'const mutation = await persistAdjudication({',
      gateCall,
    );
    expect(gateCall).toBeGreaterThan(-1);
    expect(consumeCall).toBeGreaterThan(gateCall);
    expect(noProgressGateSource).not.toContain('executeAssistantStep(');
  });

  it('does not continue from stale infrastructure mutations', () => {
    expect(workflowSource).toContain("infra.state !== 'applied' &&");
    expect(workflowSource).toContain("clearResult.state !== 'applied'");
    expect(workflowSource).toContain('if (!completionMutation.persisted)');
    expect(workflowSource).toContain('turnRes.infrastructureGeneration ??');
  });

  it('continues completed plan steps within the bounded cycle budget', () => {
    const completionBranch = workflowSource.indexOf(
      "if (turnRes.persistedTerminalStatus === 'completed')",
    );
    const nextTerminalBranch = workflowSource.indexOf(
      "if (turnRes.persistedTerminalStatus === 'failed')",
      completionBranch,
    );
    const branchSource = workflowSource.slice(
      completionBranch,
      nextTerminalBranch,
    );

    expect(branchSource).toContain('break;');
    expect(branchSource).not.toContain('break outer;');
    expect(workflowSource).toContain('CRON_MAX_STEPS_PER_CYCLE');
    expect(workflowSource).toContain('MIN_NEXT_STEP_BUDGET_MS');
    expect(workflowSource).toContain(
      'remainingExecutionMs < MIN_NEXT_STEP_BUDGET_MS',
    );
    expect(workflowSource).toContain('continue outer;');
  });

  it('checkpoints intermediate steps after any declared runtime contract', () => {
    const runtimeGate = stepGitGateSource.indexOf(
      'const runtimeOutcome = await runRuntimeAndVisualProbes',
    );
    const originGate = stepGitGateSource.indexOf(
      'const recovery = await verifyOriginAndRecover(params)',
    );
    const intermediateReturn = stepGitGateSource.indexOf(
      'if (intermediateGate)',
      originGate,
    );

    expect(runtimeGate).toBeGreaterThan(-1);
    expect(originGate).toBeGreaterThan(runtimeGate);
    expect(intermediateReturn).toBeGreaterThan(originGate);
    expect(stepGitGateSource).toContain(
      'declaredOnly: intermediateGate',
    );
    expect(stepGitGateSource).toContain(
      "params.validationScope === 'intermediate'",
    );
    expect(stepGitGateSource).toContain('lightweightCheckpoint');
    expect(stepGitGateSource).toContain('if (!r.pushed)');
    expect(stepGitGateSource).toContain(
      'unavailableDeclaredTargets.length > 0',
    );
  });

  it('checks execution generation before final status side effects', () => {
    const finalStatusCall = workflowSource.indexOf('createFinalStatusStep({');
    const generationGuard = workflowSource.lastIndexOf(
      'isRequirementExecutionCurrentStep(',
      finalStatusCall,
    );
    expect(generationGuard).toBeGreaterThan(-1);
    expect(generationGuard).toBeLessThan(finalStatusCall);
    expect(finalizerSource).toContain('expectedExecutionGeneration: number');
    expect(finalizerSource).toContain("state: 'applied' | 'stale'");
  });

  it('claims one runnable candidate at a time under one global capacity lock', () => {
    expect(cronCapacitySql).toContain('pg_advisory_xact_lock');
    expect(cronCapacitySql).toContain('FOR UPDATE SKIP LOCKED');
    expect(cronCapacitySql).toContain('p_max_concurrent - v_active');
    expect(cronCapacitySql).toContain('LIMIT 1');
    expect(cronCapacitySql).toContain('p_excluded_ids');
    expect(cronCapacitySql).toContain("interval '30 minutes'");
    expect(cronCapacitySql).toContain("'state', 'capacity_full'");
    expect(cronCapacitySql).toContain("'state', 'claimed'");
    expect(cronCapacitySql).toContain(
      'ADD COLUMN IF NOT EXISTS cron_lock_active boolean',
    );
    expect(cronCapacitySql).toContain(
      'CREATE OR REPLACE FUNCTION public.activate_requirement_cron_run',
    );
    expect(cronCapacitySql).toContain('AND cron_lock_active = true');
    expect(cronCapacitySql).toContain('cron_lock_active = false');
    expect(cronCapacitySql).toContain('cron_lock_active = true,');
    expect(cronCapacitySql).toContain("'request.jwt.claims'");
    expect(cronCapacitySql).toContain('{"role":"service_role"}');
    expect(cronCapacitySql).not.toContain('DISABLE TRIGGER');
    expect(cronCapacitySql).toContain(
      "COALESCE(requirement.status, '') NOT IN ('backlog', 'in-progress')",
    );
    expect(cronMonthlyScopeSql).not.toContain(
      "pg_catalog.date_trunc('month', v_now AT TIME ZONE 'UTC')",
    );
    expect(cronMonthlyScopeSql).not.toContain(
      'requirement.created_at >= v_month_start',
    );
    expect(cronMonthlyScopeSql).not.toContain(
      'requirement.updated_at >= v_month_start',
    );
    expect(routeStateSource).toContain(
      "'claim_requirement_cron_candidates'",
    );
    expect(routeStateSource).toContain(
      "'activate_requirement_cron_run'",
    );
    expect(runLockSource).toContain('cron_lock_active: false');
    expect(routeSource).toContain('claimRequirementsForCronRun(');
    expect(routeSource).toContain(
      'while (evaluatedRequirementIds.length < evaluationLimit)',
    );
    expect(routeSource).not.toContain('acquireRunLock(reqId)');
    expect(routeSource).not.toContain('oneMonthAgo');
    expect(routeSource).not.toContain('.limit(10);\n\n    if (!requirements');
    expect(routeSource).toMatch(
      /\.from\('requirements'\)\s*\.select\('\*'\)\s*\.eq\('id', reqId\)/,
    );
  });
});
