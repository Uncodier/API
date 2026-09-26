import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as cyclePolicy from '../../shared/plan-cycle-outcome';
import * as recoveryPolicy from '../../shared/cycle-recovery-policy';
import { getFlow, classifyRequirementType, productAttemptLimits } from '@/lib/services/requirement-flows';

/** Real workflow control flow; every I/O dependency is an explicit local fake. */
function harness() {
  const plan: any = { id: 'plan', title: 'Implement', steps: [{
    id: 'step', order: 1, title: 'Work', instructions: 'Build', status: 'in_progress', infrastructure_generation: 0,
  }] };
  const lifecycle = {
    assertCronExecutionOwnershipStep: jest.fn(async (_ownership?: unknown) => {}),
    createSandboxStep: jest.fn(async () => ({ sandboxId: 'sandbox', branchName: 'feature', workDir: '/sandbox', instanceType: 'applications', isNewBranch: false })),
    stopSandboxStep: jest.fn(async () => {}),
    extendRunLockStep: jest.fn(async () => {}),
    releaseRunLockStep: jest.fn(async () => {}),
  };
  const db = {
    checkInstanceAndPlanStatusStep: jest.fn(async () => ({ isPaused: false })),
    getRequirementFullContextStep: jest.fn(async () => ({ backlog: { items: [{ id: 'item', status: 'in_progress' }] } })),
    isRequirementExecutionCurrentStep: jest.fn(async () => true),
    updateInstanceStatusStep: jest.fn(async () => {}),
    syncCompletedPlanBacklogStep: jest.fn(async () => ({})),
    recordCronCycleOutcomeStep: jest.fn(async (_params?: unknown) => ({ is_latest: false })),
  };
  const steps = {
    getActiveInstancePlanStep: jest.fn(async () => plan),
    getInstancePlanByIdStep: jest.fn(async () => plan),
    cleanupNestedProjectsStep: jest.fn(async () => ({ effectiveSandboxId: 'sandbox' })),
    reconcilePlanStep: jest.fn(async () => 'in_progress'),
    commitAndPushStep: jest.fn(async () => ({ ok: true, pushed: true, branch: 'feature', commitCount: 1 })),
  };
  const executeSingleTurnStep = jest.fn(async (_params?: unknown): Promise<any> => ({ ok: true, isDone: false, durableProductProgress: true }));
  const migration = { applyDatabaseMigrationsStep: jest.fn(async (): Promise<any> => ({ status: 'passed', applied: [], errors: [], effectiveSandboxId: 'sandbox' })) };
  const finalizer = { createFinalStatusStep: jest.fn(), validateDeliverablesStep: jest.fn() };
  const wrapup = { emitCycleWrapUpStep: jest.fn(async (_params?: unknown) => ({ ran: true, outcome: 'completed' })) };
  const workflow = loadRuntimeModule<typeof import('../workflow')>(
    'src/app/api/cron/requirements-apps/workflow.ts', {
      '../shared/cron-steps': steps,
      '../shared/cron-sandbox-lifecycle-steps': lifecycle,
      '../shared/workflow-db-steps': db,
      '../shared/step-db-migrations': migration,
      '../shared/bootstrap-spec-step': { bootstrapRequirementSpecStep: async () => {} },
      '../shared/tracking-script-step': { provisionTrackingScriptStep: async () => {} },
      '../shared/ensure-source-archive-step': {},
      '@/lib/services/requirement-flows': { getFlow, classifyRequirementType, productAttemptLimits },
      '@/lib/services/cycle-wrapup-prompt': {
        activeBacklogItemIdsFromPlanSteps: () => new Set(['item']), countPendingPlanSteps: () => 1,
        feedbackRequiredBacklogItems: () => [], hasRunnableBacklogWork: () => true,
      },
      '../shared/cron-execute-steps-phase': {
        selectPlanStepsForExecution: (input: any[]) => input.filter(step => step.status === 'in_progress'),
        getPlanExecutionGateStep: async () => ({ runnable: true }),
        clearStepInfrastructureStateStep: async () => ({ state: 'applied', cleared: true, generation: 1 }),
      },
      '../shared/cron-blocker-scope-steps': {},
      '../shared/single-turn-executor': { executeSingleTurnStep },
      '../shared/gate-step-executor': {},
      '../shared/cron-orchestrator-step': {},
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
      '../shared/cycle-wrapup-step': wrapup,
      '@/lib/services/requirement-backlog': { isBacklogComplete: () => false, hasOutstandingWork: () => true, isOrnamentalOnlyOutstanding: () => false },
    },
  );
  const run = () => workflow.runCronAppsWorkflow({ reqId: 'req', title: 'Test', instructions: '', type: 'app',
    site_id: 'site', user_id: 'user', instanceId: 'instance', previousWorkContext: '', instance_type: 'applications',
    cronLockRunId: 'run', cycleStartedAt: '2026-09-26T00:00:00Z', executionGeneration: 3 });
  return { run, plan, lifecycle, db, steps, executeSingleTurnStep, migration, finalizer, wrapup };
}

describe('workflow recovery and truthful completion', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('does not request user intervention on the first infrastructure failure', async () => {
    const h = harness();
    h.db.checkInstanceAndPlanStatusStep.mockRejectedValue(new Error('Transient database unavailable'));
    await expect(h.run()).rejects.toThrow('Transient database unavailable');
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({
      recoveryDisposition: 'retry', requiresUserFeedback: false,
    }));
    expect(h.db.recordCronCycleOutcomeStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'infrastructure_retry' }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });

  it('releases the run lock even when the accounting ledger is unavailable', async () => {
    const h = harness();
    h.db.checkInstanceAndPlanStatusStep.mockRejectedValue(new Error('Transient failure'));
    h.db.recordCronCycleOutcomeStep.mockRejectedValue(new Error('Ledger unavailable'));
    await expect(h.run()).rejects.toThrow('Ledger unavailable');
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

  it('uses the declared turn budget and checkpoints progress without claiming completion', async () => {
    const h = harness();
    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    expect(h.executeSingleTurnStep).toHaveBeenCalledTimes(getFlow('app').cost_envelope.max_turns_per_step);
    expect(h.executeSingleTurnStep).toHaveBeenCalledWith(expect.objectContaining({ cronLockRunId: 'run', executionGeneration: 3 }));
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.lifecycle.stopSandboxStep).toHaveBeenCalledWith('sandbox', expect.anything(), expect.objectContaining({ runId: 'run', allowTerminal: true }));
  });

  it('does not push or finalize delivery after a required migration fails', async () => {
    const h = harness();
    h.migration.applyDatabaseMigrationsStep.mockResolvedValue({ status: 'failed', applied: [], errors: ['SQL syntax error'], failureKind: 'product', effectiveSandboxId: 'sandbox' });
    await expect(h.run()).resolves.toMatchObject({ status: 'product_failure' });
    expect(h.steps.commitAndPushStep).not.toHaveBeenCalled();
    expect(h.finalizer.createFinalStatusStep).not.toHaveBeenCalled();
    expect(h.wrapup.emitCycleWrapUpStep).toHaveBeenCalledWith(expect.objectContaining({ recoveryDisposition: 'blocked', requiresUserFeedback: true }));
    expect(h.lifecycle.releaseRunLockStep).toHaveBeenCalledTimes(1);
  });
});