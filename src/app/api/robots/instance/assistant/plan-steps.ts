import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getInstancePlansCore } from '@/app/api/agents/tools/instance_plan/get/route';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { AssistantContext, processAssistantTurn } from './steps';
import { SkillsService } from '@/lib/services/skills-service';
import { getStepCheckpointPromptFragment } from '@/app/api/cron/shared/step-git-prompts';
import { SandboxService } from '@/lib/services/sandbox-service';

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
  siteId: string
) {
  'use step';
  try {
    const result = await getInstancePlansCore({
      instance_id: instanceId,
      site_id: siteId,
      status: 'in_progress', // We only care about in_progress plans, or maybe pending too?
      limit: 1,
    });

    if (result.success && result.data.plans.length > 0) {
      return result.data.plans[0];
    }
    
    // Check for pending plans if no in_progress one exists
    const pendingResult = await getInstancePlansCore({
        instance_id: instanceId,
        site_id: siteId,
        status: 'pending',
        limit: 1,
      });

    if (pendingResult.success && pendingResult.data.plans.length > 0) {
        // Automatically start the pending plan?
        // For now, let's return it. The workflow can decide to start it.
        return pendingResult.data.plans[0];
    }

    return null;
  } catch (error) {
    console.error('[PlanSteps] Error fetching active plan:', error);
    return null;
  }
}

/**
 * Execute a single step of the instance plan.
 */
export async function executePlanStep(
  context: AssistantContext,
  plan: any,
  step: any
) {
  'use step';
  console.log(`[PlanSteps] Executing step ${step.order}: ${step.title}`);

  // 1. Update step status to in_progress
  await updateInstancePlanCore({
    plan_id: plan.id,
    instance_id: context.executionOptions.instance_id,
    site_id: context.executionOptions.site_id,
    steps: [{
      id: step.id,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    }]
  });

  // 2. Load skill content for this step (if declared)
  let skillContext = '';
  const skillName = step.skill || (step.role && ROLE_TO_SKILL[step.role]);
  if (skillName) {
    const matched = SkillsService.getSkillBySlugOrName(skillName);
    if (matched) {
      console.log(`[PlanSteps] Injecting skill "${skillName}" for step ${step.order}`);
      skillContext = `\n\n--- SKILL INSTRUCTIONS: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`;
    } else {
      console.warn(`[PlanSteps] Skill "${skillName}" not found, continuing without it`);
    }
  }

  // 3. Build a dedicated system prompt for this sub-agent step
  const { instance_id, site_id } = context.executionOptions;
  const requirementId = context.instance?.requirement_id || '';

  const stepSystemPrompt = `You are an EXECUTOR agent running inside a Vercel Sandbox.
Your job is to complete ONE specific step by writing code, running commands, and making real changes.
Working directory: ${SandboxService.WORK_DIR}

CONTEXT:
- instance_id: ${instance_id}
- site_id: ${site_id}
${requirementId ? `- requirement_id: ${requirementId}` : ''}

PLAN: "${plan.title}"
${plan.description ? `Description: ${plan.description}` : ''}

CURRENT STEP (Step ${step.order}):
Title: ${step.title}
Role: ${step.role || 'general'}
Instructions: ${step.instructions}
Expected Output: ${step.expected_output || 'Complete the step successfully.'}
${skillContext ? `\nIMPORTANT — You MUST follow the skill instructions below. They define your procedures, validations, and deliverables for this role. Do NOT skip any step in the skill.\n${skillContext}` : ''}
${getStepCheckpointPromptFragment(requirementId, instance_id)}

RULES:
- Focus ONLY on completing this specific step. Do not plan — EXECUTE.
- CRITICAL EXECUTION RULES:
  1. ALWAYS THINK OUT LOUD: You MUST explain your reasoning and plan inside the \`thought_process\` parameter of every tool call.
  2. MAXIMIZE PARALLELISM: If you need to read multiple files, list multiple directories, or run independent commands, you MUST call multiple tools in parallel in a single response. Do not do things sequentially if they can be batched.
  3. AVOID LOOPS: If you find yourself reading the same files or running the same commands without making progress, STOP. Re-evaluate your approach and use a different tool (like sandbox_code_search instead of reading files blindly).
- Next.js App Router in this repo: pages only under src/app/ (e.g. src/app/prd/page.tsx). Never create a root folder named "app/" or "app/src/app/" — the GitHub repo may be called "apps" but that is not a path to mirror in the filesystem.
- Never use a top-level app/ folder for routes (e.g. app/src/app/prd breaks Vercel).
- Use skill_lookup (search → get) for playbooks matching this step's objective before large edits; follow loaded SKILL.md together with any injected skill block above.
- Use sandbox_write_file to create new files, sandbox_edit_file to replace specific strings in existing files (prefer this over overwriting large files), sandbox_run_command, and sandbox_read_file to write and test code. You MUST call sandbox_push_checkpoint before stopping when you changed files (title_hint = step title; see CHECKPOINTS in prompt). Use sandbox_restore_checkpoint only if you need to rewind locally. Use sandbox_read_logs to read server and console logs.
- After implementing, validate your work (run build, run tests if applicable). If writing tests, ALL test files MUST be placed inside the top-level \`tests/\` directory (e.g., \`tests/api\`, \`tests/components\`) to keep the repo clean.
- When reporting status, use requirement_id="${requirementId}" and instance_id="${instance_id}".
- The preview URL comes from the GitHub Deployments API post-push. Do NOT construct or guess it.
- Be efficient — the sandbox has a limited lifetime.
`;

  const modifiedContext = {
    ...context,
    systemPrompt: stepSystemPrompt,
  };

  let userContent: any = `Execute step ${step.order}: ${step.title}. ${step.instructions}`;
  
  // If we have image assets, format as multimodal message for the plan step too
  if (context.imageAssets && context.imageAssets.length > 0) {
    userContent = [
      { type: 'text', text: `Execute step ${step.order}: ${step.title}. ${step.instructions}` }
    ];
    
    context.imageAssets.forEach((img: any) => {
      userContent.push({
        type: 'image_url',
        image_url: { url: img.url }
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
  let currentMessages = [...messages];
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
      await updateInstancePlanCore({
        plan_id: plan.id,
        instance_id: context.executionOptions.instance_id,
        site_id: context.executionOptions.site_id,
        steps: [{
            id: step.id,
            status: 'failed',
            error_message: error.message,
            completed_at: new Date().toISOString(),
        }]
      });
      throw error;
  }

  // 4. Update step status to completed and save output
  await updateInstancePlanCore({
    plan_id: plan.id,
    instance_id: context.executionOptions.instance_id,
    site_id: context.executionOptions.site_id,
    steps: [{
      id: step.id,
      status: 'completed',
      actual_output: stepResult.text,
      completed_at: new Date().toISOString(),
    }]
  });

  return stepResult;
}
