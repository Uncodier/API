import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { withActionLoopGuard, type ActionGuardContext } from '../step-action-guard';
import { makeActionObservation, actionStateFingerprint, formatActionObservationFeedback } from '../step-action-observation';
import { restrictToolsForEvidenceCollection } from '../single-turn-helpers';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));

const state = 'a'.repeat(64);
const args = { command: 'npm test' };
const step = { id: 'step', order: 1, title: 'Fix registration', instructions: 'Fix registration',
  status: 'in_progress', infrastructure_generation: 0, metadata: { backlog_item_id: 'item' } };

function harness() {
  const testExecute = jest.fn().mockResolvedValue({ exitCode: 1, stderr: 'FAIL registration' });
  const readHistory = jest.fn().mockResolvedValue({ content: 'full failure', has_more: false });
  const observations = [3, 2, 1].map(id => makeActionObservation({
    eventId: `previous-${id}`, name: 'sandbox_run_tests', args,
    before: actionStateFingerprint(state, 'sandbox', 1), after: actionStateFingerprint(state, 'sandbox', 1),
    result: { exitCode: 1, stderr: 'FAIL registration' },
  })!);
  const read = jest.fn().mockResolvedValue({ data: { status: 'in_progress', steps: [step] } });
  const from = jest.fn((table: string) => table === 'requirements'
    ? { select: () => ({ eq: () => ({ single: async () => ({ data: {} }) }) }) }
    : { select: () => ({ eq: () => ({ maybeSingle: read }) }) });
  const fingerprint = jest.fn().mockResolvedValue(state);
  const owner = jest.fn().mockResolvedValue(undefined);
  const execute = jest.fn(async (_messages: any[], _instance: any, options: any) => {
    const tools = options.custom_tools;
    await tools.find((tool: any) => tool.name === 'instance_history').execute({ action: 'read', log_id: 'log' });
    const result = await tools.find((tool: any) => tool.name === 'sandbox_run_tests').execute(args);
    return { isDone: false, messages: [], steps: [], result };
  });
  const record = jest.fn().mockResolvedValue(undefined);
  const deps = {
    '@/lib/services/harness-diagnostics/tools': { refreshHarnessToolManifest: (tools: any[]) => tools },
    '@/lib/database/supabase-client': { supabaseAdmin: { from } },
    '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep: execute },
    '@/app/api/robots/instance/assistant/utils': {
      generateAgentBackground: async () => '', fetchMemoriesContext: async () => '',
      getAssistantTools: () => [{ name: 'sandbox_run_tests', execute: testExecute },
        { name: 'tools', execute: jest.fn() }],
    },
    './step-history-builder': { fetchStepLogHistoryText: async () => 'PARTIAL REFERENCE: recover log detail' },
    './step-action-observation': { actionStateFingerprint, formatActionObservationFeedback },
    './step-action-guard': { loadStepActionObservations: async () => [...observations],
      persistStepActionObservation: record },
    '@/lib/services/skills-service': { SkillsService: { getSkillBySlugOrName: () => undefined } },
    '@/lib/services/instance-user-history': { loadUserActionHistory: async () => ({ promptText: '' }) },
    '@/lib/services/sandbox-recovery': { connectOrRecreateRequirementSandbox: async () => ({ sandbox: {}, sandboxId: 'sandbox' }) },
    '@/lib/services/sandbox-gone-error': { isSandboxGoneError: () => false },
    '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/vercel/sandbox' } },
    '@/app/api/agents/tools/sandbox/assistantProtocol': { getSandboxTools: () => [] },
    '@/lib/services/sandbox-sdk': { sandboxIdentity: () => 'sandbox' },
    './single-turn-prompt': { buildSingleTurnSystemPrompt: () => '', buildUntrustedHistoryMessage: (text: string) => text,
      inferRoleFromStep: () => 'general', ROLE_TO_SKILL: {} },
    './single-turn-visual-feedback': { buildStepRetryFeedback: async () => ({ promptFragment: '' }) },
    './single-turn-background-task': { extractSingleTurnBackgroundState: () => ({}) },
    './single-turn-helpers': {
      captureInteractionBaseline: async () => undefined,
      captureWorkspaceProgressFingerprint: async () => state,
      restrictToolsForEvidenceCollection,
      withActionLoopGuard: (tools: any[], text: string, ctx: ActionGuardContext) => withActionLoopGuard(tools, text, ctx),
      withExecuteStepNoop: (tools: any[]) => tools,
      withDiagnosticHistoryTool: (tools: any[]) => [...tools, { name: 'instance_history', execute: readHistory }],
      isEvidenceCollectionRetry: () => true,
      hasSandboxGoneToolFailure: () => false, getStepTerminalRequest: () => undefined,
    },
    './single-turn-step-state': {
      resolveSingleTurnBacklogItemId: async () => 'item',
      buildSingleTurnStartMetadata: () => step.metadata,
      markVisualFeedbackDelivered: async () => undefined,
    },
    './judge-repair-controller': {}, './judge-test-repair': { isTestRepairRun: () => false }, './judge-test-tool': {},
    '@/lib/services/cron-infrastructure-state': { CRON_INFRASTRUCTURE_PROVENANCE: 'infra' },
    '@/lib/services/instance-plan-infrastructure-state': {
      patchPlanStepAtomically: async () => ({ persisted: true, generation: 0 }),
    },
    './single-turn-gate': {}, './no-progress-adjudication': { isNoProgressAdjudicationRequested: () => false },
    './no-progress-gate-adjudicator': {}, './gate-validation-cache': {},
    '@/lib/services/requirement-backlog': {},
    '@/lib/services/requirement-flows': { classifyRequirementType: () => 'app' },
    './commit/pre-push-build-validation': { computeApplicationBuildFingerprint: fingerprint },
    '@/lib/services/requirement-constraints-persist': { loadConstraintSourceBlocks: async () => [] },
    './repair-execution-policy': { shouldEnterRepairGateOnlyPhase: () => false,
      canResumeCachedGate: () => false, shouldRunGateAfterTurn: () => false },
    '@/lib/services/apps-platform/tenant-capabilities-service': {},
    './cron-execution-ownership': {
      assertCronExecutionOwnership: owner, isCronExecutionOwnershipError: () => false,
      withCronExecutionOwnership: (tools: any[]) => tools.map(tool => ({ ...tool, execute: async (args: any) => {
        await owner(); return tool.execute(args);
      } })),
    },
  };
  // Retain an allowed verification tool while exercising the real restrictive
  // evidence policy (the generic router must still be removed).
  deps['./single-turn-helpers'].restrictToolsForEvidenceCollection = (tools: any[]) =>
    restrictToolsForEvidenceCollection(tools, undefined, { status: 'in_progress', failure_kind: 'evidence_gap',
      actions: [{ kind: 'repair_tests', gap_code: 'missing_test_evidence' }] } as any);
  const run = loadRuntimeModule<typeof import('../single-turn-executor')>(
    'src/app/api/cron/shared/single-turn-executor.ts', deps).executeSingleTurnStep;
  return { run: () => run({ sandboxId: 'sandbox', plan: { id: 'plan' }, step,
    requirementId: 'req', instanceId: 'inst', siteId: 'site', title: 'task', gitRepoKind: 'applications',
    requirementType: 'app', cycleId: 'cycle', executionEventId: 'turn-4', executionGeneration: 1, cronLockRunId: 'owner' }),
    execute, testExecute, readHistory, fingerprint, record };
}

it('real executor exposes scoped retrieval during repair and gives diagnostic feedback without blocking a service retest', async () => {
  const h = harness();
  const result = await h.run();
  expect(result).toMatchObject({ ok: true, isDone: false });
  expect(h.readHistory).toHaveBeenCalledTimes(1);
  expect(h.testExecute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.execute.mock.calls[0][0])).toContain('DIAGNOSTIC OBSERVATION');
  const tools = h.execute.mock.calls[0][2].custom_tools;
  expect(tools.map((tool: any) => tool.name)).toContain('instance_history');
  expect(tools.map((tool: any) => tool.name)).not.toContain('tools');
});

it('real executor permits the same test after a workspace change and persists the observation', async () => {
  const h = harness();
  h.fingerprint.mockResolvedValue('b'.repeat(64));
  expect(await h.run()).toMatchObject({ ok: true });
  expect(h.testExecute).toHaveBeenCalledTimes(1);
  expect(h.record).toHaveBeenCalledTimes(1);
});