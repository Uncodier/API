import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as cyclePolicy from '../../shared/plan-cycle-outcome';
import * as recoveryPolicy from '../../shared/cycle-recovery-policy';
import * as ownershipRejection from '../../shared/cron-ownership-rejection';
import { getFlow, classifyRequirementType, productAttemptLimits } from '@/lib/services/requirement-flows';

/** Real workflow control flow; every I/O dependency is an explicit local fake. */
function harness() {
  const plan: any = { id: 'plan', title: 'Implement', steps: [{
    id: 'step', order: 1, title: 'Work', instructions: 'Build', status: 'in_progress', infrastructure_generation: 0, backlog_item_id: 'item',
  }] };
  const lifecycle = {
    assertCronExecutionOwnershipStep: jest.fn(async (_ownership?: unknown) => {}),
    createSandboxStep: jest.fn(async () => ({ sandboxId: 'sandbox', branchName: 'feature', workDir: '/sandbox', instanceType: 'applications', isNewBranch: false })),
    stopSandboxStep: jest.fn(async () => {}),
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
    recordCronCycleOutcomeStep: jest.fn(async (_params?: unknown) => ({ is_latest: false })),
  };
  const steps = {
    getActiveInstancePlanStep: jest.fn(async () => plan),
    getInstancePlanByIdStep: jest.fn(async () => plan),
    checkRecentPlansGuardStep: jest.fn(async () => ({ shouldSkipOrchestrator: false, shouldBlockRequirement: false, recentCount: 0 })),
    cleanupNestedProjectsStep: jest.fn(async () => ({ effectiveSandboxId: 'sandbox' })),
    reconcilePlanStep: jest.fn(async () => 'in_progress'),
    commitAndPushStep: jest.fn(async () => ({ ok: true, pushed: true, branch: 'feature', commitCount: 1 })),
    postFinallyBuildStep: jest.fn(async () => ({ ok: true, effectiveSandboxId: 'sandbox' })),
    getPreviewUrlStep: jest.fn(async () => 'https://preview.example.invalid'),
  };
  const executeSingleTurnStep = jest.fn(async (_params?: unknown): Promise<any> => ({ ok: true, isDone: false, durableProductProgress: true }));
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
  const wrapup = { emitCycleWrapUpStep: jest.fn(async (_params?: unknown) => ({ ran: true, outcome: 'completed' })) };
  const technicalReviewBacklogItems = jest.fn((): any[] => []);
  const execution = {
    selectPlanStepsForExecution: (input: any[]) => input.filter(step => step.status === 'in_progress'),
    getPlanExecutionGateStep: jest.fn(async (): Promise<any> => ({ runnable: true })),
    clearStepInfrastructureStateStep: jest.fn(async () => ({ state: 'applied', cleared: true, generation: 1 })),
    updatePlanStepStatusStep: jest.fn(async () => ({ persisted: true })),
  };
  const provisionTrackingScriptStep = jest.fn(async (_params?: unknown): Promise<{ injected: boolean; error?: string }> => ({ injected: true }));
  const orchestrator = { runOrchestratorStep: jest.fn(async (_params?: unknown) => ({ createdPlan: true, timedOut: false, effectiveSandboxId: 'sandbox' })) };
  const workflow = loadRuntimeModule<typeof import('../workflow')>(
    'src/app/api/cron/requirements-apps/workflow.ts', {
      '../shared/cron-steps': steps,
      '../shared/cron-sandbox-lifecycle-steps': lifecycle,
      '../shared/workflow-db-steps': db,
      '../shared/step-db-migrations': migration,
      '../shared/step-db-migration-repair': repair,
      '../shared/migration-lifecycle-steps': migrationLifecycle,
      '../shared/bootstrap-spec-step': { bootstrapRequirementSpecStep: async () => {} },
      '../shared/tracking-script-step': { provisionTrackingScriptStep },
      '../shared/ensure-source-archive-step': { ensureSourceArchiveStep: async () => 'https://archive.example.invalid/source.zip' },
      '@/lib/services/requirement-git-binding': { getRequirementGitBinding: async () => ({ org: 'fixture', repo: 'app' }) },
      '../shared/docs-digest-step': { emitDocsDigestStep: async () => ({}) },
      '../shared/sync-docs-to-backlog-step': { emitSyncDocsToBacklogStep: async () => {} },
      '@/lib/services/requirement-flows': { getFlow, classifyRequirementType, productAttemptLimits },
      '@/lib/services/cycle-wrapup-prompt': {
        activeBacklogItemIdsFromPlanSteps: () => new Set(['item']), countPendingPlanSteps: () => 1,
        feedbackRequiredBacklogItems: () => [], technicalReviewBacklogItems,
        hasRunnableBacklogWork: (items: any[]) => items.some(item => item.status === 'in_progress'),
      },
      '../shared/cron-execute-steps-phase': execution,
      '../shared/cron-blocker-scope-steps': {},
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
      '../shared/no-progress-adjudication': {},
      '../shared/cycle-recovery-policy': recoveryPolicy,
      '../shared/cron-ownership-rejection': ownershipRejection,
      '../shared/cycle-wrapup-step': wrapup,
      '@/lib/services/requirement-backlog': { isBacklogComplete: () => false, hasOutstandingWork: () => true, isOrnamentalOnlyOutstanding: () => false },
    },
  );
  const run = () => workflow.runCronAppsWorkflow({ reqId: 'req', title: 'Test', instructions: '', type: 'app',
    site_id: 'site', user_id: 'user', instanceId: 'instance', previousWorkContext: '', instance_type: 'applications',
    cronLockRunId: 'run', cycleStartedAt: '2026-09-26T00:00:00Z', executionGeneration: 3 });
  return { run, plan, lifecycle, db, steps, executeSingleTurnStep, execution, migration, repair, gate, finalizer, wrapup, provisionTrackingScriptStep, migrationLifecycle, technicalReviewBacklogItems, orchestrator };
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

  it('assigns a classified correction without burning the restricted repair loop', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue({ status: 'failed', applied: [], errors: ['Static SQL needed'],
      failureKind: 'product', effectiveSandboxId: 'sandbox', correction: { state: 'correction_required' } });
    await expect(h.run()).resolves.toMatchObject({ status: 'remediation_handoff' });
    expect(h.migrationLifecycle.scheduleMigrationCorrectionStep).toHaveBeenCalledTimes(1);
    expect(h.repair.repairDatabaseMigrationStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'retry', requiresUserFeedback: false }));
  });

  it.each(['correction_required', 'validation_pending'])('recovers a missing %s plan without converting coordination into platform review', async state => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state, file: 'migrations/0001.sql' }]);
    h.steps.getActiveInstancePlanStep.mockResolvedValueOnce(null);
    h.migrationLifecycle.loadMigrationSourcePlanStep.mockResolvedValue(null);
    await expect(h.run()).resolves.toMatchObject({ status: 'remediation_handoff' });
    expect(h.orchestrator.runOrchestratorStep).toHaveBeenCalledWith(expect.objectContaining({
      initialMessage: expect.stringContaining('requires_sandbox=true'),
      migrationPlanRecovery: true,
      executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 3 },
    }));
    expect(h.migrationLifecycle.holdMigrationLifecycleStep).not.toHaveBeenCalled();
    expect(h.migrationLifecycle.scheduleMigrationCorrectionStep).not.toHaveBeenCalled();
    expect(h.migrationLifecycle.verifyPendingMigrationLifecycleStep).not.toHaveBeenCalled();
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.migration.applyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'retry', requiresUserFeedback: false,
    }));
  });

  it('retains a missing plan as a bounded scheduling retry without unsafe fallback or delivery', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'correction_required', file: 'migrations/0001.sql' }]);
    h.steps.getActiveInstancePlanStep.mockResolvedValue(null);
    h.migrationLifecycle.loadMigrationSourcePlanStep.mockResolvedValue(null);
    h.orchestrator.runOrchestratorStep.mockResolvedValue({ createdPlan: false, timedOut: false, effectiveSandboxId: 'sandbox' });
    await expect(h.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(h.orchestrator.runOrchestratorStep).toHaveBeenCalledTimes(1);
    expect(h.migrationLifecycle.holdMigrationLifecycleStep).not.toHaveBeenCalled();
    expect(h.db.recordRequirementBlockedStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it('does not turn a sandbox outage during plan recovery into a permanent migration hold', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'validation_pending', file: 'migrations/0001.sql' }]);
    h.steps.getActiveInstancePlanStep.mockResolvedValue(null);
    h.migrationLifecycle.loadMigrationSourcePlanStep.mockResolvedValue(null);
    h.lifecycle.createSandboxStep.mockRejectedValue(new Error('Sandbox temporarily unavailable'));
    await expect(h.run()).rejects.toThrow('Sandbox temporarily unavailable');
    expect(h.migrationLifecycle.holdMigrationLifecycleStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'retry', requiresUserFeedback: false,
    }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it('performs validation only for a completed backlog item, never executing the recovered product step', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'validation_pending', file: 'migrations/0001.sql' }]);
    h.execution.getPlanExecutionGateStep.mockResolvedValue({ runnable: true, migrationValidationOnly: true });
    h.db.getRequirementFullContextStep.mockResolvedValue({ backlog: { items: [{ id: 'item', status: 'done' }] } });
    await expect(h.run()).resolves.toMatchObject({ status: 'remediation_handoff' });
    expect(h.execution.getPlanExecutionGateStep).toHaveBeenCalledWith('plan', 'step', 'req', 'migration_validation');
    expect(h.migrationLifecycle.verifyPendingMigrationLifecycleStep).toHaveBeenCalledTimes(1);
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.migration.applyDatabaseMigrationsStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
  });

  it.each(['platform_review', 'reviewing'])('does not use plan recovery to reopen %s', async state => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state, file: 'migrations/0001.sql' }]);
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.orchestrator.runOrchestratorStep).not.toHaveBeenCalled();
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
  });

  it('provisions a diagnostic workspace and hands the assigned correction to the next agent, not a blocked requirement', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'correction_required', attempts: 5 }]);
    h.migrationLifecycle.scheduleMigrationCorrectionStep
      .mockResolvedValueOnce({ scheduled: false, internalReview: false, diagnosticPending: true })
      .mockResolvedValueOnce({ scheduled: true, internalReview: false });
    await expect(h.run()).resolves.toMatchObject({ status: 'remediation_handoff' });
    expect(h.lifecycle.createSandboxStep).toHaveBeenCalledTimes(1);
    expect(h.migrationLifecycle.scheduleMigrationCorrectionStep).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxId: 'sandbox' }));
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.db.recordRequirementBlockedStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'retry', requiresUserFeedback: false }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it('does not execute product work when independent diagnosis found no evidence-backed follow-up', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'correction_required', attempts: 5 }]);
    h.migrationLifecycle.scheduleMigrationCorrectionStep
      .mockResolvedValueOnce({ scheduled: false, internalReview: false, diagnosticPending: true })
      .mockResolvedValueOnce({ scheduled: false, internalReview: true, diagnosis: { reason: 'Evidence missing', next_action: 'Inspect ownership' } });
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
  });

  it('retains a durable validation obligation after an exception between apply and verification', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValueOnce([]).mockResolvedValue([{ state: 'validation_pending' }]);
    h.migrationLifecycle.verifyPendingMigrationLifecycleStep.mockRejectedValue(new Error('plan service down'));
    await expect(h.run()).rejects.toThrow('plan service down');
    expect(h.migrationLifecycle.holdMigrationLifecycleStep).toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('cannot begin normal execution while an earlier migration needs technical review', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValue([{ state: 'platform_review' }]);
    await expect(h.run()).resolves.toMatchObject({ status: 'blocked' });
    expect(h.executeSingleTurnStep).not.toHaveBeenCalled();
    expect(h.lifecycle.createSandboxStep).not.toHaveBeenCalled();
  });

  it('runs a dependent pending correction before verifying a partially applied batch', async () => {
    const h = harness();
    h.migrationLifecycle.loadMigrationLifecycleStep.mockResolvedValueOnce([{ state: 'validation_pending' }, { state: 'correction_required' }]).mockResolvedValue([]);
    await h.run();
    expect(h.migrationLifecycle.scheduleMigrationCorrectionStep).toHaveBeenCalled();
    expect(h.executeSingleTurnStep).toHaveBeenCalled();
    expect(h.migrationLifecycle.verifyPendingMigrationLifecycleStep).not.toHaveBeenCalled();
  });

  it('releases the run lock even when the accounting ledger is unavailable', async () => {
    const h = harness();
    h.db.checkInstanceAndPlanStatusStep.mockRejectedValueOnce(new Error('Transient failure'));
    h.db.recordCronCycleOutcomeStep.mockRejectedValue(new Error('Ledger unavailable'));
    await expect(h.run()).rejects.toThrow('Transient failure');
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
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

  it('does not push or finalize delivery after a required migration fails', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue({ status: 'failed', applied: [], errors: ['SQL syntax error'], failureKind: 'product', effectiveSandboxId: 'sandbox' });
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
    expect(h.repair.repairDatabaseMigrationStep).not.toHaveBeenCalled();
    expect(h.db.recordRequirementBlockedStep).toHaveBeenCalledWith(expect.objectContaining({
      event_id: 'run:migration-review', expected_execution_generation: 3,
      message: expect.stringContaining('No customer action'),
    }));
  });

  const repairableFailure = {
    status: 'failed', applied: [], errors: ['RLS is unconditional'], failureKind: 'product', effectiveSandboxId: 'sandbox',
    repairTarget: { file: 'supabase/migrations/0001.sql', schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenantId: 'tenant', checksum: 'a'.repeat(64), reason: 'lint' },
  };

  it('revalidates a repaired migration before allowing any push', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValueOnce(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: true, done: true, messages: [], effectiveSandboxId: 'recovered', repairedTarget: repairableFailure.repairTarget });
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenCalledTimes(1);
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenCalledWith(expect.objectContaining({
      executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 3 }, attempt: 1, maxAttempts: 5,
    }));
    expect(h.migration.applyDatabaseMigrationsStep).toHaveBeenCalledTimes(2);
    expect(h.migration.applyDatabaseMigrationsStep).toHaveBeenLastCalledWith('recovered', 'req', 'applications', 'Test', expect.anything(), expect.anything(), [repairableFailure.repairTarget]);
    expect(h.steps.commitAndPushStep.mock.invocationCallOrder[0]).toBeGreaterThan(h.migration.applyDatabaseMigrationsStep.mock.invocationCallOrder[1]);
    expect(h.gate.runGateStep).toHaveBeenCalledTimes(1);
  });

  it('does not reuse stale product evidence after a repaired migration passes', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValueOnce(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: true, done: true, messages: [], effectiveSandboxId: 'sandbox', repairedTarget: repairableFailure.repairTarget });
    h.gate.runGateStep.mockResolvedValue({ passed: false, effectiveSandboxId: 'sandbox', error: 'RLS probe failed' });
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
  });

  it('retains the recovered sandbox on an ambiguous repair error without reapplying SQL', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValueOnce(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: false, done: true, messages: [], effectiveSandboxId: 'recovered', error: 'transport failed' });
    await expect(h.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(h.migration.applyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.stopSandboxStep).toHaveBeenCalledWith('recovered', expect.anything(), expect.anything());
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('passes restoration expectations to the normal checkpoint even with no pending SQL', async () => {
    const h = harness();
    const restored = [{ file: 'supabase/migrations/001.sql', checksum: 'a'.repeat(64), source: { kind: 'git', revision: 'b'.repeat(40) } }];
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue({ status: 'passed', applied: [], errors: [], restored, effectiveSandboxId: 'sandbox' });
    await h.run();
    expect(h.repair.repairDatabaseMigrationStep).not.toHaveBeenCalled();
    expect(h.gate.runGateStep).not.toHaveBeenCalled();
    expect(h.steps.commitAndPushStep).toHaveBeenCalledWith('sandbox', expect.anything(), 'req', expect.anything(), expect.anything(), 'applications',
      expect.objectContaining({ expectedRestorations: restored, expectedRepairs: [], lightweightCheckpoint: false }));
  });

  it('does not publish a restoration when a later migration still fails', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue({ status: 'failed', applied: [], errors: ['Later SQL failed'], failureKind: 'product',
      restored: [{ file: 'supabase/migrations/001.sql', checksum: 'a'.repeat(64) }], effectiveSandboxId: 'sandbox' });
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
  });

  it('holds ambiguous restoration writes for technical review instead of replaying them', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue({ status: 'failed', applied: [], errors: ['Write unverified'], failureKind: 'infrastructure',
      restorationFailure: { writeAttempted: true }, effectiveSandboxId: 'sandbox' });
    await h.run();
    expect(h.db.recordRequirementBlockedStep).toHaveBeenCalledTimes(1);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
  });

  it('blocks after the shared repair turn budget rather than retrying forever', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue(repairableFailure);
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenCalledTimes(5);
    expect(h.migration.applyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
  });

  it('shares the budget across files and never treats a write as an applied receipt', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: true, done: false, messages: [], effectiveSandboxId: 'sandbox', repairedTarget: repairableFailure.repairTarget });
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenCalledTimes(5);
    expect(h.migration.applyDatabaseMigrationsStep).toHaveBeenCalledTimes(6);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('stops if the agent cannot safely repair and never repairs infrastructure failures', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: false, done: true, messages: [], effectiveSandboxId: 'sandbox' });
    await h.run();
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenCalledTimes(1);
    const infra = harness();
    infra.migration.applyDatabaseMigrationsStep.mockResolvedValue({ ...repairableFailure, failureKind: 'infrastructure' });
    await expect(infra.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(infra.repair.repairDatabaseMigrationStep).not.toHaveBeenCalled();
    expect(infra.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('asks only the concrete product decision returned by the independent reviewer', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: false, done: true, messages: [], effectiveSandboxId: 'sandbox',
      securityReview: { decision: 'needs_product_decision', reason: 'Ownership is unspecified.',
        question: 'Who should see campaigns?', options: ['Creator', 'Organization'], specificationExcerpt: 'Campaigns' } });
    await h.run();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'blocked', requiresUserFeedback: true,
      wrapUpReason: expect.stringContaining('Who should see campaigns?'),
    }));
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.migration.applyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
  });

  it('keeps the technical stop even when the wrap-up provider fails', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue(repairableFailure);
    h.wrapup.emitCycleWrapUpStep.mockRejectedValue(new Error('provider unavailable'));
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.db.recordRequirementBlockedStep).toHaveBeenCalledTimes(1);
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
  });

  it('does not automatically re-enter migration application after an ambiguous file write', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValueOnce(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: false, done: true, messages: [],
      effectiveSandboxId: 'recovered', error: 'write readback failed', writeAttempted: true });
    await expect(h.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(h.db.recordRequirementBlockedStep).toHaveBeenCalledTimes(1);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
    expect(h.migration.applyDatabaseMigrationsStep).toHaveBeenCalledTimes(1);
  });

  it('holds changed authorization for fresh verification even if the verification service is unavailable', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValueOnce(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: true, done: true, messages: [], effectiveSandboxId: 'sandbox', repairedTarget: repairableFailure.repairTarget });
    h.gate.runGateStep.mockResolvedValue({ passed: false, infrastructureFailure: true, effectiveSandboxId: 'sandbox' });
    await expect(h.run()).resolves.toMatchObject({ status: 'infrastructure_retry' });
    expect(h.db.recordRequirementBlockedStep).toHaveBeenCalledTimes(1);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'internal_review', requiresUserFeedback: false }));
  });

  it('carries only source paths across repair turns and resets evidence on target advancement', async () => {
    const h = harness();
    const nextFailure = { ...repairableFailure, repairTarget: { ...repairableFailure.repairTarget, file: 'supabase/migrations/0002.sql' } };
    h.migration.applyDatabaseMigrationsStep.mockResolvedValueOnce(repairableFailure).mockResolvedValue(nextFailure);
    h.repair.repairDatabaseMigrationStep
      .mockResolvedValueOnce({ changed: false, done: false, messages: ['old context'], contextPaths: ['src/access.ts'], effectiveSandboxId: 'sandbox' })
      .mockResolvedValueOnce({ changed: true, done: false, messages: ['old context'], contextPaths: ['src/access.ts'], effectiveSandboxId: 'sandbox', repairedTarget: repairableFailure.repairTarget })
      .mockResolvedValue({ changed: false, done: true, messages: [], effectiveSandboxId: 'sandbox' });
    await h.run();
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenNthCalledWith(2, expect.objectContaining({ contextPaths: ['src/access.ts'], messages: ['old context'] }));
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenNthCalledWith(3, expect.objectContaining({ contextPaths: [], messages: [] }));
  });

  it('charges the independent reviewer to the shared model budget', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue(repairableFailure);
    h.repair.repairDatabaseMigrationStep.mockResolvedValue({ changed: false, done: false, messages: [], effectiveSandboxId: 'sandbox',
      turnsUsed: 2, securityReview: { decision: 'request_changes', reason: 'Preserve membership.' } });
    await h.run();
    expect(h.repair.repairDatabaseMigrationStep).toHaveBeenCalledTimes(3);
    expect(h.repair.repairDatabaseMigrationStep.mock.calls.map((call: any[]) => call[0].attempt)).toEqual([1, 3, 5]);
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'internal_review', requiresUserFeedback: false,
    }));
  });
});