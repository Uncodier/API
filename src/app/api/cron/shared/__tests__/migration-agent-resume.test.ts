import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import * as repairPolicy from '../repair-execution-policy';
import * as repairController from '../judge-repair-controller';
import * as testRepairPolicy from '../judge-test-repair';
import * as commandRepairPolicy from '../judge-command-repair';
import * as gateCache from '../gate-validation-cache';
import * as noProgressPolicy from '../no-progress-adjudication';

const fingerprint = 'a'.repeat(64);
const feedback = `${repairPolicy.IMPLEMENTATION_FEEDBACK_PREFIX}migrations/0001.sql has no applied receipt; use the implementation tool before retrying validation`;
const identityTools = (tools: any[]) => tools;

/** Real executor, cache/repair policies and metadata transitions; every I/O boundary is local. */
function harness(options: {
  feedback?: boolean;
  shortcut?: 'cached' | 'materialized' | 'no-progress';
  testRepairStatus?: 'in_progress' | 'materialized';
  commandRepair?: boolean;
} = {}) {
  const shortcut = options.shortcut || 'cached';
  const repairRun: repairController.JudgeRepairRun | undefined =
    shortcut === 'materialized' || options.testRepairStatus || options.commandRepair ? {
      schema_version: 1, diagnostic_id: 'diagnostic', repair_run_id: 'repair',
      status: options.commandRepair ? 'in_progress' : options.testRepairStatus || 'materialized',
      failure_kind: options.testRepairStatus || options.commandRepair ? 'evidence_gap' : 'product_defect',
      contract_revision: 'contract', created_at: '2026-10-02T00:00:00Z',
      max_attempts: 5, attempt_count: 4, action_receipts: [],
      actions: [{ action_id: 'action', kind: options.commandRepair ? 'collect_evidence' : options.testRepairStatus ? 'repair_tests' : 'repair_implementation',
        ...(options.commandRepair ? { gap_code: 'missing_command_receipt' as const, command: 'npm run lint', expected_receipt: 'command_execution' } : {}),
        ...(options.testRepairStatus ? { gap_code: 'missing_test_evidence' as const } : {}),
        instruction: 'Preserve acceptance and authorization while repairing', verification: 'Run independent tests' }],
    } : undefined;
  const step = {
    id: 'step', order: 1, title: 'Implement', instructions: 'Implement safely',
    status: 'in_progress', infrastructure_generation: 7,
    error_message: options.commandRepair ? 'Failure kind: evidence_gap' : options.feedback === false ? undefined : feedback,
    metadata: {
      backlog_item_id: 'item', ...(repairRun ? { repair_run: repairRun } : {}),
      ...(shortcut === 'no-progress' ? {
        no_progress_adjudication: { state: 'requested', execution_generation: 3 },
      } : {}),
    },
  };
  const evidence = {
    producer_step_id: 'step', workspace_fingerprint: fingerprint,
    build: { exit_code: 0 },
    gate_resume: { status: 'pending', step_id: 'step', workspace_fingerprint: fingerprint },
    tests: [{ command: 'npm test', exit_code: 0, ran_after_changes: true,
      step_id: 'step', workspace_fingerprint: fingerprint }],
  };
  const executeAssistantStep = jest.fn().mockResolvedValue({ isDone: false, messages: [], steps: [] });
  const runSingleTurnGate = jest.fn().mockResolvedValue({ ok: true, isDone: false, gatePassed: false });
  const runGateOnlyNoProgressAdjudication = jest.fn().mockResolvedValue({ ok: true, isDone: false });
  const patchPlanStepAtomically = jest.fn().mockResolvedValue({ persisted: true, state: 'applied', generation: 7 });
  const assertCronExecutionOwnership = jest.fn().mockResolvedValue(undefined);
  const getBacklogItem = jest.fn().mockResolvedValue({ item: { evidence } });
  const refreshHarnessToolManifest = jest.fn(identityTools);
  const tools = ['sandbox_read_file', 'sandbox_edit_file', 'sandbox_write_file', 'sandbox_db_migrate',
    'sandbox_run_command', 'instance_plan', 'tools'].map(name => ({ name, execute: jest.fn() }));
  const helperPolicies = loadRuntimeModule<typeof import('../single-turn-helpers')>(
    'src/app/api/cron/shared/single-turn-helpers.ts', {
      './step-iteration-signals': {}, './step-action-guard': {},
      '@/lib/services/sandbox-gone-error': {}, '@/lib/services/instance-plan-step-contract': {},
      '@/lib/services/tool-operation-result': {}, './judge-test-repair': testRepairPolicy,
      './judge-command-repair': commandRepairPolicy,
      '@/app/api/agents/tools/instance_history/assistantProtocol': {},
    });
  const state = loadRuntimeModule<typeof import('../single-turn-step-state')>(
    'src/app/api/cron/shared/single-turn-step-state.ts', {
      '@/lib/services/instance-plan-infrastructure-state': { patchPlanStepAtomically },
      './no-progress-adjudication': noProgressPolicy, './judge-repair-controller': repairController,
    });
  const from = jest.fn((table: string) => {
    if (table === 'instance_plans') return { select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { status: 'in_progress', steps: [step] }, error: null }),
    }) }) };
    if (table === 'requirements') return { select: () => ({ eq: () => ({
      single: async () => ({ data: {} }),
    }) }) };
    throw new Error(`Unexpected table: ${table}`);
  });
  const { executeSingleTurnStep } = loadRuntimeModule<typeof import('../single-turn-executor')>(
    'src/app/api/cron/shared/single-turn-executor.ts', {
      '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError },
      '@vercel/sandbox': {},
      '@/lib/database/supabase-client': { supabaseAdmin: { from } },
      '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep },
      '@/app/api/robots/instance/assistant/utils': {
        getAssistantTools: () => tools, generateAgentBackground: async () => '', fetchMemoriesContext: async () => '',
      },
      './step-history-builder': { fetchStepLogHistoryText: async () => '' },
      '@/lib/services/skills-service': { SkillsService: { getSkillBySlugOrName: () => undefined } },
      '@/lib/services/instance-user-history': { loadUserActionHistory: async () => ({ promptText: '' }) },
      '@/lib/services/sandbox-recovery': { connectOrRecreateRequirementSandbox: async () => ({ sandbox: {}, sandboxId: 'sandbox' }) },
      '@/lib/services/sandbox-gone-error': { isSandboxGoneError: () => false },
      '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/vercel/sandbox' } },
      '@/app/api/agents/tools/sandbox/assistantProtocol': { getSandboxTools: () => [] },
      '@/lib/services/sandbox-sdk': { sandboxIdentity: () => 'sandbox' },
      './single-turn-prompt': {
        buildSingleTurnSystemPrompt: ({ retryContext }: any) => retryContext,
        buildUntrustedHistoryMessage: (text: string) => text, inferRoleFromStep: () => 'general', ROLE_TO_SKILL: {},
      },
      './single-turn-visual-feedback': { buildStepRetryFeedback: async (error: string) => ({ promptFragment: error || '' }) },
      './single-turn-background-task': { extractSingleTurnBackgroundState: () => ({}) },
      './single-turn-helpers': {
        captureInteractionBaseline: async () => undefined,
        captureWorkspaceProgressFingerprint: async () => fingerprint, getDeclaredTestCommand: () => 'npm test',
        getStepTerminalRequest: () => undefined, hasSandboxGoneToolFailure: () => false,
        isEvidenceCollectionRetry: helperPolicies.isEvidenceCollectionRetry,
        restrictToolsForEvidenceCollection: helperPolicies.restrictToolsForEvidenceCollection,
        withActionLoopGuard: identityTools, withDiagnosticHistoryTool: identityTools, withExecuteStepNoop: identityTools,
      },
      './single-turn-step-state': state,
      './judge-repair-controller': repairController,
      '@/lib/services/cron-infrastructure-state': {},
      '@/lib/services/instance-plan-infrastructure-state': { patchPlanStepAtomically },
      './single-turn-gate': { runSingleTurnGate },
      './no-progress-adjudication': noProgressPolicy,
      './no-progress-gate-adjudicator': { runGateOnlyNoProgressAdjudication },
      './gate-validation-cache': gateCache,
      '@/lib/services/requirement-backlog': { getBacklogItem },
      '@/lib/services/harness-diagnostics/tools': { refreshHarnessToolManifest },
      '@/lib/services/requirement-flows': { classifyRequirementType: () => 'app' },
      './commit/pre-push-build-validation': { computeApplicationBuildFingerprint: async () => fingerprint },
      '@/lib/services/requirement-constraints-persist': { loadConstraintSourceBlocks: async () => [] },
      './cron-execution-ownership': {
        assertCronExecutionOwnership, isCronExecutionOwnershipError: () => false, withCronExecutionOwnership: identityTools,
      },
      './repair-execution-policy': repairPolicy, './judge-test-repair': testRepairPolicy,
      './judge-test-tool': { createJudgeTestTool: () => ({ name: 'sandbox_run_tests', execute: jest.fn() }) },
      './judge-command-repair': commandRepairPolicy,
      './judge-command-tool': { createJudgeCommandTool: () => ({ name: 'sandbox_run_validation', execute: jest.fn() }) },
      '@/lib/services/apps-platform/tenant-capabilities-service': {},
      './step-action-guard': { loadStepActionObservations: async () => [] },
      './step-action-observation': { formatActionObservationFeedback: () => '' },
    });
  return {
    run: () => executeSingleTurnStep({ sandboxId: 'sandbox', plan: { id: 'plan', steps: [step] }, step,
      requirementId: 'req', instanceId: 'instance', siteId: 'site', title: 'Implement', gitRepoKind: 'applications',
      requirementType: 'app', cycleId: 'cycle', executionEventId: 'turn', executionGeneration: 3, cronLockRunId: 'run' }),
    step, evidence, tools, executeAssistantStep, runSingleTurnGate, runGateOnlyNoProgressAdjudication,
    patchPlanStepAtomically, getBacklogItem, refreshHarnessToolManifest,
  };
}

describe('pending migration feedback resumes the implementation agent', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('dispatches an executable lint evidence action rather than repeating a no-progress gate', async () => {
    const h = harness({ commandRepair: true, shortcut: 'no-progress' });
    await expect(h.run()).resolves.toMatchObject({ ok: true });
    expect(h.executeAssistantStep).toHaveBeenCalledTimes(1);
    expect(h.runGateOnlyNoProgressAdjudication).not.toHaveBeenCalled();
    expect(h.runSingleTurnGate).not.toHaveBeenCalled();
    const names = h.executeAssistantStep.mock.calls[0][2].custom_tools.map((tool: any) => tool.name);
    expect(names).toEqual(['sandbox_read_file', 'instance_plan', 'sandbox_run_validation']);
    expect(names).not.toContain('sandbox_db_migrate');
    expect(names).not.toContain('sandbox_run_command');
    expect(h.step.metadata.repair_run).toMatchObject({ repair_run_id: 'repair', attempt_count: 4, max_attempts: 5 });
  });

  it('calls the assistant despite matching cached build/test evidence when implementation feedback is pending', async () => {
    const h = harness();
    expect(gateCache.shouldResumeGateFromEvidence({ evidence: h.evidence as any, stepId: 'step',
      workspaceFingerprint: fingerprint, testCommand: 'npm test' })).toBe(true);
    await expect(h.run()).resolves.toMatchObject({ ok: true, isDone: false, infrastructureGeneration: 7 });
    expect(h.executeAssistantStep).toHaveBeenCalledTimes(1);
    // The real executor runs in a VM realm, so use Array.isArray rather than instanceof.
    expect(Array.isArray(h.executeAssistantStep.mock.calls[0][0])).toBe(true);
    expect(h.executeAssistantStep).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      enforceSingleTurn: true, custom_tools: h.tools, system_prompt: feedback, plan_id: 'plan', step_id: 'step',
    }));
    expect(h.runSingleTurnGate).not.toHaveBeenCalled();
    expect(h.runGateOnlyNoProgressAdjudication).not.toHaveBeenCalled();
    expect(h.getBacklogItem).not.toHaveBeenCalled();
    expect(h.patchPlanStepAtomically).toHaveBeenCalledTimes(1);
    expect(h.patchPlanStepAtomically).toHaveBeenCalledWith(expect.objectContaining({
      expectedGeneration: 7, patch: expect.objectContaining({ status: 'in_progress' }),
    }));
  });

  it.each(['cached', 'materialized', 'no-progress'] as const)(
    'retains the %s gate-only shortcut without implementation feedback', async shortcut => {
      const h = harness({ shortcut, feedback: false });
      await expect(h.run()).resolves.toMatchObject({ ok: true });
      expect(h.executeAssistantStep).not.toHaveBeenCalled();
      if (shortcut === 'no-progress') {
        expect(h.runGateOnlyNoProgressAdjudication).toHaveBeenCalledTimes(1);
        expect(h.runSingleTurnGate).not.toHaveBeenCalled();
      } else {
        expect(h.runSingleTurnGate).toHaveBeenCalledTimes(1);
        expect(h.runGateOnlyNoProgressAdjudication).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['materialized', 'no-progress'] as const)(
    'gives the implementation agent a turn instead of immediately repeating %s validation', async shortcut => {
      const h = harness({ shortcut });
      await expect(h.run()).resolves.toMatchObject({ ok: true });
      expect(h.executeAssistantStep).toHaveBeenCalledTimes(1);
      expect(h.runGateOnlyNoProgressAdjudication).not.toHaveBeenCalled();
      if (shortcut === 'materialized') {
        // Existing post-turn validation remains mandatory, but no longer starves the assistant.
        expect(h.runSingleTurnGate).toHaveBeenCalledTimes(1);
        expect(h.runSingleTurnGate.mock.invocationCallOrder[0]).toBeGreaterThan(h.executeAssistantStep.mock.invocationCallOrder[0]);
      } else expect(h.runSingleTurnGate).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'materialized'] as const)(
    'does not reset the %s test-repair budget or unlock migration/shell/router tools', async testRepairStatus => {
      const h = harness({ testRepairStatus });
      await expect(h.run()).resolves.toMatchObject({ ok: true });
      expect(h.executeAssistantStep).toHaveBeenCalledTimes(1);
      const options = h.executeAssistantStep.mock.calls[0][2];
      expect(options.enforceSingleTurn).toBe(true);
      const names = options.custom_tools.map((tool: any) => tool.name);
      expect(names).toEqual(['sandbox_read_file', 'sandbox_edit_file', 'sandbox_write_file', 'sandbox_run_tests']);
      for (const forbidden of ['sandbox_db_migrate', 'sandbox_run_command', 'instance_plan', 'tools']) {
        expect(names).not.toContain(forbidden);
      }
      expect(h.refreshHarnessToolManifest).toHaveBeenCalledWith(options.custom_tools, 'evidence_collection');
      for (const [mutation] of h.patchPlanStepAtomically.mock.calls) {
        expect(mutation.patch.metadata.repair_run).toMatchObject({
          repair_run_id: 'repair', max_attempts: 5, attempt_count: 4, status: testRepairStatus,
        });
      }
      expect(h.step.metadata.repair_run).toMatchObject({ max_attempts: 5, attempt_count: 4 });
    },
  );
});