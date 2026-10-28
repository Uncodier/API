import { createAssistantStepResult } from '../step-result';
import { attachAssistantStepResult } from '../requirement-host';
import { jest } from '@jest/globals';
import { z } from 'zod';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { buildStepExecutionPrompt, type StepExecutionPromptParams } from '../step-execution-prompt';

const base: StepExecutionPromptParams = {
  plan: { id: 'plan-local', title: 'Research options' },
  step: { id: 'step-local', order: 1, title: 'Compare', instructions: 'Compare the supplied proposals without publishing.', expected_output: 'A concise comparison table.' },
  instanceId: 'instance-local', siteId: 'site-local', userId: 'user-local',
  initialMessage: 'Use only the supplied proposals. Do not contact vendors.',
};

describe('buildStepExecutionPrompt (pure, offline)', () => {
  it('retains identities, user scope and expected output without assuming code or a workspace', () => {
    const prompt = buildStepExecutionPrompt(base);
    for (const value of [base.plan.id!, base.plan.title, base.step.id!, base.step.title,
      base.instanceId, base.siteId, base.userId!, base.initialMessage!, base.step.instructions!, base.step.expected_output!]) {
      expect(prompt).toContain(value);
    }
    expect(prompt).toContain('general-purpose assistant');
    expect(prompt).not.toContain('WORKSPACE CONTEXT');
    expect(prompt).not.toContain('Cycle baseline:');
    expect(prompt).not.toContain('sandbox_push_checkpoint');
  });

  it('uses clarification and proportional planning instead of cancellation or compulsory discovery', () => {
    const prompt = buildStepExecutionPrompt({ ...base, step: { order: 1, title: 'Task' } });
    expect(prompt).toContain('ask a focused clarification question');
    expect(prompt).toContain('cannot be obtained responsibly');
    expect(prompt).toContain('Plan proportionally');
    expect(prompt).toContain('answer directly when sufficient');
    expect(prompt).toContain('not a prerequisite');
    for (const legacy of ['MUST CANCEL', 'GENERIC STEP CANCELLATION', 'Do not plan — EXECUTE',
      'skill_lookup', 'thought_process', 'ALWAYS THINK OUT LOUD', 'migrations/*.sql',
      'top-level `tests/`', 'src/app/', 'npm run build', 'ANTI_ACCEPT_AS_IS', 'MISSING SKILL INSTRUCTIONS']) {
      expect(prompt).not.toContain(legacy);
    }
  });

  it('keeps optional review advisory while respecting explicit checks and existing limits', () => {
    const prompt = buildStepExecutionPrompt(base);
    for (const clause of ['baseline', 'candidate improvement', 'not a veto or a new acceptance gate',
      'Explicitly requested checks remain binding', 'Improvement is not a retry',
      'do not reset counters', 'last known valid result', 'same scope and remaining budget',
      'not verified and not applicable', 'does not change it']) {
      expect(prompt).toContain(clause);
    }
    expect(prompt).toContain('do not cancel or rewrite the plan merely because its wording is broad');
  });

  it('keeps loaded skill content and frozen user selection intact', () => {
    const prompt = buildStepExecutionPrompt({ ...base,
      skill: { name: 'Local playbook', content: 'Preserve the existing CSV columns.' },
      requiredSkillsContext: 'USER SELECTED: use the approved glossary version 2.',
    });
    expect(prompt).toContain('--- SKILL INSTRUCTIONS: Local playbook ---\nPreserve the existing CSV columns.');
    expect(prompt).toContain('USER SELECTED: use the approved glossary version 2.');
    expect(prompt).toContain('cannot override security, authorization, user intent');
    expect(prompt).not.toContain('ASSIGNED SKILL UNAVAILABLE');
  });

  it('reports an unavailable assigned skill without inventing instructions or requiring lookup', () => {
    const prompt = buildStepExecutionPrompt({ ...base, unavailableSkill: 'missing-local-skill' });
    expect(prompt).toContain('ASSIGNED SKILL UNAVAILABLE: missing-local-skill');
    expect(prompt).toContain('Inform the user');
    expect(prompt).toContain('Do not invent its instructions');
    expect(prompt).toContain('ask for the missing guidance if it is essential');
    expect(prompt).not.toContain('skill_lookup');
    expect(buildStepExecutionPrompt(base)).not.toContain('ASSIGNED SKILL UNAVAILABLE');
  });

  it('includes only supplied workspace facts and the available host checkpoint protocol', () => {
    const params = { ...base, workspace: { workingDirectory: '/workspace/local', cycleBaselineAt: '2026-10-28T00:00:00.000Z' } };
    const prompt = buildStepExecutionPrompt(params);
    expect(prompt).toContain('/workspace/local');
    expect(prompt).toContain(params.workspace.cycleBaselineAt);
    expect(prompt).toContain('not a quality verdict or a reason to manufacture edits');
    expect(prompt).not.toContain('sandbox_push_checkpoint');
    expect(buildStepExecutionPrompt({ ...params, workspace: { ...params.workspace, checkpointAvailable: true } }))
      .toContain('host checkpoint protocol with sandbox_push_checkpoint');
  });

  it('is deterministic, has no runtime imports and does not mutate inputs', () => {
    const serialized = JSON.stringify(base);
    const isolated = loadRuntimeModule<typeof import('../step-execution-prompt')>(
      'src/app/api/robots/instance/assistant/step-execution-prompt.ts', {},
    );
    expect(isolated.buildStepExecutionPrompt(base)).toBe(buildStepExecutionPrompt(base));
    expect(JSON.stringify(base)).toBe(serialized);
  });
});

describe('executePlanStep prompt wiring (all I/O mocked, no environment)', () => {
  type AsyncMock = (...args: any[]) => Promise<any>;
  const requiredSkillsPrompt = loadRuntimeModule<typeof import('../skill-selection')>(
    'src/app/api/robots/instance/assistant/skill-selection.ts', {
      zod: { z }, '@/lib/services/skills-service': { SkillsService: {} },
      '@/lib/services/external-skills-service': { normalizeGithubSkillUrl: () => { throw new Error('Unexpected import'); } },
    },
  ).requiredSkillsPrompt;

  function harness(stepOptions: Record<string, unknown> = {}, customTools: any[] = []) {
    const selectedSkills = { skill_mode: 'required' as const, skills: [
      { slug: 'local-selection', name: 'User choice', version: '2', content: 'Keep the approved glossary.' },
    ] };
    const context = {
      instance: {}, systemPrompt: 'Original', customTools, initialMessage: base.initialMessage!,
      imageAssets: [{ url: 'https://example.invalid/reference.png', fileType: 'image/png' }], hasLinkedRequirement: false,
      expectedResultsAmount: 1, selectedSkills,
      executionOptions: { provider: 'openai' as const, use_sdk_tools: false,
        instance_id: base.instanceId, site_id: base.siteId, user_id: base.userId! },
    };
    const step = { ...base.step, status: 'pending', ...stepOptions };
    const plan = { ...base.plan, status: 'in_progress', steps: [step] };
    const processAssistantTurn = jest.fn<AsyncMock>().mockResolvedValue({ text: 'Comparison delivered', isDone: true, messages: [], usage: {}, steps: [] });
    const updateInstancePlanCore = jest.fn<AsyncMock>().mockResolvedValue({ success: true });
    const getSkillBySlugForSite = jest.fn<AsyncMock>().mockResolvedValue({ name: 'Assigned playbook', content: 'Compare price and delivery.' });
    const query: any = { maybeSingle: async () => ({ data: plan, error: null }) };
    for (const name of ['select', 'eq']) query[name] = () => query;
    const runtime = loadRuntimeModule<typeof import('../plan-steps')>(
      'src/app/api/robots/instance/assistant/plan-steps.ts', {
        '@/lib/database/supabase-client': { supabaseAdmin: { from: () => query } },
        '@/app/api/agents/tools/instance_plan/update/core': { updateInstancePlanCore },
        './assistant-turn': { processAssistantTurn },
        '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError: () => false },
        '@/lib/services/skills-service': { SkillsService: { getSkillBySlugForSite } },
        './skill-selection': { requiredSkillsPrompt },
        './step-execution-prompt': { buildStepExecutionPrompt },
        './step-result': { createAssistantStepResult },
        './requirement-host': { attachAssistantStepResult },
        '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/workspace/local' } },
        '@/lib/utils/redis-client': { getRedisClient: () => { throw new Error('Unexpected Redis call'); } },
        './plan-ownership': { resolveAssistantPlanOwnership: async () => ({ state: 'standalone' }) },
      },
    );
    return { context, getSkillBySlugForSite, processAssistantTurn, updateInstancePlanCore,
      run: () => runtime.executePlanStep(context, plan, step) };
  }

  it('passes assigned and user-selected skills, current identities, baseline and images to the turn', async () => {
    const h = harness({ skill: 'assigned-local', role: 'qa' }, [{ name: 'sandbox_read_file' }, { name: 'sandbox_push_checkpoint' }]);
    await expect(h.run()).resolves.toMatchObject({ executionStatus: 'completed', turns: 1 });
    expect(h.getSkillBySlugForSite).toHaveBeenCalledWith(base.siteId, 'assigned-local');
    const [turnContext, messages] = h.processAssistantTurn.mock.calls[0];
    expect(turnContext.selectedSkills).toBe(h.context.selectedSkills);
    expect(turnContext.systemPrompt).toContain('Compare price and delivery.');
    expect(turnContext.systemPrompt).toContain('local-selection (User choice, version 2)');
    expect(turnContext.systemPrompt).toContain('Keep the approved glossary.');
    expect(turnContext.systemPrompt).toContain(turnContext.executionOptions.cycle_baseline_at);
    expect(turnContext.systemPrompt).toContain('sandbox_push_checkpoint');
    expect(messages[0].content).toContainEqual({ type: 'image_url', image_url: { url: 'https://example.invalid/reference.png' } });
    expect(h.updateInstancePlanCore.mock.calls[1][0].steps[0].actual_output).toBe('Comparison delivered');
  });

  it('does not look up a skill or inject workspace context for an unassigned general step', async () => {
    const h = harness();
    await h.run();
    expect(h.getSkillBySlugForSite).not.toHaveBeenCalled();
    expect(h.processAssistantTurn.mock.calls[0][0].systemPrompt).not.toContain('WORKSPACE CONTEXT');
    expect(h.processAssistantTurn.mock.calls[0][0].systemPrompt).not.toContain('ASSIGNED SKILL UNAVAILABLE');
  });

  it('preserves existing role-to-skill loading', async () => {
    const h = harness({ role: 'qa' });
    await h.run();
    expect(h.getSkillBySlugForSite).toHaveBeenCalledWith(base.siteId, 'makinari-rol-qa');
  });

  it('passes a missing explicit skill notice instead of silently substituting the role skill', async () => {
    const h = harness({ skill: 'missing-local', role: 'qa' });
    h.getSkillBySlugForSite.mockResolvedValue(null);
    await h.run();
    expect(h.getSkillBySlugForSite).toHaveBeenCalledTimes(1);
    expect(h.getSkillBySlugForSite).toHaveBeenCalledWith(base.siteId, 'missing-local');
    expect(h.processAssistantTurn.mock.calls[0][0].systemPrompt).toContain('ASSIGNED SKILL UNAVAILABLE: missing-local');
  });
});