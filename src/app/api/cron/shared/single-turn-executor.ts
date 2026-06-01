import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { getAssistantTools, fetchMemoriesContext, generateAgentBackground } from '@/app/api/robots/instance/assistant/utils';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { fetchStepLogHistoryText } from './step-history-builder';
import { SkillsService } from '@/lib/services/skills-service';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import type { GitRepoKind } from './cron-commit-helpers';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { getStepCheckpointPromptFragment, SANDBOX_REPO_ROOT_INVARIANT, TOOL_LOOKUP_HINT, LANGUAGE_REQUIREMENT_PROMPT } from './step-git-prompts';
import { SandboxService } from '@/lib/services/sandbox-service';

export function inferRoleFromStep(step: any): string | null {
  const text = `${step.title || ''} ${step.instructions || ''}`.toLowerCase();
  if (
    /template|vitrina|vitrinas|bootstrap|project base|base branch|select.*repo|checkout.*origin/.test(
      text,
    )
  ) {
    return 'template_selection';
  }
  if (/deploy|ci\/cd|build|push|docker|nginx|vercel|infra|devops|smoke.?test/.test(text)) return 'devops';
  if (/\bqa\b|quality\s*assurance|e2e|end.?to.?end|test\s*author|scenario/.test(text)) return 'qa';
  if (/css|ui|ux|component|page|layout|style|tailwind|react|html|responsive|frontend/.test(text)) return 'frontend';
  if (/api|endpoint|database|migration|server|auth|backend|supabase/.test(text)) return 'backend';
  if (/readme|copy|blog|seo|content|text|docs/.test(text)) return 'content';
  if (/investigat|research|audit|analyz|review/.test(text)) return 'investigate';
  if (/valid|test|check|verify|lint/.test(text)) return 'validate';
  return 'frontend'; // default for app requirements
}

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

export interface SingleTurnResult {
  ok: boolean;
  isDone: boolean;
  transient?: boolean;
  error?: string;
  effectiveSandboxId: string;
  sleepRequested?: number;
  backgroundTask?: {
    pid: string;
    logFile: string;
    toolCallId: string;
  };
}

export async function executeSingleTurnStep(params: {
  sandboxId: string;
  plan: any;
  step: any;
  requirementId: string;
  instanceId: string;
  siteId: string;
  userId?: string;
  title: string;
  gitRepoKind: GitRepoKind;
  requirementType: string;
}): Promise<SingleTurnResult> {
  'use step';
  const { sandboxId, plan, step, requirementId, instanceId, siteId, userId, title, gitRepoKind, requirementType } = params;
  
  const audit: CronAuditContext = {
    instanceId: instanceId,
    siteId: siteId,
    userId: userId,
    requirementId: requirementId,
  };

  // 1. Connect to Sandbox
  const instanceType = gitRepoKind === 'automation' ? 'automation' : 'applications';
  let connected;
  try {
    connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId,
      instanceType,
      title,
      audit,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, isDone: false, error: msg, effectiveSandboxId: sandboxId };
  }
  let sandbox = connected.sandbox;
  let effectiveSandboxId = connected.sandboxId;

  // 2. Mark step in_progress if pending
  try {
    try {
      const { data: planRow } = await supabaseAdmin
        .from('instance_plans')
        .select('steps, status')
        .eq('id', plan.id)
        .maybeSingle();
        
      const freshStep = Array.isArray(planRow?.steps) ? planRow.steps.find((s: any) => s.id === step.id) : undefined;
      if (freshStep && (freshStep.status === 'completed' || freshStep.status === 'cancelled')) {
        console.log(`[SingleTurn] Step ${step.order} already ${freshStep.status}.`);
        return { ok: true, isDone: true, effectiveSandboxId };
      }
    } catch (e) {}

    await updateInstancePlanCore({
      plan_id: plan.id, instance_id: instanceId, site_id: siteId,
      steps: [{ id: step.id, status: 'in_progress', started_at: new Date().toISOString() }],
    });

    // 3. Build Prompt & Context
    const effectiveRole = step.role || inferRoleFromStep(step) || 'general';
    const skillName = step.skill || (effectiveRole && ROLE_TO_SKILL[effectiveRole]);
    let skillContext = '';
    if (skillName) {
      const matched = SkillsService.getSkillBySlugOrName(skillName);
      if (matched) skillContext = `\n\n--- SKILL INSTRUCTIONS: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`;
    }

    if (effectiveRole === 'qa') {
      skillContext += `\n\n--- QA SPECIFIC MANDATORY RULES ---\n1. ROOT CLEANUP & REPO HEALTH: You MUST always delete unnecessary files from the repository root (e.g., test.js, temp.json, dummy files) or move them to their correct locations. Maintain the repository in a pristine, professional state.\n2. NAMING & VARIABLES REVIEW: You MUST review variables, functions, and classes for clear, consistent, and descriptive English naming conventions. Rename them if they are ambiguous, misleading, or poorly named.\n--- END QA RULES ---\n`;
    }

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

    // Get instance context for background/memories
    const { data: instanceData } = await supabaseAdmin.from('instances').select('*').eq('id', instanceId).maybeSingle();
    let agentBackground = '';
    let memoriesContext = '';
    let historyContext = '';
    if (instanceData) {
      agentBackground = await generateAgentBackground(siteId);
      const mems = await fetchMemoriesContext(siteId, userId, instanceId);
      memoriesContext = mems; // fetchMemoriesContext returns a string
    }

    const systemPrompt = `You are an AI coding assistant and EXECUTOR agent running inside a Vercel Sandbox.
Your job is to complete ONE specific step by writing code, running commands, and making real changes.

CRITICAL: YOU MUST EXECUTE EXACTLY ONE TOOL CALL PER RESPONSE.
Wait for the environment to execute the tool and return the result before you decide your next action.
DO NOT output multiple tool calls in a single response.

${SANDBOX_REPO_ROOT_INVARIANT}
${LANGUAGE_REQUIREMENT_PROMPT}

WORKSPACE — READ THIS CAREFULLY:
- ${SandboxService.WORK_DIR} is the GIT REPOSITORY ROOT. This is where package.json, next.config.ts, tsconfig.json, src/, and public/ already exist.
- The remote GitHub repo may be named "apps" — that is the repository name only. Do NOT create an extra folder called "apps/" or "app/" at the root for the Next.js app; routes belong in src/app/ only.
- The Next.js "app router" pages live at src/app/ (NOT at app/).
- NEVER run "npx create-next-app", "npm init", or create a new project. The project is ALREADY set up.
- NEVER create directories like my-app/, frontend/, or project/ at the root — those would be NESTED projects and will break the deployment.
- Do NOT create a top-level "app/" folder for routes (Next.js docs say "app directory" but here the only valid App Router root is "src/app/"). Paths such as "app/prd" or "app/src/app/prd" break "next build" and Vercel.
- To add a new page, write files under src/app/<route>/page.tsx only.
- To add components, write under src/components/.
- All relative paths in sandbox tools resolve from ${SandboxService.WORK_DIR}.
- FIRST ACTIONS (MANDATORY ORDER): (1) skill_lookup action=search to find complementary skills for this exact step using keywords from the objective, title, instructions, and tech stack; then skill_lookup action=get for each relevant playbook before any coding. (2) sandbox_list_files path="." to see the current project structure before writing code.
- LAST ACTION BEFORE STOPPING: Call sandbox_push_checkpoint (title_hint = this step's title) after your work builds — mandatory if you modified files; see CHECKPOINTS section below.

COMPANY BACKGROUND & MEMORIES:
${agentBackground}
${memoriesContext}
${historyContext}

CONTEXT:
- instance_id: ${instanceId}
- site_id: ${siteId}
${plan.id ? `- instance_plan_id: ${plan.id}` : ''}
${requirementId ? `- requirement_id: ${requirementId}` : ''}
${progressContext}

PLAN: "${plan.title || ''}"
CURRENT STEP (Step ${step.order}):
Title: ${step.title}
Role: ${effectiveRole || 'general'}
Instructions: ${step.instructions}
Expected Output: ${step.expected_output || 'Complete the step successfully.'}

${skillContext ? skillContext : `\n🚨 MISSING SKILL INSTRUCTIONS: No specific skill or role was assigned to this step.
BEFORE starting to code or execute any commands, you MUST:
1. Call \`skill_lookup\` tool with \`action="list"\` to see all available skills.
2. Choose the appropriate skill based on this step's objective, instructions, and the current backlog item.
3. Call \`skill_lookup\` tool with \`action="get"\` and the chosen \`skill_name\` to load its instructions.
`}

SHELL LIMITATIONS:
- The sandbox shell is /bin/sh (NOT bash). Brace expansion like {a,b,c} does NOT work.
- WRONG: mkdir -p src/app/{community,guests,booking} — creates a LITERAL folder named "{community,guests,booking}".
- RIGHT: mkdir -p src/app/community src/app/guests src/app/booking — list each path separately.
- FOR LONG COMMANDS (like npm run build, tests, or servers), ALWAYS use sandbox_start_background_command. Never use sandbox_run_command for them.

${TOOL_LOOKUP_HINT}
${getStepCheckpointPromptFragment(requirementId, instanceId)}`;

    // 4. Fetch History
    const historyText = await fetchStepLogHistoryText(instanceId, plan.id, step.id);
    const messages = [
      { role: 'user' as const, content: `Execute step ${step.order}: ${step.title}. ${step.instructions}` },
    ];

    if (historyText) {
      messages.push({
        role: 'user' as const,
        content: `${historyText}\n\nReview the previous actions including any gate failures. Decide the next single tool call to advance the step, or finish the step if completed. REMEMBER: MAXIMUM 1 TOOL CALL.`
      });
    }

    // 5. Call Executor (Max 1 turn)
    const sandboxTools = getSandboxTools(sandbox, requirementId, {
      site_id: siteId,
      instance_id: instanceId,
      git_repo_kind: gitRepoKind,
      requirement_type: requirementType,
      plan_id: plan.id,
      active_step_id: step.id,
    });
    
    const fullTools = getAssistantTools(siteId, userId, instanceId, sandboxTools);
    
    const result = await executeAssistantStep(messages, { id: instanceId, site_id: siteId, user_id: userId, requirement_id: requirementId }, {
      instance_id: instanceId,
      site_id: siteId,
      user_id: userId,
      requirement_id: requirementId,
      plan_id: plan.id,
      step_id: step.id,
      system_prompt: systemPrompt,
      custom_tools: fullTools,
      enforceSingleTurn: true // CRITICAL: enforce 1 tool call max per invocation
    });
    
    // Check if the LLM attempted to execute tools and failed due to sandbox gone
    const hasSandboxGoneError = result.messages?.some((m: any) => 
      m.role === 'tool' && isSandboxGoneError(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    );
    
    if (hasSandboxGoneError) {
       console.warn(`[SingleTurn] Sandbox gone detected. Will retry next workflow cycle.`);
       return { ok: false, isDone: false, transient: true, error: 'Sandbox Gone 410', effectiveSandboxId };
    }

    let sleepRequested: number | undefined;
    let backgroundTask: { pid: string; logFile: string; toolCallId: string } | undefined;
    const lastMessage = result.messages?.[result.messages.length - 1];

    if (lastMessage?.role === 'tool') {
      if (lastMessage.name === 'sandbox_check_background_command') {
        try {
          const contentStr = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
          const parsed = JSON.parse(contentStr);
          if (parsed.is_running === true) {
            sleepRequested = 15; // default wait when process is still running
            // Re-construct the backgroundTask so the workflow can poll it without the LLM
            const toolCalls = result.steps?.[result.steps.length - 1]?.toolCalls;
            const myCall = toolCalls?.find((tc: any) => tc.toolCallId === lastMessage.tool_call_id);
            if (myCall && myCall.args.pid && myCall.args.log_file) {
               backgroundTask = {
                 pid: String(myCall.args.pid),
                 logFile: String(myCall.args.log_file),
                 toolCallId: lastMessage.tool_call_id!
               };
            }
          }
        } catch (e) {}
      } else if (lastMessage.name === 'sandbox_start_background_command') {
        try {
          const contentStr = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
          const parsed = JSON.parse(contentStr);
          if (parsed.success && parsed.pid && parsed.log_file) {
            backgroundTask = {
              pid: String(parsed.pid),
              logFile: String(parsed.log_file),
              toolCallId: lastMessage.tool_call_id!
            };
          }
        } catch (e) {}
      }
    }

    return { ok: true, isDone: result.isDone, effectiveSandboxId, sleepRequested, backgroundTask };
  } catch (e: any) {
    console.error('[SingleTurn] Executor wrapper failed:', e);
    const transient = isSandboxGoneError(e.message);
    return { ok: false, isDone: false, transient, error: e.message, effectiveSandboxId };
  }
}
