import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function workspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('requirements workflow ordering contracts', () => {
  const cronCapacitySql = workspaceFile(
    'supabase/migrations/20260917204500_atomic_requirement_cron_capacity.sql',
  );
  const ownershipSql = workspaceFile(
    'supabase/migrations/20260926070000_harness_execution_ownership.sql',
  );
  const cronMonthlyScopeSql = workspaceFile(
    'supabase/migrations/20260926090000_restore_current_month_requirement_cron_scope.sql',
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
  const migrationVerificationSource = workspaceFile(
    'src/app/api/cron/shared/step-db-migration-verification.ts',
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

  it('uses receipt-only migration verification before checkpointing and again after recovery before delivery', () => {
    const firstVerification = workflowSource.indexOf('await verifyDatabaseMigrationsStep(');
    const checkpoint = workflowSource.indexOf('await commitAndPushStep(', firstVerification);
    const buildRecovery = workflowSource.indexOf('await postFinallyBuildStep(', checkpoint);
    const finalVerification = workflowSource.indexOf('await verifyDatabaseMigrationsStep(', firstVerification + 1);
    const deliveryWrapup = workflowSource.indexOf('await emitCycleWrapUpStep(', finalVerification);
    const finalStatus = workflowSource.indexOf('await createFinalStatusStep(', finalVerification);

    expect(firstVerification).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(firstVerification);
    expect(buildRecovery).toBeGreaterThan(checkpoint);
    expect(finalVerification).toBeGreaterThan(buildRecovery);
    expect(deliveryWrapup).toBeGreaterThan(finalVerification);
    expect(finalStatus).toBeGreaterThan(deliveryWrapup);
    expect(workflowSource.match(/await verifyDatabaseMigrationsStep\(/g)).toHaveLength(2);
    expect(workflowSource.slice(firstVerification, checkpoint)).toContain("databaseMigrations?.status !== 'failed'");
    expect(workflowSource.slice(finalVerification, deliveryWrapup)).toContain("recoveryDisposition = 'retry'");
    expect(workflowSource.slice(finalVerification, deliveryWrapup)).toContain('return { reqId, branch: effectiveBranch, previewUrl, status: cycleOutcome }');
    expect(migrationVerificationSource).toContain('await verifyPendingMigrations(');
    expect(migrationVerificationSource).not.toMatch(/\b(?:applyPendingMigrations|applyDatabaseMigrationsStep|repairDatabaseMigrationStep)\s*\(/);
    expect(workflowSource).not.toMatch(/\b(?:applyDatabaseMigrationsStep|repairDatabaseMigrationStep|scheduleMigrationCorrectionStep|verifyPendingMigrationLifecycleStep|holdMigrationLifecycleStep)\s*\(/);
  });

  it('reads historical migration obligations without silently reopening or replacing them', () => {
    const historicalRead = workflowSource.indexOf('await loadMigrationLifecycleStep(reqId)');
    const historicalGuard = workflowSource.indexOf("migrationLifecycle.some(row => row.state !== 'validated' && row.state !== 'transferred')", historicalRead);
    const activePlanRead = workflowSource.indexOf('await getActiveInstancePlanStep(');
    expect(historicalRead).toBeGreaterThan(-1);
    expect(historicalGuard).toBeGreaterThan(historicalRead);
    expect(activePlanRead).toBeGreaterThan(historicalGuard);
    expect(workflowSource.slice(historicalGuard, activePlanRead)).toContain("status: 'blocked' as const");
    expect(workflowSource.match(/await loadMigrationLifecycleStep\(/g)).toHaveLength(1);
    expect(workflowSource).not.toContain('migrationPlanRecovery');
  });

  it('does not fast-track app or site completion ahead of required receipt verification', () => {
    const fastTrack = workflowSource.indexOf("update({ status: 'on-review'");
    const receiptRequirementGuard = workflowSource.lastIndexOf(
      'if (trulyDone && !requirementFlow.delivery.apply_database_migrations)', fastTrack,
    );
    expect(fastTrack).toBeGreaterThan(-1);
    expect(receiptRequirementGuard).toBeGreaterThan(-1);
    expect(receiptRequirementGuard).toBeLessThan(fastTrack);
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
    expect(ownershipSql).toContain(
      "'requirement_execution_generation'",
    );
    expect(cronMonthlyScopeSql).toContain(
      "pg_catalog.date_trunc('month', v_now AT TIME ZONE 'UTC')",
    );
    expect(cronMonthlyScopeSql).toContain(
      'requirement.created_at >= v_month_start',
    );
    expect(cronMonthlyScopeSql).toContain(
      'requirement.updated_at >= v_month_start',
    );
    expect(cronMonthlyScopeSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(cronMonthlyScopeSql).toContain('RETURNING requirement.* INTO v_requirement');
    expect(cronMonthlyScopeSql).toContain("'requirement_execution_generation'");
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
