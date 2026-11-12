import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { buildAssistantUserContent } from '@/lib/services/robot-instance/assistant-image-content';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import type { AssistantContext } from '../../types';
import { buildStepExecutionPrompt } from '../../step-execution-prompt';
import { createAssistantStepResult } from '../../step-result';
import { attachAssistantStepResult } from '../../requirement-host';

type AsyncMock = (...args: any[]) => Promise<any>;
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function harness() {
  const context: AssistantContext = {
    instance: { status: 'active' }, systemPrompt: 'Main assistant', customTools: [],
    initialMessage: 'Implement the plan', imageAssets: [], hasLinkedRequirement: false,
    expectedResultsAmount: 1,
    executionOptions: { provider: 'openai', instance_id: 'instance', site_id: 'site', user_id: 'user', use_sdk_tools: false },
  };
  const persisted: any = {
    id: 'plan', title: 'Test plan', status: 'in_progress', metadata: {},
    steps: [
      { id: 'step-1', order: 1, title: 'First step', instructions: 'Implement first', status: 'pending', result: { preserved: true } },
      { id: 'step-2', order: 2, title: 'Second step', instructions: 'Implement second', status: 'pending' },
    ],
  };
  const processAssistantTurn = jest.fn<AsyncMock>();
  const updateInstancePlanCore = jest.fn<AsyncMock>().mockImplementation(async (request: any) => {
    for (const patch of request.steps) {
      const step = persisted.steps.find((value: any) => value.id === patch.id);
      Object.assign(step, clone(patch));
    }
    return { success: true };
  });
  const maybeSingle = jest.fn<AsyncMock>().mockImplementation(async () => ({ data: clone(persisted), error: null }));
  const query: any = { maybeSingle };
  for (const method of ['select', 'eq', 'or', 'order', 'limit', 'contains', 'is']) query[method] = jest.fn(() => query);
  const redis = {
    set: jest.fn<AsyncMock>().mockResolvedValue('OK'),
    eval: jest.fn<AsyncMock>().mockResolvedValue(1),
  };
  const resolveAssistantPlanOwnership = jest.fn<AsyncMock>().mockImplementation(async (input: any) => {
    const requirementId = input.planRequirementId || input.contextRequirementId;
    return requirementId ? { state: 'managed', requirementId, runnable: true } : { state: 'standalone' };
  });
  const planSteps = loadRuntimeModule<typeof import('../../plan-steps')>(
    'src/app/api/robots/instance/assistant/plan-steps.ts', {
      '@/lib/services/workflow-robot/plan-routing': { getPlanRouting: async (_id: string, siteId: string) => ({ payer: 'platform', siteId }) },
      './execution-routing': { withAssistantRouting: async (_site: string, _ref: unknown, operation: () => Promise<unknown>) => operation() },
      '@/lib/database/supabase-client': { supabaseAdmin: { from: () => query } },
      '@/app/api/agents/tools/instance_plan/update/core': { updateInstancePlanCore },
      './assistant-turn': { processAssistantTurn },
      './step-execution-prompt': { buildStepExecutionPrompt },
      './step-result': { createAssistantStepResult },
      './requirement-host': { attachAssistantStepResult },
      '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError },
      '@/lib/services/skills-service': { SkillsService: { getSkillBySlugForSite: async () => null } },
      './skill-selection': { requiredSkillsPrompt: () => '' },
      '@/app/api/cron/shared/step-git-prompts': {
        getStepCheckpointPromptFragment: () => '', getFileFreshnessPromptFragment: () => '',
      },
      '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/test/workspace' } },
      '@/lib/utils/redis-client': { getRedisClient: () => redis },
      './plan-ownership': { resolveAssistantPlanOwnership },
    },
  );
  const completeUserMessageStep = jest.fn<AsyncMock>();
  const pauseUserMessageStep = jest.fn<AsyncMock>();
  const markAssistantFailedStep = jest.fn<AsyncMock>();
  const pauseAssistantForCreditsStep = jest.fn<AsyncMock>().mockResolvedValue({ message: 'Tus créditos se han agotado.', nextResetAt: '2026-11-01T00:00:00.000Z' });
  const persistUserMessageStep = jest.fn<AsyncMock>().mockResolvedValue({ id: 'user-log' });
  const prepareAssistantContext = jest.fn<AsyncMock>().mockResolvedValue(context);
  const countRecentRespawnsStep = jest.fn<AsyncMock>().mockResolvedValue(0);
  const spawnSilentContinueStep = jest.fn<AsyncMock>().mockResolvedValue(true);
  const prepareRecoveryStep = jest.fn<AsyncMock>().mockResolvedValue({ ok: true });
  const workflow = loadRuntimeModule<typeof import('../../workflow')>(
    'src/app/api/robots/instance/assistant/workflow.ts', {
      '@/lib/services/robot-instance/assistant-image-content': { buildAssistantUserContent },
      '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError },
      './assistant-turn': { processAssistantTurn },
      './steps': { prepareAssistantContext },
      './plan-steps': planSteps,
      './persist-and-fail-steps': {
        persistUserMessageStep, completeUserMessageStep, markAssistantFailedStep, pauseUserMessageStep, pauseAssistantForCreditsStep,
      },
      '@/lib/services/robot-instance/assistant-respawn-policy': {
        isIncompleteTurn: (result: any) => !result.isDone || !result.text?.trim(),
        MAX_RESPAWNS: 5, SILENT_CONTINUE_PROMPT: 'silent continue',
      },
      './assistant-respawn-steps': { countRecentRespawnsStep, spawnSilentContinueStep },
      './assistant-recovery-steps': {
        prepareRecoveryStep,
        guardRecoveryStep: async () => true,
        checkpointRecoveryStep: async () => true,
      },
    },
  );
  const result = (messages: any[], isDone = false, text = '') => ({
    text, messages, isDone, steps: [], output: null,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  });
  let effects = 0;
  const doTurn = async (_context: any, messages: any[]) => {
    effects++;
    return result([...messages, { role: 'assistant', content: null, tool_calls: [
      { id: `call-${effects}`, type: 'function', function: { name: 'write', arguments: '{}' } },
    ] }, { role: 'tool', tool_call_id: `call-${effects}`, content: `Effect ${effects} already applied` }]);
  };
  const run = (options?: { userMessageLogId?: string; executionMode?: 'direct' | 'harness'; silentContinue?: boolean; resumeToken?: string }, message = 'Implement plan') => workflow.runAssistantWorkflow('instance', message, 'site', 'user', [], false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, options);
  return { context, persisted, result, doTurn, effects: () => effects, run,
    resolveAssistantPlanOwnership,
    processAssistantTurn, updateInstancePlanCore, planSteps, redis, maybeSingle, query,
    completeUserMessageStep, pauseUserMessageStep, markAssistantFailedStep, pauseAssistantForCreditsStep, persistUserMessageStep, prepareAssistantContext, prepareRecoveryStep, countRecentRespawnsStep, spawnSilentContinueStep };
}
