import { supabaseAdmin } from '@/lib/database/supabase-client';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { processAssistantTurn } from './assistant-turn';
import type { AssistantContext } from './types';
import { SkillsService } from '@/lib/services/skills-service';
import { requiredSkillsPrompt } from './skill-selection';
import { getStepCheckpointPromptFragment, getFileFreshnessPromptFragment } from '@/app/api/cron/shared/step-git-prompts';
import { SandboxService } from '@/lib/services/sandbox-service';
import { getRedisClient } from '@/lib/utils/redis-client';
import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';
import {
  evaluatePlanBacklogGate,
} from '@/lib/services/requirement-plan-backlog-gate';

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
  | { executionStatus: 'exhausted'; isDone: false; resumeFromStepId: string }
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

// Persistence acknowledgements are part of the execution boundary. A returned
// error (or missing acknowledgement) must not allow tools, resumption, or a
// success response, even if the writer did not throw.
async function persistPlanStepUpdate(params: any, phase: string): Promise<void> {
  const result: { success?: boolean; error?: unknown } | null | undefined =
    await updateInstancePlanCore(params, { trustedRunner: true });
  if (result?.success !== true) {
    throw new Error(`Failed to persist plan step ${phase}: ${String(result?.error || 'write was not acknowledged')}`);
  }
}

/**
 * Execute a single step of the instance plan.
 */
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
  // A resumed batch must use the last completed turn's history, not replay its
  // original prompt. Store runtime state in result (not definition metadata).
  const checkpoint = step.result?.assistant_execution;
  if (checkpoint?.state === 'running') {
    throw new Error(`Plan step ${step.id} has an interrupted execution with uncertain effects; reconcile it before resuming.`);
  }
  const resuming = checkpoint?.state === 'exhausted';
  if (resuming && (checkpoint.version !== 1 || !Array.isArray(checkpoint.messages) || checkpoint.messages.length === 0)) {
    throw new Error(`Plan step ${step.id} has no valid continuation history; refusing to replay it.`);
  }
  const requirementId =
    context.executionOptions.requirement_id ||
    plan?.metadata?.requirement_id ||
    context.instance?.requirement_id ||
    '';
  if (requirementId) {
    const { loadRequirement, toBacklog } = await import(
      '@/lib/services/requirement-backlog-store'
    );
    const requirement = await loadRequirement(requirementId);
    const backlog = requirement
      ? toBacklog(requirement.backlog, 'default')
      : { items: [] };
    const backlogGate = evaluatePlanBacklogGate(step, backlog.items);
    if (!backlogGate.runnable) {
      const reason = `Runtime gate: ${backlogGate.reason}`;
      if (backlogGate.itemId) {
        const cancellation = await cancelPlanStepsForBacklogItem({
          requirementId,
          itemId: backlogGate.itemId,
          reason,
        });
        if (cancellation.errors.length > 0) {
          throw new Error(
            `${reason}; plan cancellation failed: ` +
            cancellation.errors.join('; '),
          );
        }
      } else {
        await persistPlanStepUpdate({
          plan_id: plan.id,
          instance_id: context.executionOptions.instance_id,
          site_id: context.executionOptions.site_id,
          requirement_id: requirementId,
          steps: [{
            id: step.id,
            status: 'cancelled',
            error_message: reason,
            completed_at: new Date().toISOString(),
          }],
        }, 'cancellation');
      }
      throw new Error(
        `Refusing to execute plan step ${step.id}: ${backlogGate.reason}`,
      );
    }
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
        result: { ...step.result, assistant_execution: { version: 1, state: 'running' } },
        ...(step.started_at ? {} : { started_at: cycleBaselineAt }),
      }]
    }, 'start checkpoint');

  // 2. Load skill content for this step (if declared)
  let skillContext = '';
  const skillName = step.skill || (step.role && ROLE_TO_SKILL[step.role]);
  if (skillName) {
    const matched = await SkillsService.getSkillBySlugForSite(context.executionOptions.site_id, skillName);
    if (matched) {
      console.log(`[PlanSteps] Injecting skill "${skillName}" for step ${step.order}`);
      skillContext = `\n\n--- SKILL INSTRUCTIONS: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`;
    } else {
      console.warn(`[PlanSteps] Skill "${skillName}" not found, continuing without it`);
    }
  }

  let skillPromptText = '';
  if (skillContext) {
    skillPromptText = `\nIMPORTANT — You MUST follow the skill instructions below. They define your procedures, validations, and deliverables for this role. Do NOT skip any step in the skill.\n${skillContext}`;
  } else {
    skillPromptText = `\n🚨 MISSING SKILL INSTRUCTIONS: No specific skill or role was assigned to this step.
BEFORE starting to code or execute any commands, you MUST:
1. Call \`skill_lookup\` tool with \`action="list"\` to see all available skills.
2. Choose the appropriate skill based on this step's objective, instructions, and the current backlog item.
3. Call \`skill_lookup\` tool with \`action="get"\` and the chosen \`skill_name\` to load its instructions.
4. Follow those instructions strictly.`;
  }

  // 3. Build a dedicated system prompt for this sub-agent step
  const { instance_id, site_id } = context.executionOptions;

  let progressContext = '';
  if (requirementId) {
    const { data: reqData } = await supabaseAdmin
      .from('requirements')
      .select('progress')
      .eq('id', requirementId)
      .single();
      
    if (reqData && reqData.progress && Array.isArray(reqData.progress) && reqData.progress.length > 0) {
      const recentProgress = reqData.progress.slice(-5);
      progressContext = '\n\n📋 RECENT REQUIREMENT PROGRESS:\n';
      progressContext += JSON.stringify(recentProgress, null, 2);
    }
  }

  const stepSystemPrompt = `You are an EXECUTOR agent running inside a Vercel Sandbox.
Your job is to complete ONE specific step by writing code, running commands, and making real changes.
Working directory: ${SandboxService.WORK_DIR}

CONTEXT:
- instance_id: ${instance_id}
- site_id: ${site_id}
${plan.id ? `- instance_plan_id: ${plan.id}` : ''}
${requirementId ? `- requirement_id: ${requirementId}` : ''}
${progressContext}

PLAN: "${plan.title}"

CURRENT STEP (Step ${step.order}):
Title: ${step.title}
Role: ${step.role || 'general'}
Instructions: ${step.instructions}
Expected Output: ${step.expected_output || 'Complete the step successfully.'}

Cycle baseline: ${cycleBaselineAt || 'unknown'}
File freshness: sandbox_list_files / sandbox_read_file report updated_this_cycle vs this baseline.

${skillPromptText}
${requiredSkillsPrompt(context.selectedSkills)}
${getFileFreshnessPromptFragment(cycleBaselineAt)}
${getStepCheckpointPromptFragment(requirementId, instance_id)}

RULES:
- Focus ONLY on completing this specific step. Do not plan — EXECUTE.
- CRITICAL EXECUTION RULES:
  1. ALWAYS THINK OUT LOUD: You MUST explain your reasoning and plan inside the \`thought_process\` parameter of every tool call.
  2. MAXIMIZE PARALLELISM: If you need to read multiple files, list multiple directories, or run independent commands, you MUST call multiple tools in parallel in a single response. Do not do things sequentially if they can be batched.
  3. AVOID LOOPS: If you find yourself reading the same files or running the same commands without making progress, STOP. Re-evaluate your approach and use a different tool (like sandbox_code_search instead of reading files blindly).
  4. GENERIC STEP CANCELLATION: If the step title or instructions are generic or not clear enough without any concrete actionable context or objective, you MUST CANCEL the current plan immediately using the \`instance_plan\` tool with action='update', plan_id='${plan.id}', and status='cancelled'.
  5. DATABASE CRUDS AND MIGRATIONS ON APPS (CRITICAL):
     - Never muck up data, always create a table first, then add data to it.
     - ALL database migrations MUST be written as plain \`.sql\` scripts located in \`migrations/*.sql\` (or \`supabase/migrations/\` / \`src/db/migrations/\`). NEVER create TypeScript classes, TypeORM models, or Prisma schemas.
     - Row Level Security (RLS) is MANDATORY for all new tables. You must include the \`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;\` and the corresponding \`CREATE POLICY\` in the same SQL file.
     - When using the Supabase client, you MUST explicitly specify the schema before calling \`.from()\` to prevent 'public.table_name not found' errors. Example: \`supabase.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || 'public').from('my_table')\`.
- Next.js App Router in this repo: pages only under src/app/ (e.g. src/app/prd/page.tsx). Never create a root folder named "app/" or "app/src/app/" — the GitHub repo may be called "apps" but that is not a path to mirror in the filesystem.
- Never use a top-level app/ folder for routes (e.g. app/src/app/prd breaks Vercel).
- Use skill_lookup (search → get) for playbooks matching this step's objective before large edits; follow loaded SKILL.md together with any injected skill block above.
- Use sandbox_write_file to create new files, sandbox_edit_file to replace specific strings in existing files (prefer this over overwriting large files), sandbox_run_command, and sandbox_read_file to write and test code. You MUST call sandbox_push_checkpoint before stopping when you changed files (title_hint = step title; see CHECKPOINTS in prompt). Use sandbox_restore_checkpoint only if you need to rewind locally. Use sandbox_read_logs to read server and console logs.
- After implementing, validate your work (run build, run tests if applicable). If writing tests, ALL test files MUST be placed inside the top-level \`tests/\` directory (e.g., \`tests/api\`, \`tests/components\`) to keep the repo clean.
- When reporting status, use requirement_id="${requirementId}" and instance_id="${instance_id}".
- The preview URL comes from the GitHub Deployments API post-push. Do NOT construct or guess it.
- Be efficient — the sandbox has a limited lifetime.
  6. USE MAKINARI SKILLS TOOLS FOR HEAVY LIFTING: Use skill_lookup (search → get) for playbooks matching this step's objective before large edits; follow loaded SKILL.md together with any injected skill block above.
  7. INTEGRATE MAKINARI API WHENEVER POSSIBLE TO A PROJECT:
    - Use the https://docs.makinari.com/mcp-server and https://docs.makinari.com/rest-api API documentation to integrate the APIs and tools avialble into the project.
`;

  const modifiedContext = {
    ...context,
    systemPrompt: stepSystemPrompt,
    executionOptions: {
      ...context.executionOptions,
      cycle_baseline_at: cycleBaselineAt,
    },
  };

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
  let isStepDone = false;
  let turns = 0;
  const MAX_STEP_TURNS = 10; // Avoid infinite loops within a step

  try {
    while (!isStepDone && turns < MAX_STEP_TURNS) {
      turns++;
      console.log(`[PlanSteps] Executing turn ${turns} for step ${step.order}`);
      
      stepResult = await processAssistantTurn(modifiedContext, currentMessages);
      
      // Update state
      currentMessages = stepResult.messages;
      isStepDone = stepResult.isDone;

      // If the assistant provides a text response, we consider the step "done" 
      // unless there are pending tool calls (which isDone handles usually)
      // But checking stepResult.text might be useful if we want to ensure we have an output.
    }
    
    if (!stepResult) {
        throw new Error('No result from assistant execution');
    }

  } catch (error: any) {
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

  if (!isStepDone) {
    const reason = `Turn limit reached (${MAX_STEP_TURNS}); this step is incomplete and can be resumed from its saved history.`;
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
            turns: (resuming ? Number(checkpoint.turns) || 0 : 0) + turns,
            // processAssistantTurn already dehydrates images for persistence.
            messages: currentMessages,
          },
        },
      }],
    }, 'exhaustion checkpoint');
    return { ...stepResult, isDone: false, executionStatus: 'exhausted', turns, resumeFromStepId: step.id };
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
      actual_output: stepResult.text,
      completed_at: new Date().toISOString(),
      error_message: null,
      result: { ...step.result, assistant_execution: null },
    }]
  }, 'completion');

  // Si hay instanceNodeId, actualizamos el nodo de respuesta con el resultado
  if (context.instanceNodeId) {
     // ya deberia estar en responseNodeIds, pero node_result_collector se encarga de updateNodeResult si le pasamos
     // no lo pasamos directamente aca, lo hara el executor.
  }

  return { ...stepResult, isDone: true, executionStatus: 'completed', turns };
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
