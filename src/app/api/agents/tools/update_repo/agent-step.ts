'use step';

import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { Sandbox } from '@vercel/sandbox';
import { getAssistantTools, fetchMemoriesContext, generateAgentBackground } from '@/app/api/robots/instance/assistant/utils';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import { getStepCheckpointPromptFragment, SANDBOX_REPO_ROOT_INVARIANT, TOOL_LOOKUP_HINT, LANGUAGE_REQUIREMENT_PROMPT } from '@/app/api/cron/shared/step-git-prompts';
import { SandboxService } from '@/lib/services/sandbox-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function runUpdateRepoAgentStep(params: {
  sandboxId: string;
  reqId: string;
  requirementType: string;
  instruction: string;
  instanceId: string;
  site_id: string;
  user_id: string;
  git_repo_kind?: 'applications' | 'automation';
  requirementTitle?: string;
  globalStartTime?: number;
}) {
  'use step';
  const {
    sandboxId,
    reqId,
    requirementType,
    instruction,
    instanceId,
    site_id,
    user_id,
    git_repo_kind = 'applications',
    requirementTitle,
  } = params;

  const instanceType = git_repo_kind === 'automation' ? 'automation' : 'applications';
  const audit: CronAuditContext | undefined = site_id
    ? { instanceId, siteId: site_id, userId: user_id, requirementId: reqId }
    : undefined;
    
  let effectiveSandboxId = sandboxId;
  let sandbox: Sandbox;
  
  try {
    const connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId: reqId,
      instanceType,
      title: requirementTitle?.trim() || reqId,
      audit,
    });
    sandbox = connected.sandbox;
    effectiveSandboxId = connected.sandboxId;
  } catch (err: unknown) {
    console.error(`[UpdateRepoStep] 🚨 CRITICAL ERROR: connectOrRecreateRequirementSandbox failed:`, err);
    throw err;
  }

  const sandboxTools = getSandboxTools(sandbox, reqId, {
    site_id,
    instance_id: instanceId,
    git_repo_kind,
    requirement_type: requirementType,
  });

  const fullTools = getAssistantTools(site_id, user_id, instanceId, sandboxTools);

  // Background context
  let agentBackground = '';
  let memoriesContext = '';
  try {
    agentBackground = await generateAgentBackground(site_id);
    memoriesContext = await fetchMemoriesContext(site_id, user_id, instanceId);
  } catch(e) {}

  const systemPrompt = `You are an AI coding assistant and EXECUTOR agent running inside a Vercel Sandbox.
Your job is to complete a specific instruction on the codebase by writing code, running commands, and making real changes.

CRITICAL: YOU MUST EXECUTE EXACTLY ONE TOOL CALL PER RESPONSE.
Wait for the environment to execute the tool and return the result before you decide your next action.
DO NOT output multiple tool calls in a single response.

${SANDBOX_REPO_ROOT_INVARIANT}
${LANGUAGE_REQUIREMENT_PROMPT}

WORKSPACE — READ THIS CAREFULLY:
- ${SandboxService.WORK_DIR} is the GIT REPOSITORY ROOT. This is where package.json, next.config.ts, tsconfig.json, src/, and public/ already exist.
- The remote GitHub repo may be named "apps" — that is the repository name only. Do NOT create an extra folder called "apps/" or "app/" at the root for the Next.js app; routes belong in src/app/ only.
- NEVER run "npx create-next-app", "npm init", or create a new project. The project is ALREADY set up.
- To add a new page, write files under src/app/<route>/page.tsx only.
- To add components, write under src/components/.
- All relative paths in sandbox tools resolve from ${SandboxService.WORK_DIR}.
- FIRST ACTIONS (MANDATORY ORDER): (1) sandbox_list_files path="." to see the current project structure before writing code.
- LAST ACTION BEFORE STOPPING: Call sandbox_push_checkpoint (title_hint = "update_repo fix") after your work builds — mandatory if you modified files; see CHECKPOINTS section below.

COMPANY BACKGROUND & MEMORIES:
${agentBackground}
${memoriesContext}

CONTEXT:
- instance_id: ${instanceId}
- site_id: ${site_id}
- requirement_id: ${reqId}

INSTRUCTION TO EXECUTE:
${instruction}

SHELL LIMITATIONS:
- The sandbox shell is /bin/sh (NOT bash). Brace expansion like {a,b,c} does NOT work.
- FOR LONG COMMANDS (like npm run build, tests, or servers), ALWAYS use sandbox_start_background_command. Never use sandbox_run_command for them.

${TOOL_LOOKUP_HINT}
${getStepCheckpointPromptFragment(reqId, instanceId)}`;

  const MAX_TURNS = 25;
  let turns = 0;
  let isDone = false;
  let result: any;
  let messages: any[] = [{ role: 'user', content: `Execute the following instruction on the repository: ${instruction}` }];

  const agentModel = process.env.AI_CODE_MODEL || 'gemini-3.1-pro-preview-customtools';
  const globalStartTime = params.globalStartTime ?? Date.now();
  const MAX_EXECUTION_TIME_MS = 12 * 60 * 1000; // 12 minutes
  let timedOut = false;

  while (!isDone && turns < MAX_TURNS) {
    if (Date.now() - globalStartTime > MAX_EXECUTION_TIME_MS) {
      console.log(`[UpdateRepoStep] Agent reached max execution time (${MAX_EXECUTION_TIME_MS}ms). Halting to prevent Vercel timeout.`);
      timedOut = true;
      break;
    }

    turns++;
    try {
      result = await executeAssistantStep(
        messages,
        { id: instanceId, site_id, user_id, requirement_id: reqId },
        {
          use_sdk_tools: false,
          provider: 'gemini',
          ai_provider: 'gemini',
          instance_id: instanceId,
          site_id,
          user_id,
          requirement_id: reqId,
          system_prompt: systemPrompt,
          custom_tools: fullTools,
          ai_model: agentModel,
          enforceSingleTurn: true // Optional but helps limit hallucinating multiple calls
        },
      );
    } catch (rawErr: any) {
      console.error(`[UpdateRepoStep] Execution failed at turn ${turns}:`, rawErr);
      throw rawErr;
    }
    
    messages = result.messages || [];
    isDone = result.isDone;

    // Optional: add small sleep if background command is running
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'tool' && lastMessage.name === 'sandbox_check_background_command') {
      try {
        const contentStr = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
        const parsed = JSON.parse(contentStr);
        if (parsed.is_running === true) {
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch(e) {}
    }
  }

  console.log(`[UpdateRepoStep] Agent finished after ${turns} turn(s) (isDone=${isDone}, timedOut=${timedOut})`);
  return { turns, effectiveSandboxId, timedOut };
}
