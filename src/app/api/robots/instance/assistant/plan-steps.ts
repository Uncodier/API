import { supabaseAdmin } from '@/lib/database/supabase-client';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/core';
import { processAssistantTurn } from './assistant-turn';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import type { AssistantContext } from './types';
import { SkillsService } from '@/lib/services/skills-service';
import { requiredSkillsPrompt } from './skill-selection';
import { buildStepExecutionPrompt } from './step-execution-prompt';
import { createAssistantStepResult } from './step-result';
import { attachAssistantStepResult } from './requirement-host';
import { SandboxService } from '@/lib/services/sandbox-service';
import { getRedisClient } from '@/lib/utils/redis-client';
import { resolveAssistantPlanOwnership, type AssistantPlanOwnership } from './plan-ownership';

const RELEASE_PLAN_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type PlanExecutionLockResult =
  | { state: 'acquired'; token: string }
  | { state: 'contended' }
  | { state: 'unavailable' };

export type PlanStepExecutionResult = {
  text: string;
  messages: any[];
  output?: any;
  usage: Record<string, any>;
  steps: any[];
  turns: number;
} & (
  | { executionStatus: 'completed'; isDone: true }
  | { executionStatus: 'exhausted'; isDone: false; resumeFromStepId: string; creditExhausted?: boolean }
  | { executionStatus: 'needs_input' | 'failed'; isDone: false; resumeFromStepId: string }
  | { executionStatus: 'deferred'; isDone: false; ownership: Exclude<AssistantPlanOwnership, { state: 'standalone' }> }
);

const ROLE_TO_SKILL: Record<string, string> = {
  'template_selection': 'makinari-obj-template-selection',
  'frontend': 'makinari-rol-frontend',
  'backend': 'makinari-rol-backend',
  'devops': 'makinari-rol-devops',
  'content': 'makinari-rol-content',
  'orchestrator': 'makinari-rol-orchestrator',
  'qa': 'makinari-rol-qa',
  'investigate': 'makinari-fase-investigacion',
  'plan': 'makinari-fase-planeacion',
  'validate': 'makinari-fase-validacion',
  'report': 'makinari-fase-reporteado',
};

/**
 * Fetch the active instance plan for the given instance and site.
 * Returns null if no active plan is found.
 */
export async function getActiveInstancePlan(
  instanceId: string,
  siteId: string,
  requirementId?: string,
) {
  'use step';
  for (const status of ['in_progress', 'active', 'pending'] as const) {
    const buildQuery = () => supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('instance_id', instanceId)
      .eq('site_id', siteId)
      .eq('status', status)
      .or('metadata->>workflow_run.is.null,metadata->>workflow_run.eq.false')
      .or('metadata->>workflow_template.is.null,metadata->>workflow_template.eq.false')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1);

    if (requirementId) {
      const { data: owned, error: ownedError } = await buildQuery()
        .contains('metadata', { requirement_id: requirementId })
        .maybeSingle();
      if (ownedError) {
        throw new Error(`Failed to load requirement plan: ${ownedError.message}`);
      }
      if (owned) return owned;

      const { data: legacy, error: legacyError } = await buildQuery()
        .is('metadata->>requirement_id', null)
        .maybeSingle();
      if (legacyError) {
        throw new Error(`Failed to load legacy requirement plan: ${legacyError.message}`);
      }
      if (legacy) return legacy;
      continue;
    }

    const { data, error } = await buildQuery().maybeSingle();
    if (error) throw new Error(`Failed to load active plan: ${error.message}`);
    if (data) return data;
  }

  return null;
}

/** A durable, read-only boundary: unlike the initial context this sees work
 * created by tools during the current conversation. It does not claim cron work.
 */
export async function getAssistantPlanOwnershipStep(
  context: AssistantContext,
  plan: any,
): Promise<AssistantPlanOwnership> {
  'use step';
  const ownership = await resolveAssistantPlanOwnership({
    instanceId: context.executionOptions.instance_id,
    siteId: context.executionOptions.site_id,
    planRequirementId: plan?.metadata?.requirement_id,
    contextRequirementId: context.executionOptions.requirement_id || context.instance?.requirement_id,
    contextHasLinkedRequirement: context.hasLinkedRequirement,
  });
  if (ownership.state === 'managed' && plan?.steps?.some((step: any) =>
    ['running', 'exhausted'].includes(step.result?.assistant_execution?.state))) {
    return { state: 'unavailable', reason: 'interactive_checkpoint_requires_reconciliation' };
  }
  return ownership;
}

// Require persistence acknowledgement before tools, resumption or success.
async function persistPlanStepUpdate(params: any, phase: string): Promise<void> {
  const result: { success?: boolean; error?: unknown } | null | undefined =
    await updateInstancePlanCore(params, { trustedRunner: true });
  if (result?.success !== true) {
    throw new Error(`Failed to persist plan step ${phase}: ${String(result?.error || 'write was not acknowledged')}`);
  }
}

/** Execute a single step of the instance plan. */
export async function executePlanStep(
  context: AssistantContext,
  plan: any,
  step: any
): Promise<PlanStepExecutionResult> {
  'use step';
  console.log(`[PlanSteps] Executing step ${step.order}: ${step.title}`);
  // Workflow inputs are snapshots. Never reuse their checkpoint after another
  // execution has consumed it or changed the step's lifecycle/definition.
  const { data: currentPlan, error: readError } = await supabaseAdmin
    .from('instance_plans')
    .select('*')
    .eq('id', plan.id)
    .eq('instance_id', context.executionOptions.instance_id)
    .eq('site_id', context.executionOptions.site_id)
    .maybeSingle();
  if (readError || !currentPlan) {
    throw new Error(`Failed to load authoritative plan ${plan.id}: ${readError?.message || 'plan not found for this instance and site'}`);
  }
  const currentStep = Array.isArray(currentPlan.steps)
    ? currentPlan.steps.find((candidate: any) => candidate.id === step.id)
    : undefined;
  if (!['pending', 'active', 'in_progress'].includes(currentPlan.status) ||
      !currentStep || !['pending', 'in_progress'].includes(currentStep.status)) {
    throw new Error(`Refusing to execute plan step ${step.id}: authoritative plan or step is not runnable.`);
  }
  plan = currentPlan;
  step = currentStep;
  // A plan can become managed after workflow admission. Never cancel its
  // pending backlog or run it without the requirement runner's ownership lease.
  const ownership = await resolveAssistantPlanOwnership({
    instanceId: context.executionOptions.instance_id,
    siteId: context.executionOptions.site_id,
    planRequirementId: plan.metadata?.requirement_id,
    contextRequirementId: context.executionOptions.requirement_id || context.instance?.requirement_id,
    contextHasLinkedRequirement: context.hasLinkedRequirement,
  });
  if (ownership.state !== 'standalone') {
    const unsafeCheckpoint = plan.steps.some((candidate: any) =>
      ['running', 'exhausted'].includes(candidate.result?.assistant_execution?.state));
    return { executionStatus: 'deferred', isDone: false,
      ownership: unsafeCheckpoint ? { state: 'unavailable', reason: 'interactive_checkpoint_requires_reconciliation' } : ownership,
      text: '', messages: [], usage: {}, steps: [], turns: 0 };
  }
  // A resumed batch must use the last completed turn's history, not replay its
  // original prompt. Store runtime state in result (not definition metadata).
  const checkpoint = step.result?.assistant_execution;
  if (checkpoint?.state === 'running') {
    throw new Error(`Plan step ${step.id} has an interrupted execution with uncertain effects; reconcile it before resuming.`);
  }
  const resuming = checkpoint?.state === 'exhausted';
  const explicitResult = context.executionMode === 'harness' || checkpoint?.resultContractVersion === 2;
  if (resuming && (checkpoint.version !== 1 || !Array.isArray(checkpoint.messages) || checkpoint.messages.length === 0)) {
    throw new Error(`Plan step ${step.id} has no valid continuation history; refusing to replay it.`);
  }
    // 1. Update step status to in_progress
    // Baseline = first time THIS step started (not plan.created_at).
    const now = new Date().toISOString();
    const cycleBaselineAt = step.started_at || now;

    await persistPlanStepUpdate({
      plan_id: plan.id,
      instance_id: context.executionOptions.instance_id,
      site_id: context.executionOptions.site_id,
      requirement_id: context.executionOptions.requirement_id,
      steps: [{
        id: step.id,
        status: 'in_progress',
        completed_at: null,
        error_message: null,
        // Consume the checkpoint before any effects. If the process dies or a
        // write fails after a tool ran, a new run must not reuse stale history.
        result: { ...step.result, assistant_execution: { version: 1, state: 'running',
          ...(explicitResult ? { resultContractVersion: 2 } : {}) } },
        ...(step.started_at ? {} : { started_at: cycleBaselineAt }),
      }]
    }, 'start checkpoint');

  // 2. Load skill content for this step (if declared)
  let skill: { name: string; content: string } | undefined;
  const skillName = step.skill || (step.role && ROLE_TO_SKILL[step.role]);
  if (skillName) {
    const matched = await SkillsService.getSkillBySlugForSite(context.executionOptions.site_id, skillName);
    if (matched) {
      console.log(`[PlanSteps] Injecting skill "${skillName}" for step ${step.order}`);
      skill = { name: matched.name, content: matched.content };
    } else {
      console.warn(`[PlanSteps] Skill "${skillName}" not found, continuing without it`);
    }
  }

  // 3. Build a dedicated system prompt for this sub-agent step
  const { instance_id, site_id, user_id } = context.executionOptions;
  const workspaceToolsAvailable = context.customTools.some(tool => tool?.name?.startsWith('sandbox_'));
  const stepSystemPrompt = buildStepExecutionPrompt({
    plan,
    step,
    instanceId: instance_id,
    siteId: site_id,
    userId: user_id,
    initialMessage: context.initialMessage,
    skill,
    unavailableSkill: skillName && !skill ? skillName : undefined,
    requiredSkillsContext: requiredSkillsPrompt(context.selectedSkills),
    workspace: workspaceToolsAvailable ? {
      workingDirectory: SandboxService.WORK_DIR,
      cycleBaselineAt,
      checkpointAvailable: context.customTools.some(tool => tool?.name === 'sandbox_push_checkpoint'),
    } : undefined,
  });

  const resultCapture = explicitResult ? createAssistantStepResult() : undefined;
  const modifiedContext = {
    ...context,
    systemPrompt: stepSystemPrompt + (resultCapture ? '\nSTEP TERMINAL PROTOCOL: use plan_result with completed/failed and summary, or needs_input and question. Plain text, a plan proposal or a question is not completion. Ask for missing essential input using needs_input; do not complete unfinished work.' : ''),
    customTools: resultCapture ? [...context.customTools.filter(tool => tool?.name !== 'plan_result'), resultCapture.tool] : context.customTools,
    executionOptions: {
      ...context.executionOptions,
      cycle_baseline_at: cycleBaselineAt,
    },
  };
  if (resultCapture) attachAssistantStepResult(modifiedContext, resultCapture.getResult);

  let userContent: any = `Execute step ${step.order}: ${step.title}. ${step.instructions}`;
  
  // Short HTTP refs only — processAssistantTurn hydrates to data URLs for vision
  if (context.imageAssets && context.imageAssets.length > 0) {
    const refUrls = context.imageAssets
      .map((img: any) => img.publicUrl || (!String(img.url || '').startsWith('data:') ? img.url : null))
      .filter(Boolean);
    const assetUrlsText = refUrls.length
      ? `\n\nCRITICAL - Uploaded Image URLs for reference (YOU MUST PASS THESE URLS EXACTLY AS THEY ARE TO THE APPROPRIATE TOOL PARAMETER, e.g. reference_images):\n${refUrls.join('\n')}`
      : '';

    userContent = [
      { type: 'text', text: `Execute step ${step.order}: ${step.title}. ${step.instructions}${assetUrlsText}` }
    ];

    context.imageAssets.forEach((img: any) => {
      const visionUrl = img.publicUrl || img.url;
      if (!visionUrl || String(visionUrl).startsWith('data:')) return;
      userContent.push({
        type: 'image_url',
        image_url: { url: visionUrl }
      });
    });
  }

  const messages = [
    {
      role: 'user',
      content: userContent
    }
  ];

  // 3. Execute the assistant for this step
  // We need a loop to handle potential tool calls within a single plan step
  // similar to the main workflow loop
  
  let stepResult;
  let currentMessages = resuming ? [...checkpoint.messages] : [...messages];
  if (resuming && checkpoint.awaitingInput === true) {
    currentMessages.push({ role: 'user', content: `Follow-up instruction for the pending step:\n${context.initialMessage}` });
  }
  let isStepDone = false;
  let turns = 0;
  const MAX_STEP_TURNS = 10; // Avoid infinite loops within a step

  try {
    while (!isStepDone && turns < MAX_STEP_TURNS) {
      turns++;
      console.log(`[PlanSteps] Executing turn ${turns} for step ${step.order}`);
      
      stepResult = await processAssistantTurn(modifiedContext, currentMessages);
      if (stepResult.creditExhausted) {
        return { ...stepResult, output: null, usage: {}, steps: [], turns,
          executionStatus: 'exhausted', isDone: false, resumeFromStepId: step.id };
      }
      
      // Update state
      currentMessages = stepResult.messages;
      if (resultCapture) {
        const reported = resultCapture.getResult();
        isStepDone = reported?.status === 'completed';
        if (reported?.status === 'needs_input' || reported?.status === 'failed') break;
        if (!reported && stepResult.isDone) currentMessages.push({ role: 'user', content:
          'The step has no explicit result yet. If essential information is missing, use plan_result needs_input with your question. Otherwise report completed/failed honestly; prose alone does not complete the step.' });
      } else isStepDone = stepResult.isDone;

    }
    
    if (!stepResult) {
        throw new Error('No result from assistant execution');
    }

  } catch (error: any) {
      // Billing is not a product failure. Keep the incomplete step and its
      // consumed checkpoint; never replay effects after an unpaid model turn.
      if (isInsufficientCreditsError(error)) throw error;
      console.error(`[PlanSteps] Step execution failed:`, error);
      
      // Update step status to failed
      await persistPlanStepUpdate({
        plan_id: plan.id,
        instance_id: context.executionOptions.instance_id,
        site_id: context.executionOptions.site_id,
        requirement_id: context.executionOptions.requirement_id,
        steps: [{
            id: step.id,
            status: 'failed',
            error_message: error.message,
            completed_at: new Date().toISOString(),
        }]
      }, 'failure');
      throw error;
  }

  const reported = resultCapture?.getResult();
  if (reported?.status === 'failed') {
    await persistPlanStepUpdate({ plan_id: plan.id, instance_id: context.executionOptions.instance_id,
      site_id: context.executionOptions.site_id, status: 'failed', steps: [{ id: step.id, status: 'failed', actual_output: reported.summary,
        error_message: reported.summary, completed_at: new Date().toISOString(),
        result: { ...step.result, assistant_execution: null } }] }, 'reported failure');
    return { ...stepResult, text: reported.summary, isDone: false, executionStatus: 'failed', turns, resumeFromStepId: step.id };
  }
  if (!isStepDone) {
    const question = reported?.status === 'needs_input' ? reported.question : undefined;
    const reason = question || `Turn limit reached (${MAX_STEP_TURNS}); this step is incomplete and can be resumed from its saved history.`;
    await persistPlanStepUpdate({
      plan_id: plan.id,
      instance_id: context.executionOptions.instance_id,
      site_id: context.executionOptions.site_id,
      requirement_id: context.executionOptions.requirement_id,
      steps: [{
        id: step.id,
        status: 'in_progress',
        completed_at: null,
        error_message: reason,
        result: {
          ...step.result,
          assistant_execution: {
            version: 1,
            state: 'exhausted',
            ...(explicitResult ? { resultContractVersion: 2 } : {}),
            ...(question ? { awaitingInput: true } : {}),
            turns: (resuming ? Number(checkpoint.turns) || 0 : 0) + turns,
            // processAssistantTurn already dehydrates images for persistence.
            messages: currentMessages,
          },
        },
      }],
    }, 'exhaustion checkpoint');
    return { ...stepResult, ...(question ? { text: question } : {}), isDone: false,
      executionStatus: question ? 'needs_input' : 'exhausted', turns, resumeFromStepId: step.id };
  }

  // 4. Only an actually finished assistant turn may complete the step.
  await persistPlanStepUpdate({
    plan_id: plan.id,
    instance_id: context.executionOptions.instance_id,
    site_id: context.executionOptions.site_id,
    requirement_id: context.executionOptions.requirement_id,
    steps: [{
      id: step.id,
      status: 'completed',
      actual_output: reported?.status === 'completed' ? reported.summary : stepResult.text,
      completed_at: new Date().toISOString(),
      error_message: null,
      result: { ...step.result, assistant_execution: null },
    }]
  }, 'completion');

  return { ...stepResult, ...(reported?.status === 'completed' ? { text: reported.summary } : {}), isDone: true, executionStatus: 'completed', turns };
}

// This durable step contains multiple non-idempotent tool calls. The SDK's
// default three retries would replay the entire batch, including prior effects.
// Exhaustion returns a checkpoint instead; ambiguous failures need reconciliation.
executePlanStep.maxRetries = 0;

export async function acquirePlanExecutionLockStep(
  planId: string,
): Promise<PlanExecutionLockResult> {
  'use step';
  try {
    const redis = getRedisClient();
    const lockKey = `workflow_lock:plan:${planId}`;
    const token = crypto.randomUUID();
    const result = await redis.set(lockKey, token, 'EX', 900, 'NX');
    return result === 'OK'
      ? { state: 'acquired', token }
      : { state: 'contended' };
  } catch (error) {
    console.error(`[PlanSteps] Error acquiring lock for plan ${planId}:`, error);
    return { state: 'unavailable' };
  }
}

export async function releasePlanExecutionLockStep(
  planId: string,
  token: string,
): Promise<boolean> {
  'use step';
  try {
    const redis = getRedisClient();
    const lockKey = `workflow_lock:plan:${planId}`;
    const released = await redis.eval(
      RELEASE_PLAN_LOCK_SCRIPT,
      1,
      lockKey,
      token,
    );
    return Number(released) === 1;
  } catch (error) {
    console.error(`[PlanSteps] Error releasing lock for plan ${planId}:`, error);
    return false;
  }
}
