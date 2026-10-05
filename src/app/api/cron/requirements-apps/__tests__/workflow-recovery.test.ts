import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as cyclePolicy from '../../shared/plan-cycle-outcome';
import * as recoveryPolicy from '../../shared/cycle-recovery-policy';
import * as ownershipRejection from '../../shared/cron-ownership-rejection';
import * as adjudication from '../../shared/no-progress-adjudication';
import { getFlow, classifyRequirementType, productAttemptLimits } from '@/lib/services/requirement-flows';
import { activeBacklogItemIdsFromPlanSteps, countPendingPlanSteps, hasRunnableBacklogWork } from '@/lib/services/cycle-wrapup-prompt';

/** Real workflow control flow; every I/O dependency is an explicit local fake. */
function harness(options: { maxTurns?: number; type?: string } = {}) {
  const plan: any = { id: 'plan', title: 'Implement', steps: [{
    id: 'step', order: 1, title: 'Work', instructions: 'Build', status: 'in_progress', infrastructure_generation: 0, backlog_item_id: 'item',
  }] };
  const lifecycle = {
    assertCronExecutionOwnershipStep: jest.fn(async (_ownership?: unknown) => {}),
    createSandboxStep: jest.fn(async () => ({ sandboxId: 'sandbox', branchName: 'feature', workDir: '/sandbox', instanceType: 'applications', isNewBranch: false })),
    stopSandboxStep: jest.fn(async (): Promise<{ stopped: boolean } | undefined> => ({ stopped: true })),
    extendRunLockStep: jest.fn(async () => {}),
    releaseRunLockStep: jest.fn(async () => {}),
  };
  const db = {
    recordRequirementBlockedStep: jest.fn(async (_params?: unknown) => ({ ok: true, error: undefined as string | undefined })),
    checkInstanceAndPlanStatusStep: jest.fn(async () => ({ isPaused: false })),
    getRequirementFullContextStep: jest.fn(async (): Promise<any> => ({ backlog: { items: [{ id: 'item', status: 'in_progress' }] } })),
    isRequirementExecutionCurrentStep: jest.fn(async () => true),
    updateInstanceStatusStep: jest.fn(async () => {}),
    syncCompletedPlanBacklogStep: jest.fn(async () => ({})),
    recordCronCycleOutcomeStep: jest.fn(async (_params?: unknown): Promise<any> => ({ is_latest: false })),
  };
  const steps = {
    getActiveInstancePlanStep: jest.fn(async () => plan),
    getInstancePlanByIdStep: jest.fn(async () => plan),
    checkRecentPlansGuardStep: jest.fn(async () => ({ shouldSkipOrchestrator: false, shouldBlockRequirement: false, recentCount: 0 })),
    cleanupNestedProjectsStep: jest.fn(async () => ({ effectiveSandboxId: 'sandbox' })),
    reconcilePlanStep: jest.fn(async () => 'in_progress'),
    commitAndPushStep: jest.fn(async (): Promise<any> => ({ ok: true, pushed: true, branch: 'feature', commitCount: 1 })),
    postFinallyBuildStep: jest.fn(async (): Promise<any> => ({ ok: true, effectiveSandboxId: 'sandbox' })),
    getPreviewUrlStep: jest.fn(async () => 'https://preview.example.invalid'),
  };
  const executeSingleTurnStep = jest.fn(async (_params?: unknown): Promise<any> => ({ ok: true, isDone: false, durableProductProgress: true }));
  const verification = { verifyDatabaseMigrationsStep: jest.fn(async (): Promise<any> => ({ status: 'passed', applied: [], errors: [], effectiveSandboxId: 'sandbox' })) };
  // Legacy dependencies stay observable so regressions cannot silently reintroduce SQL writes or repair agents.
  const migration = { applyDatabaseMigrationsStep: jest.fn(async (): Promise<any> => ({ status: 'passed', applied: [], errors: [], effectiveSandboxId: 'sandbox' })) };
  const repair = { repairDatabaseMigrationStep: jest.fn(async (): Promise<any> => ({ changed: false, done: false, messages: [], effectiveSandboxId: 'sandbox' })) };
  const gate = { runGateStep: jest.fn(async (): Promise<any> => ({ passed: true, effectiveSandboxId: 'sandbox' })) };
  const migrationLifecycle = {
    loadMigrationLifecycleStep: jest.fn(async (): Promise<any[]> => []),
    loadMigrationSourcePlanStep: jest.fn(async () => plan),
    scheduleMigrationCorrectionStep: jest.fn(async (): Promise<any> => ({ scheduled: true, internalReview: false })),
    verifyPendingMigrationLifecycleStep: jest.fn(async () => ({ passed: true, effectiveSandboxId: 'sandbox' })),
    holdMigrationLifecycleStep: jest.fn(async () => {}),
  };
  const finalizer = {
    createFinalStatusStep: jest.fn(async () => ({ state: 'applied', effectiveStatus: 'in-progress' })),
    validateDeliverablesStep: jest.fn(async () => ({ repoOk: true, previewOk: true })),
  };
  const wrapup = {
    emitCycleWrapUpStep: jest.fn(async (_params?: unknown) => ({ ran: true, outcome: 'completed' })),
    emitCycleTechnicalEscalationStep: jest.fn(async (_params?: unknown) => ({ state: 'not_eligible', email_sent: false })),
  };
  const circuits = { scopeProductNoProgressCircuitStep: jest.fn(async (_params?: unknown) => ({ requirementBlocked: false, itemIsolated: false })) };
  const technicalReviewBacklogItems = jest.fn((): any[] => []);
  const execution = {
    selectPlanStepsForExecution: (input: any[]) => input.filter(step => step.status === 'in_progress'),
    getPlanExecutionGateStep: jest.fn(async (): Promise<any> => ({ runnable: true })),
    clearStepInfrastructureStateStep: jest.fn(async () => ({ state: 'applied', cleared: true, generation: 1 })),
    updatePlanStepStatusStep: jest.fn(async () => ({ persisted: true })),
    recordStepInfraTransientStep: jest.fn(async () => ({ state: 'applied', circuitOpen: false, generation: 1 })),
    logCronInfrastructureEventStep: jest.fn(async () => {}),
    blockRequirementForCronInfrastructureCyclesStep: jest.fn(async (_params?: unknown) => false),
  };
  const provisionTrackingScriptStep = jest.fn(async (_params?: unknown): Promise<{ injected: boolean; error?: string }> => ({ injected: true }));
  const orchestrator = { runOrchestratorStep: jest.fn(async (_params?: unknown) => ({ createdPlan: true, timedOut: false, effectiveSandboxId: 'sandbox' })) };
  const workflow = loadRuntimeModule<typeof import('../workflow')>(
    'src/app/api/cron/requirements-apps/workflow.ts', {
      '../shared/cron-steps': steps,
      '../shared/cron-sandbox-lifecycle-steps': lifecycle,
      '../shared/workflow-db-steps': db,
      '../shared/step-db-migration-verification': { ...verification, loadMigrationLifecycleStep: migrationLifecycle.loadMigrationLifecycleStep },
      '../shared/step-db-migrations': migration,
      '../shared/step-db-migration-repair': repair,
      '../shared/migration-lifecycle-steps': migrationLifecycle,
      '../shared/bootstrap-spec-step': { bootstrapRequirementSpecStep: async () => {} },
      '../shared/tracking-script-step': { provisionTrackingScriptStep },
      '../shared/ensure-source-archive-step': { ensureSourceArchiveStep: async () => 'https://archive.example.invalid/source.zip' },
      '@/lib/services/requirement-git-binding': { getRequirementGitBinding: async () => ({ org: 'fixture', repo: 'app' }) },
      '../shared/docs-digest-step': { emitDocsDigestStep: async () => ({}) },
      '../shared/sync-docs-to-backlog-step': { emitSyncDocsToBacklogStep: async () => {} },
      '@/lib/services/requirement-flows': {
        getFlow: (kind: Parameters<typeof getFlow>[0]) => {
          const flow = getFlow(kind);
          return options.maxTurns === undefined ? flow : {
            ...flow, cost_envelope: { ...flow.cost_envelope, max_turns_per_step: options.maxTurns },
          };
        },
        classifyRequirementType, productAttemptLimits,
      },
      '@/lib/services/cycle-wrapup-prompt': {
        activeBacklogItemIdsFromPlanSteps, countPendingPlanSteps,
        feedbackRequiredBacklogItems: () => [], technicalReviewBacklogItems,
        hasRunnableBacklogWork,
      },
      '../shared/cron-execute-steps-phase': execution,
      '../shared/cron-blocker-scope-steps': circuits,
      '../shared/single-turn-executor': { executeSingleTurnStep },
      '../shared/gate-step-executor': gate,
      '../shared/cron-orchestrator-step': orchestrator,
      '../shared/cron-workflow-finalize': finalizer,
      '../shared/platform-key-step': { provisionPlatformKeyStep: async () => ({ injected_env_keys: [] }) },
      '../shared/admin-loop-step': { detectAdminLoopStep: async () => ({ triggered: false }) },
      '@/lib/services/sandbox-gone-error': { isSandboxGoneError: () => false },
      './prompt': { buildCoordinatorPromptForFlow: () => '' },
      workflow: { sleep: async () => {} },
      '@/lib/services/cron-infrastructure-state': {},
      '../shared/plan-cycle-outcome': cyclePolicy,
      '../shared/no-progress-adjudication': adjudication,
      '../shared/cycle-recovery-policy': recoveryPolicy,
      '../shared/cron-ownership-rejection': ownershipRejection,
      '../shared/cycle-wrapup-step': wrapup,
      '@/lib/services/requirement-backlog': { isBacklogComplete: () => false, hasOutstandingWork: () => true, isOrnamentalOnlyOutstanding: () => false },
    },
  );
  const run = () => workflow.runCronAppsWorkflow({ reqId: 'req', title: 'Test', instructions: '', type: options.type || 'app',
    site_id: 'site', user_id: 'user', instanceId: 'instance', previousWorkContext: '', instance_type: 'applications',
    cronLockRunId: 'run', cycleStartedAt: '2026-09-26T00:00:00Z', executionGeneration: 3 });
  return { run, plan, lifecycle, db, steps, executeSingleTurnStep, execution, verification, migration, repair, gate, finalizer, wrapup, provisionTrackingScriptStep, migrationLifecycle, technicalReviewBacklogItems, orchestrator, circuits };
}

function expectNoMigrationOrchestration(h: ReturnType<typeof harness>) {
  expect(h.migration.applyDatabaseMigrationsStep).not.toHaveBeenCalled();
  expect(h.repair.repairDatabaseMigrationStep).not.toHaveBeenCalled();
  expect(h.gate.runGateStep).not.toHaveBeenCalled();
  expect(h.migrationLifecycle.loadMigrationSourcePlanStep).not.toHaveBeenCalled();
  expect(h.migrationLifecycle.scheduleMigrationCorrectionStep).not.toHaveBeenCalled();
  expect(h.migrationLifecycle.verifyPendingMigrationLifecycleStep).not.toHaveBeenCalled();
  expect(h.migrationLifecycle.holdMigrationLifecycleStep).not.toHaveBeenCalled();
  expect(h.db.recordRequirementBlockedStep).not.toHaveBeenCalled();
}

describe('workflow recovery and truthful completion', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('reports terminal backlog review without a new sandbox, plan, attempt reset or customer question', async () => {
    const h = harness();
    h.plan.steps = [];
    const failed = { id: 'item', status: 'needs_review', attempts: 4 };
    h.db.getRequirementFullContextStep.mockResolvedValue({ backlog: { items: [failed] } });
    h.technicalReviewBacklogItems.mockReturnValue([failed]);
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'internal_review', requiresUserFeedback: false,
    }));
  });

  it('does not request user intervention on the first infrastructure failure', async () => {
    const h = harness();
    h.db.checkInstanceAndPlanStatusStep.mockRejectedValueOnce(new Error('Transient database unavailable'));
    await expect(h.run()).rejects.toThrow('Transient database unavailable');
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'retry', requiresUserFeedback: false,
    }));
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'infrastructure_retry' }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it.each(['correction_required', 'validation_pending', 'platform_review', 'reviewing', 'unknown', null, undefined])(
    'keeps historical %s obligations blocked without reopening, writing holds, or creating a repair plan', async state => {
    const h = harness();
    const row = { state, file: 'migrations/0001.sql', attempts: 5 };
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([row]);
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.migrationLifecycle.loadMigrationLifecycleStep).toHaveBeenCalledTimes(1);
    expect(h.migrationLifecycle.loadMigrationLifecycleStep).toHaveBeenCalledWith('req');
    expect(row).toEqual({ state, file: 'migrations/0001.sql', attempts: 5 });
    expect(h.steps.getActiveInstancePlanStep).not.toHaveBeenCalled();
    expect(h.orchestrator.runOrchestratorStep).not.toHaveBeenCalled();
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'internal_review', requiresUserFeedback: false,
      wrapUpReason: expect.stringContaining('historical migration obligation needs reconciliation'),
    }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it.each(['correction_required', 'validation_pending'])('does not create a missing plan or diagnostic sandbox for historical %s', async state => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state, attempts: 5 }]);
    h.steps.getActiveInstancePlanStep.mockResolvedValue(null);
    h.migrationLifecycle.loadMigrationSourcePlanStep.mockResolvedValue(null);
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.steps.getActiveInstancePlanStep).not.toHaveBeenCalled();
    expect(h.orchestrator.runOrchestratorStep).not.toHaveBeenCalled();
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('does not let a completed backlog item bypass an unresolved historical validation obligation', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'validation_pending' }]);
    h.db.getRequirementFullContextStep.mockResolvedValue({ backlog: { items: [{ id: 'item', status: 'done' }] } });
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.execution.getPlanExecutionGateStep).not.toHaveBeenCalled();
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('keeps historical lifecycle read failures retryable without creating holds or touching SQL', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockRejectedValue(new Error('Historical ledger unavailable'));
    await expect(h.run()).rejects.toThrow('Historical ledger unavailable');
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'retry', requiresUserFeedback: false }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it.each(['validated', 'transferred'])('permits normal execution for %s history without creating or advancing a lifecycle', async state => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state }]);
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.migrationLifecycle.loadMigrationLifecycleStep).toHaveBeenCalledTimes(1);
    expect(h.executeSingleTurnStep).toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expectNoMigrationOrchestration(h);
  });

  it('does not complete a transferred obligation when normal SQL receipt verification fails', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'transferred' }]);
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue({ status: 'failed', applied: [],
      errors: ['Unapplied migration proposals remain'], failureKind: 'product', effectiveSandboxId: 'sandbox' });
    await h.run();
    expect(h.executeSingleTurnStep).toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('does not ignore an unresolved row in a partially validated historical batch', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([
      { state: 'validated' }, { state: 'validation_pending' }, { state: 'correction_required' },
    ]);
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('releases the run lock even when the accounting ledger is unavailable', async () => {
    const h = harness();
    h.db.checkInstanceAndPlanStatusStep.mockRejectedValueOnce(new Error('Transient failure'));
    h.db.recordCronCycleOutcomeStep.mockRejectedValue(new Error('Ledger unavailable'));
    await expect(h.run()).rejects.toThrow('Transient failure');
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('checks support only after latest no-progress accounting actually blocks the requirement: %s', async requirementBlocked => {
    const h = harness();
    h.plan.steps[0].metadata = { no_progress_adjudication: { state: 'consumed', execution_generation: 3 } };
    h.db.recordCronCycleOutcomeStep.mockResolvedValue({ is_latest: true, recorded_outcome: 'product_no_progress', no_progress_cycles: 3 });
    h.circuits.scopeProductNoProgressCircuitStep.mockResolvedValue({ requirementBlocked, itemIsolated: !requirementBlocked });
    await h.run();
    expect(h.wrapup.emitCycleTechnicalEscalationStep).toHaveBeenCalledTimes(requirementBlocked ? 1 : 0);
    if (requirementBlocked) {
      expect(h.wrapup.emitCycleTechnicalEscalationStep).toHaveBeenCalledWith(expect.objectContaining({
        requirementId: 'req', runId: 'run', executionGeneration: 3,
        sandboxStopped: true, requirementBlocked: true,
        settle: { planId: 'plan', stepId: 'step', expectedGeneration: 1 },
      }));
      expect(h.wrapup.emitCycleTechnicalEscalationStep.mock.invocationCallOrder[0])
        .toBeGreaterThan(h.circuits.scopeProductNoProgressCircuitStep.mock.invocationCallOrder[0]);
      expect(h.wrapup.emitCycleTechnicalEscalationStep.mock.invocationCallOrder[0])
        .toBeGreaterThan(h.lifecycle.stopSandboxStep.mock.invocationCallOrder[0]);
    }
    expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
  });

  it.each([false, true])('checks support only after latest infrastructure accounting actually blocks: %s', async requirementBlocked => {
    const h = harness();
    h.db.recordCronCycleOutcomeStep.mockResolvedValue({ is_latest: true, recorded_outcome: 'infrastructure_retry', infrastructure_failure_cycles: 4 });
    h.execution.blockRequirementForCronInfrastructureCyclesStep.mockResolvedValue(requirementBlocked);
    await h.run();
    expect(h.wrapup.emitCycleTechnicalEscalationStep).toHaveBeenCalledTimes(requirementBlocked ? 1 : 0);
    if (requirementBlocked) expect(h.wrapup.emitCycleTechnicalEscalationStep).toHaveBeenCalledWith(expect.objectContaining({
      sandboxStopped: true, requirementBlocked: true, settle: { planId: 'plan', stepId: 'step', expectedGeneration: 1 },
    }));
    expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
  });

  it('does not check support for superseded accounting or a pending adjudication', async () => {
    const h = harness();
    h.db.recordCronCycleOutcomeStep.mockResolvedValue({ is_latest: false, recorded_outcome: 'product_no_progress', no_progress_cycles: 3 });
    await h.run();
    expect(h.wrapup.emitCycleTechnicalEscalationStep).not.toHaveBeenCalled();
    h.plan.steps[0].metadata = { no_progress_adjudication: { state: 'requested', execution_generation: 3 } };
    h.db.recordCronCycleOutcomeStep.mockResolvedValue({ is_latest: true, recorded_outcome: 'product_no_progress', no_progress_cycles: 3 });
    await h.run();
    expect(h.circuits.scopeProductNoProgressCircuitStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleTechnicalEscalationStep).not.toHaveBeenCalled();
  });

  it.each(['product_no_progress', 'infrastructure_retry'])('does not settle or escalate %s when sandbox shutdown is false or unknown', async recorded_outcome => {
    for (const stopResult of [{ stopped: false }, undefined]) {
      const h = harness();
      h.lifecycle.stopSandboxStep.mockResolvedValue(stopResult);
      h.plan.steps[0].metadata = { no_progress_adjudication: { state: 'consumed', execution_generation: 3 } };
      h.db.recordCronCycleOutcomeStep.mockResolvedValue({ is_latest: true, recorded_outcome, no_progress_cycles: 3, infrastructure_failure_cycles: 4 });
      h.circuits.scopeProductNoProgressCircuitStep.mockResolvedValue({ requirementBlocked: true, itemIsolated: false });
      h.execution.blockRequirementForCronInfrastructureCyclesStep.mockResolvedValue(true);
      await h.run();
      expect(h.wrapup.emitCycleTechnicalEscalationStep).not.toHaveBeenCalled();
      expect(h.plan.steps[0].status).toBe('in_progress');
      expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
    }
  });

  it('does not touch the sandbox or report status after ownership has been lost', async () => {
    const h = harness();
    h.lifecycle.assertCronExecutionOwnershipStep.mockRejectedValue(new Error('Stale owner'));
    await expect(h.run()).rejects.toThrow('Stale owner');
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
    expect(h.lifecycle.stopSandboxStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
    expect(h.db.updateInstanceStatusStep).not.toHaveBeenCalled();
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  const productEvidence = 'POST /api/drivers/register -> 400: invalid nested payload. Product attempt budget exhausted after 3 attempts.';
  const notRunnable = () => new Error('Cron execution ownership rejected (execution_not_runnable)');
  const exhaustedTurn = {
    ok: true, isDone: true, gatePassed: false, persistedTerminalStatus: 'cancelled',
    gateFailureKind: 'product_defect', judgeAdjudicated: true, gateErrorExcerpt: productEvidence,
  };
  function exhaustProduct(h: ReturnType<typeof harness>) {
    h.executeSingleTurnStep.mockImplementation(async () => {
      h.plan.steps[0].status = 'cancelled';
      h.db.getRequirementFullContextStep.mockResolvedValue({ backlog: { items: [{
        id: 'item', status: 'needs_review', attempts: 3,
        review_quarantine: { active: true, reason: 'Product budget exhausted after 3; operator review required.' },
      }] } });
      return exhaustedTurn;
    });
  }

  it('treats exhausted product cancellation as control flow, keeping the runtime failure and skipping delivery', async () => {
    const h = harness();
    exhaustProduct(h);
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.executeSingleTurnStep).toHaveBeenCalledTimes(1);
    expect(h.execution.clearStepInfrastructureStateStep).not.toHaveBeenCalled();
    expect(h.execution.updatePlanStepStatusStep).not.toHaveBeenCalled();
    expect(h.migration.applyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      wrapUpReason: expect.stringContaining(productEvidence),
      recoveryDisposition: 'product_failure', requiresUserFeedback: false,
    }));
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'product_failure', planId: 'plan', stepId: 'step',
    }));
    expect(h.lifecycle.assertCronExecutionOwnershipStep).toHaveBeenCalledTimes(3);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      wrapUpReason: expect.stringContaining('Review quarantine: Product budget exhausted after 3'),
    }));
  });

  it('keeps quarantined failure item-scoped when independent work is runnable', async () => {
    const h = harness();
    h.executeSingleTurnStep.mockResolvedValue(exhaustedTurn);
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('lets wrap-up recheck independent plan work after cancellation instead of trusting pending counts', async () => {
    const h = harness();
    h.plan.steps.push({ id: 'independent-step', status: 'pending', backlog_item_id: 'independent' });
    exhaustProduct(h);
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'product_failure', pendingPlanSteps: 1, hasRunnableBacklogWork: false,
    }));
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.plan.steps[0].status).toBe('cancelled');
    expect(h.plan.steps[1].status).toBe('pending');
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'product_failure' }));
  });

  it.each(['plan', 'backlog', 'neither'] as const)(
    'scopes final product failure to the item when independent %s work remains', async independent => {
      const h = harness();
      if (independent === 'plan') h.plan.steps.push({ id: 'next-step', status: 'pending', backlog_item_id: 'next' });
      h.executeSingleTurnStep.mockImplementation(async () => {
        h.plan.steps[0].status = 'failed';
        h.plan.steps[0].retry_count = 2;
        h.db.getRequirementFullContextStep.mockResolvedValue({ backlog: { items: [
          { id: 'item', status: 'needs_review', attempts: 4 },
          ...(independent === 'backlog' ? [{ id: 'next', status: 'pending', attempts: 0 }] : []),
        ] } });
        return { ...exhaustedTurn, persistedTerminalStatus: 'failed' };
      });
      await h.run();
      expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
        recoveryDisposition: independent === 'neither' ? 'product_failure' : undefined,
        requiresUserFeedback: false,
        pendingPlanSteps: independent === 'plan' ? 1 : 0,
        hasRunnableBacklogWork: independent === 'backlog',
      }));
      if (independent !== 'neither') {
        expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
          wrapUpReason: expect.stringContaining('independent plan or backlog work remains runnable'),
        }));
      }
      expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'product_failure' }));
      expect(h.plan.steps[0]).toMatchObject({ status: 'failed', retry_count: 2 });
    },
  );

  it('preserves original evidence after wrapped cleanup, ledger, and release errors', async () => {
    const h = harness();
    exhaustProduct(h);
    const secondary = new Error('Step "assertCronExecutionOwnershipStep" exceeded max retries (0 retries)');
    h.steps.reconcilePlanStep.mockRejectedValue(secondary);
    h.db.recordCronCycleOutcomeStep.mockRejectedValue(new Error('Ledger unavailable'));
    h.lifecycle.releaseRunLockStep.mockRejectedValue(new Error('Release unavailable'));
    await expect(h.run()).rejects.toBe(secondary);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      wrapUpReason: expect.stringContaining(productEvidence), recoveryDisposition: 'product_failure',
    }));
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'product_failure' }));
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('does not replace a confirmed product result with a secondary ledger error', async () => {
    const h = harness();
    exhaustProduct(h);
    h.db.recordCronCycleOutcomeStep.mockRejectedValue(new Error('Ledger unavailable'));
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it('does not let delivery in the inner finally overwrite the original execution exception', async () => {
    const h = harness();
    const original = new Error('Original execution transport failure');
    h.executeSingleTurnStep.mockRejectedValue(original);
    h.steps.commitAndPushStep.mockRejectedValue(new Error('Secondary commit failure'));
    await expect(h.run()).rejects.toBe(original);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('stops non-runnable finalization without hiding the already-persisted failed gate', async () => {
    const h = harness();
    h.executeSingleTurnStep.mockResolvedValue({ ...exhaustedTurn, persistedTerminalStatus: 'failed' });
    h.lifecycle.assertCronExecutionOwnershipStep
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(notRunnable());
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      wrapUpReason: expect.stringContaining(productEvidence), recoveryDisposition: 'product_failure',
    }));
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'product_failure' }));
  });

  it('treats non-runnable ownership before execution as a stop, not an infra retry or user resume', async () => {
    const h = harness();
    h.lifecycle.assertCronExecutionOwnershipStep.mockRejectedValueOnce(notRunnable());
    await expect(h.run()).resolves.toMatchObject({ status: 'paused' });
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
    expect(h.db.updateInstanceStatusStep).not.toHaveBeenCalled();
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'paused' }));
  });

  it.each(['run_owner_changed', 'execution_generation_changed', 'lease_expired'])(
    'does not publish stale product reporting or cleanup after %s', async reason => {
      const h = harness();
      exhaustProduct(h);
      h.lifecycle.assertCronExecutionOwnershipStep
        .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error(`Cron execution ownership rejected (${reason})`));
      await h.run();
      expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
      expect(h.db.updateInstanceStatusStep).not.toHaveBeenCalled();
      expect(h.lifecycle.stopSandboxStep).not.toHaveBeenCalled();
      expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'idle' }));
    },
  );

  it('does not unpause the user or publish reporting when cleanup owns a terminal lease', async () => {
    const h = harness();
    exhaustProduct(h);
    h.db.checkInstanceAndPlanStatusStep.mockResolvedValueOnce({ isPaused: false }).mockResolvedValue({ isPaused: true });
    await h.run();
    expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
    expect(h.db.updateInstanceStatusStep).not.toHaveBeenCalled();
    expect(h.lifecycle.stopSandboxStep).toHaveBeenCalledWith('sandbox', expect.anything(), expect.objectContaining({ allowTerminal: true }));
  });

  it('uses the declared turn budget and checkpoints progress without claiming completion', async () => {
    const h = harness();
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.provisionTrackingScriptStep).toHaveBeenCalledWith(expect.objectContaining({
      requirementId: 'req', originSiteId: 'site', sandboxId: 'sandbox',
    }));
    expect(h.executeSingleTurnStep).toHaveBeenCalledTimes(getFlow('app').cost_envelope.max_turns_per_step);
    expect(h.executeSingleTurnStep).toHaveBeenCalledWith(expect.objectContaining({ cronLockRunId: 'run', executionGeneration: 3 }));
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.lifecycle.stopSandboxStep).toHaveBeenCalledWith('sandbox', expect.anything(), expect.objectContaining({ runId: 'run', allowTerminal: true }));
  });

  it('stops before execution when the requirement tracking site cannot be verified', async () => {
    const h = harness();
    h.provisionTrackingScriptStep.mockResolvedValue({ injected: false, error: 'tracking site unavailable' });
    await expect(h.run()).rejects.toThrow('Application tracking provisioning failed');
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  const pendingReceipt = {
    status: 'failed', applied: [], errors: ['migrations/0001.sql has no applied checksum receipt'],
    failureKind: 'product', effectiveSandboxId: 'sandbox',
  };

  function completeExecution(h: ReturnType<typeof harness>) {
    h.executeSingleTurnStep.mockResolvedValue({
      ok: true, isDone: true, gatePassed: true, persistedTerminalStatus: 'completed',
    });
    h.steps.reconcilePlanStep.mockResolvedValue('completed');
    h.db.getRequirementFullContextStep.mockResolvedValue({ backlog: { items: [{ id: 'item', status: 'done' }] } });
  }

  it('does not push or finalize delivery while a required receipt is missing', async () => {
    const h = harness();
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue(pendingReceipt);
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'retry', requiresUserFeedback: false, wrapUpReason: pendingReceipt.errors[0],
    }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
    expectNoMigrationOrchestration(h);
  });

  it('verifies receipts before checkpointing, without applying or repairing SQL during cleanup', async () => {
    const h = harness();
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledWith('sandbox', 'req', 'applications', 'Test',
      expect.objectContaining({ requirementId: 'req' }), { requirementId: 'req', runId: 'run', executionGeneration: 3 });
    expect(h.steps.commitAndPushStep.mock.invocationCallOrder[0]).toBeGreaterThan(h.verification.verifyDatabaseMigrationsStep.mock.invocationCallOrder[0]);
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('retains the effective sandbox after an ambiguous receipt read without replaying SQL', async () => {
    const h = harness();
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue({
      ...pendingReceipt, errors: ['Application receipt is unknown after transport failure'],
      failureKind: 'infrastructure', effectiveSandboxId: 'recovered',
    });
    await expect(h.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.stopSandboxStep).toHaveBeenCalledWith('recovered', expect.anything(), expect.anything());
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('does not pass removed migration repair or restoration instructions to the checkpoint', async () => {
    const h = harness();
    await h.run();
    expect(h.steps.commitAndPushStep).toHaveBeenCalledWith('sandbox', expect.anything(), 'req', expect.anything(), expect.anything(), 'applications',
      { validateDeployment: true, lightweightCheckpoint: true,
        executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 3 } });
    expectNoMigrationOrchestration(h);
  });

  it('does not publish a partially applied batch when a later receipt remains pending', async () => {
    const h = harness();
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue({ ...pendingReceipt, applied: ['migrations/0000.sql'] });
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'retry', requiresUserFeedback: false }));
    expectNoMigrationOrchestration(h);
  });

  it('does not convert a receipt verification outage into a new security hold', async () => {
    const h = harness();
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue({ ...pendingReceipt, failureKind: 'infrastructure' });
    await expect(h.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'retry', requiresUserFeedback: false }));
    expectNoMigrationOrchestration(h);
  });

  it('keeps pending SQL in the same implementation step beyond five turns until the existing flow limit', async () => {
    const maxTurns = 8;
    const h = harness({ maxTurns });
    const snapshots: Array<{ id: string; generation: number; feedback?: string }> = [];
    h.executeSingleTurnStep.mockImplementation(async (params: any) => {
      snapshots.push({ id: params.step.id, generation: params.step.infrastructure_generation, feedback: params.step.error_message });
      const turn = snapshots.length;
      const feedback = `migrations/000${turn}.sql pending; apply through the implementation tool and retry validation`;
      // Model the gate's persisted in_progress feedback, not a terminal failure.
      params.step.error_message = feedback;
      return { ok: true, isDone: false, gatePassed: false, gateFailureKind: 'product_defect',
        gateErrorExcerpt: feedback, infrastructureGeneration: turn + 40, effectiveSandboxId: 'sandbox' };
    });
    h.execution.clearStepInfrastructureStateStep.mockImplementation(async () => ({
      state: 'applied', cleared: true, generation: h.plan.steps[0].infrastructure_generation,
    }));
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue(pendingReceipt);
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.executeSingleTurnStep).toHaveBeenCalledTimes(maxTurns);
    expect(snapshots.map(snapshot => snapshot.id)).toEqual(Array(maxTurns).fill('step'));
    expect(snapshots.map(snapshot => snapshot.generation)).toEqual([0, 41, 42, 43, 44, 45, 46, 47]);
    expect(snapshots[7].feedback).toContain('migrations/0007.sql pending');
    for (let turn = 1; turn <= maxTurns; turn++) {
      expect(h.executeSingleTurnStep).toHaveBeenNthCalledWith(turn, expect.objectContaining({
        plan: h.plan, step: h.plan.steps[0], requirementId: 'req', instanceId: 'instance',
        executionGeneration: 3, cronLockRunId: 'run', executionEventId: `run:step:turn:${turn}`,
      }));
    }
    expect(h.plan.steps[0]).toMatchObject({ status: 'in_progress', infrastructure_generation: 48,
      error_message: expect.stringContaining('migrations/0008.sql pending') });
    expect(h.execution.updatePlanStepStatusStep).not.toHaveBeenCalled();
    expect(h.execution.recordStepInfraTransientStep).not.toHaveBeenCalled();
    expect(h.orchestrator.runOrchestratorStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('allows the same implementation step to pass after six pending-SQL turns without a separate repair agent', async () => {
    const h = harness({ maxTurns: 8 });
    completeExecution(h);
    for (let turn = 0; turn < 6; turn++) {
      h.executeSingleTurnStep.mockResolvedValueOnce({ ok: true, isDone: false, gatePassed: false,
        gateFailureKind: 'product_defect', gateErrorExcerpt: pendingReceipt.errors[0] });
    }
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.executeSingleTurnStep).toHaveBeenCalledTimes(7);
    expect(h.plan.steps[0].status).toBe('completed');
    expect(h.execution.updatePlanStepStatusStep).not.toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(2);
    expect(h.finalizer.createFinalStatusStep).toHaveBeenCalledTimes(1);
    expectNoMigrationOrchestration(h);
  });

  it('preserves the ordinary infrastructure retry path instead of entering migration repair', async () => {
    const h = harness();
    h.executeSingleTurnStep.mockResolvedValue({ ok: false, isDone: false, transient: true,
      error: 'Database receipt service unavailable', infrastructureGeneration: 12 });
    await expect(h.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(h.executeSingleTurnStep).toHaveBeenCalledTimes(1);
    expect(h.execution.recordStepInfraTransientStep).toHaveBeenCalledWith('plan', 'step', 'run:step:turn:1:failure',
      'Database receipt service unavailable', undefined, { allowRetryableFailed: false, expectedGeneration: 12 });
    expect(h.execution.clearStepInfrastructureStateStep).not.toHaveBeenCalled();
    expect(h.execution.updatePlanStepStatusStep).not.toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('keeps unsafe-policy feedback retryable without inventing a reviewer or customer question', async () => {
    const h = harness();
    const feedback = 'RLS is unconditional: preserve tenant membership predicates before application';
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue({ ...pendingReceipt, errors: [feedback] });
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'retry', requiresUserFeedback: false, wrapUpReason: feedback,
    }));
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('keeps delivery denied even when retry reporting fails', async () => {
    const h = harness();
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue(pendingReceipt);
    h.wrapup.emitCycleWrapUpStep.mockRejectedValue(new Error('provider unavailable'));
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'product_failure' }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
    expectNoMigrationOrchestration(h);
  });

  it('does not replay or repair SQL after an unexpected verification exception', async () => {
    const h = harness();
    h.verification.verifyDatabaseMigrationsStep.mockRejectedValue(new Error('Receipt service unavailable'));
    await expect(h.run()).rejects.toThrow('Receipt service unavailable');
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'retry', requiresUserFeedback: false }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
    expectNoMigrationOrchestration(h);
  });

  it.each(['app', 'site'])('rechecks %s receipts after push/build recovery before emitting delivery status', async type => {
    const h = harness({ type });
    completeExecution(h);
    h.steps.commitAndPushStep.mockResolvedValue({ ok: true, pushed: true, branch: 'feature', effectiveSandboxId: 'push-recovered' });
    h.steps.postFinallyBuildStep.mockResolvedValue({ ok: true, effectiveSandboxId: 'build-recovered' });
    const finalReceipt = { status: 'passed', applied: ['migrations/0001.sql'], errors: [], effectiveSandboxId: 'build-recovered' };
    h.verification.verifyDatabaseMigrationsStep
      .mockResolvedValueOnce({ status: 'passed', applied: [], errors: [], effectiveSandboxId: 'sandbox' })
      .mockResolvedValueOnce(finalReceipt);
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(2);
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenLastCalledWith('build-recovered', 'req', 'applications', 'Test',
      expect.anything(), { requirementId: 'req', runId: 'run', executionGeneration: 3 });
    const [firstVerification, finalVerification] = h.verification.verifyDatabaseMigrationsStep.mock.invocationCallOrder;
    expect(firstVerification).toBeLessThan(h.steps.commitAndPushStep.mock.invocationCallOrder[0]);
    expect(finalVerification).toBeGreaterThan(h.steps.postFinallyBuildStep.mock.invocationCallOrder[0]);
    expect(finalVerification).toBeLessThan(h.wrapup.emitCycleWrapUpStep.mock.invocationCallOrder[0]);
    expect(finalVerification).toBeLessThan(h.finalizer.createFinalStatusStep.mock.invocationCallOrder[0]);
    expect(h.finalizer.createFinalStatusStep).toHaveBeenCalledWith(expect.objectContaining({
      databaseMigrations: finalReceipt, sandboxId: 'build-recovered', planCompleted: true, expectedExecutionGeneration: 3,
    }));
    expect(h.lifecycle.stopSandboxStep).toHaveBeenCalledWith('build-recovered', expect.anything(), expect.anything());
    expectNoMigrationOrchestration(h);
  });

  it.each([
    ['app', 'product', 'product_failure'],
    ['site', 'product', 'product_failure'],
    ['app', 'infrastructure', 'infrastructure_retry'],
  ])('does not finalize a completed %s plan when the post-recovery receipt check returns %s', async (type, failureKind, status) => {
    const h = harness({ type });
    completeExecution(h);
    h.steps.postFinallyBuildStep.mockResolvedValue({ ok: true, effectiveSandboxId: 'recovered' });
    h.verification.verifyDatabaseMigrationsStep
      .mockResolvedValueOnce({ status: 'passed', applied: [], errors: [], effectiveSandboxId: 'sandbox' })
      .mockResolvedValueOnce({ ...pendingReceipt, failureKind, effectiveSandboxId: 'recovered' });
    await expect(h.run()).resolves.toMatchObject({ status });
    expect(h.plan.steps[0].status).toBe('completed');
    expect(h.steps.commitAndPushStep).toHaveBeenCalledTimes(1);
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(2);
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledTimes(1);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'retry', requiresUserFeedback: false, wrapUpReason: pendingReceipt.errors[0],
    }));
    expect(h.lifecycle.stopSandboxStep).toHaveBeenCalledWith('recovered', expect.anything(), expect.anything());
    expectNoMigrationOrchestration(h);
  });

  it('does not let completed product evidence bypass the first missing-receipt backstop', async () => {
    const h = harness();
    completeExecution(h);
    h.verification.verifyDatabaseMigrationsStep.mockResolvedValue(pendingReceipt);
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.steps.postFinallyBuildStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('does not run the final receipt check or emit delivery status after execution generation changes', async () => {
    const h = harness();
    completeExecution(h);
    h.steps.postFinallyBuildStep.mockImplementation(async () => {
      h.db.isRequirementExecutionCurrentStep.mockResolvedValue(false);
      return { ok: true, effectiveSandboxId: 'sandbox' };
    });
    await expect(h.run()).resolves.toMatchObject({ status: 'stale_execution' });
    expect(h.verification.verifyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).not.toHaveBeenCalled();
    expect(h.lifecycle.stopSandboxStep).not.toHaveBeenCalled();
    expectNoMigrationOrchestration(h);
  });

  it('does not add migration receipt checks to a non-application workflow', async () => {
    const h = harness({ type: 'task' });
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.executeSingleTurnStep).toHaveBeenCalledTimes(getFlow('task').cost_envelope.max_turns_per_step);
    expect(h.migrationLifecycle.loadMigrationLifecycleStep).not.toHaveBeenCalled();
    expect(h.verification.verifyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).toHaveBeenCalledTimes(1);
    expectNoMigrationOrchestration(h);
  });
});