/**
 * Inline plan step executor — runs WITHIN a 'use step' function so
 * tool closures (sandbox references) survive. This must NOT have
 * 'use step' itself.
 */

import { Sandbox } from '@vercel/sandbox';
import { SkillsService } from '@/lib/services/skills-service';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import type { AssistantContext } from '@/app/api/robots/instance/assistant/steps';
import { getStepCheckpointPromptFragment, SANDBOX_REPO_ROOT_INVARIANT } from './step-git-prompts';
import { runBuildAndOriginGate } from './step-git-gate';
import type { GitRepoKind } from './cron-commit-helpers';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { SandboxService } from '@/lib/services/sandbox-service';

const ROLE_TO_SKILL: Record<string, string> = {
  'template_selection': 'makinari-obj-template-selection',
  'frontend': 'makinari-rol-frontend',
  'backend': 'makinari-rol-backend',
  'devops': 'makinari-rol-devops',
  'content': 'makinari-rol-content',
  'orchestrator': 'makinari-rol-orchestrator',
  'investigate': 'makinari-fase-investigacion',
  'plan': 'makinari-fase-planeacion',
  'validate': 'makinari-fase-validacion',
  'report': 'makinari-fase-reporteado',
};

/**
 * Infer the role from step title/instructions when the orchestrator didn't set one.
 */
function inferRoleFromStep(step: any): string | null {
  const text = `${step.title || ''} ${step.instructions || ''}`.toLowerCase();
  if (
    /template|vitrina|vitrinas|bootstrap|project base|base branch|select.*repo|checkout.*origin/.test(
      text,
    )
  ) {
    return 'template_selection';
  }
  if (/deploy|ci\/cd|build|push|docker|nginx|vercel|infra|devops|smoke.?test/.test(text)) return 'devops';
  if (/css|ui|ux|component|page|layout|style|tailwind|react|html|responsive|frontend/.test(text)) return 'frontend';
  if (/api|endpoint|database|migration|server|auth|backend|supabase/.test(text)) return 'backend';
  if (/readme|copy|blog|seo|content|text|docs/.test(text)) return 'content';
  if (/investigat|research|audit|analyz|review/.test(text)) return 'investigate';
  if (/valid|test|check|verify|lint/.test(text)) return 'validate';
  return 'frontend'; // default for app requirements
}

/** First run + 5 reintentos con contexto de error del gate */
const MAX_GATE_ATTEMPTS = 6;

function buildGateRetryUserMessage(currentAttempt: number, maxAttempts: number, err: string): string {
  const remaining = maxAttempts - currentAttempt + 1;
  const wd = SandboxService.WORK_DIR;
  return [
    `VALIDATION FAILED — you are starting attempt ${currentAttempt} of ${maxAttempts} (${remaining} round(s) left including this one).`,
    'Automated gate output (npm run build / git push / Vercel deploy via GitHub):',
    '---',
    err.slice(0, 8000),
    '---',
    `Fix the root cause under ${wd} (e.g. restore package.json, npm install, fix build). Run npm run build until it passes, then sandbox_push_checkpoint before stopping.`,
  ].join('\n');
}

/**
 * Start the built app and verify the root route returns 200.
 * Called once after ALL plan steps complete (not per-step).
 */
export async function runSmokeTest(sandbox: Sandbox): Promise<string | null> {
  const cwd = SandboxService.WORK_DIR;
  const port = 4173 + Math.floor(Math.random() * 100);
  const smokeScript = [
    `cd ${cwd}`,
    `npx next start -p ${port} &`,
    `SERVER_PID=$!`,
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do`,
    `  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/ 2>/dev/null)`,
    `  if [ "$STATUS" != "000" ]; then break; fi`,
    `  sleep 1`,
    `done`,
    `HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/)`,
    `echo "SMOKE_RESULT:$HTTP_CODE"`,
    `kill $SERVER_PID 2>/dev/null || true`,
    `wait $SERVER_PID 2>/dev/null || true`,
  ].join('\n');

  const smokeRes = await sandbox.runCommand('sh', ['-c', smokeScript]);
  const stdout = await smokeRes.stdout();
  const match = stdout.match(/SMOKE_RESULT:(\d+)/);
  const httpCode = match ? parseInt(match[1], 10) : 0;

  console.log(`[SmokeTest] Root page → HTTP ${httpCode}`);

  if (httpCode === 0) return 'Smoke test: server did not start within 20s';
  if (httpCode === 404) return 'Smoke test: root page returns 404 — needs a working page at / (e.g. src/app/page.tsx)';
  if (httpCode >= 500) return `Smoke test: root page returns HTTP ${httpCode} (server error)`;
  if (httpCode >= 400) return `Smoke test: root page returns HTTP ${httpCode}`;
  return null;
}

export type InlineExecutePlanStepResult =
  | { ok: true }
  | { ok: false; gateError: string };

/**
 * Completes when gate passes ({ ok: true }) or after all gate retries ({ ok: false, gateError }).
 * Throws on unexpected execution errors.
 */
export async function inlineExecutePlanStep(
  context: AssistantContext,
  plan: any,
  step: any,
  sandbox: Sandbox,
  execOpts?: { gitRepoKind?: GitRepoKind },
): Promise<InlineExecutePlanStepResult> {
  const { instance_id, site_id, user_id } = context.executionOptions;
  const requirementId = context.instance?.requirement_id || '';

  const audit: CronAuditContext = {
    instanceId: instance_id,
    siteId: site_id,
    userId: user_id,
    requirementId: requirementId || undefined,
  };

  await updateInstancePlanCore({
    plan_id: plan.id, instance_id, site_id,
    steps: [{ id: step.id, status: 'in_progress', started_at: new Date().toISOString() }],
  });
  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.STEP_STATUS,
    message: `Plan step ${step.order} marked in_progress (${step.title || step.id})`,
    details: {
      plan_id: plan.id,
      step_id: step.id,
      step_order: step.order,
      status: 'in_progress',
    },
  });

  // Resolve role: explicit > inferred from step content
  const effectiveRole = step.role || inferRoleFromStep(step);
  if (!step.role && effectiveRole) {
    console.log(`[CronStep] Inferred role "${effectiveRole}" for step ${step.order} (no explicit role set)`);
  }

  let skillContext = '';
  const skillName = step.skill || (effectiveRole && ROLE_TO_SKILL[effectiveRole]);
  if (skillName) {
    const matched = SkillsService.getSkillBySlugOrName(skillName);
    if (matched) {
      console.log(`[CronStep] Injecting skill "${skillName}" for step ${step.order}`);
      skillContext = `\n\n--- SKILL INSTRUCTIONS: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`;
    }
  }

  const stepPrompt = `You are an EXECUTOR agent running inside a Vercel Sandbox.
Your job is to complete ONE specific step by writing code, running commands, and making real changes.

${SANDBOX_REPO_ROOT_INVARIANT}

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
- FIRST ACTIONS: (1) skill_lookup action=search with keywords from this step's objective, instructions, and stack; then skill_lookup action=get for each relevant playbook. (2) sandbox_list_files path="." to see the current project structure before writing code.
- LAST ACTION BEFORE STOPPING: Call sandbox_push_checkpoint (title_hint = this step's title) after your work builds — mandatory if you modified files; see CHECKPOINTS section below.

CONTEXT:
- instance_id: ${instance_id}
- site_id: ${site_id}
- requirement_id: ${requirementId}

PLAN: "${plan.title || ''}"
CURRENT STEP (Step ${step.order}):
Title: ${step.title}
Role: ${effectiveRole || 'general'}
Instructions: ${step.instructions}
Expected Output: ${step.expected_output || 'Complete the step successfully.'}
${skillContext ? `\nIMPORTANT — You MUST follow the skill instructions below. They are mandatory.\n${skillContext}` : ''}
SHELL LIMITATIONS:
- The sandbox shell is /bin/sh (NOT bash). Brace expansion like {a,b,c} does NOT work.
- WRONG: mkdir -p src/app/{community,guests,booking} — creates a LITERAL folder named "{community,guests,booking}".
- RIGHT: mkdir -p src/app/community src/app/guests src/app/booking — list each path separately.
- Always use explicit paths. Never rely on bash-specific features (brace expansion, arrays, process substitution).

RULES:
- Focus ONLY on this step. Do not plan — EXECUTE.
- Use sandbox_write_file, sandbox_run_command, sandbox_read_file to write and test code. You MUST use sandbox_push_checkpoint before finishing the step when you changed the repo (see CHECKPOINTS below). Use sandbox_restore_checkpoint (action=list | restore) only if you need to rewind locally.
- After implementing, VALIDATE your work: run "npm run build" and check for errors. If the build fails, fix it before finishing.
${getStepCheckpointPromptFragment(requirementId, instance_id)}`;

  const fullTools = getAssistantTools(site_id, user_id, instance_id, context.customTools);
  const initialUser = {
    role: 'user' as const,
    content: `Execute step ${step.order}: ${step.title}. ${step.instructions}`,
  };

  let currentMessages: any[] = [initialUser];
  let lastResult: any;
  const MAX_TURNS = 10;

  try {
    let lastGateError: string | null = null;

    for (let gateAttempt = 1; gateAttempt <= MAX_GATE_ATTEMPTS; gateAttempt++) {
      if (lastGateError) {
        currentMessages = [
          ...currentMessages,
          { role: 'user', content: buildGateRetryUserMessage(gateAttempt, MAX_GATE_ATTEMPTS, lastGateError) },
        ];
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.STEP_STATUS,
          level: 'warn',
          message: `Plan step ${step.order} gate retry ${gateAttempt}/${MAX_GATE_ATTEMPTS} (error context sent to model)`,
          details: {
            plan_id: plan.id,
            step_id: step.id,
            step_order: step.order,
            phase: 'gate_retry',
            error_excerpt: lastGateError.slice(0, 500),
          },
        });
      }

      const systemPromptThisRound =
        gateAttempt > 1
          ? `${stepPrompt}\n\n*** GATE RETRY ${gateAttempt}/${MAX_GATE_ATTEMPTS} ***\nA previous attempt failed automated validation. Read the latest user message for the exact error output and fix it before stopping.`
          : stepPrompt;

      let isDone = false;
      let turns = 0;
      while (!isDone && turns < MAX_TURNS) {
        turns++;
        console.log(`[CronStep] Step ${step.order} gateAttempt ${gateAttempt}/${MAX_GATE_ATTEMPTS} turn ${turns}`);
        lastResult = await executeAssistantStep(currentMessages, context.instance, {
          ...context.executionOptions,
          system_prompt: systemPromptThisRound,
          custom_tools: fullTools,
        });
        currentMessages = lastResult.messages;
        isDone = lastResult.isDone;
      }

      const planTitle = plan.title || step.title || 'plan';
      const gate = await runBuildAndOriginGate({
        sandbox,
        planTitle,
        requirementId,
        stepOrder: step.order,
        stepPrompt: systemPromptThisRound,
        currentMessages,
        context,
        fullTools,
        lastResult,
        audit,
        gitRepoKind: execOpts?.gitRepoKind,
      });

      if (gate.ok) {
        lastResult = gate.lastResult;
        const checkedAt = new Date().toISOString();
        const vd = gate.vercelDeploy;
        console.log(`[CronStep] Build + origin + deploy OK after step ${step.order} (gate attempt ${gateAttempt})`);
        await updateInstancePlanCore({
          plan_id: plan.id,
          instance_id,
          site_id,
          steps: [
            {
              id: step.id,
              status: 'completed',
              actual_output: lastResult?.text,
              completed_at: checkedAt,
              vercel_preview_url: vd?.previewUrl ?? null,
              vercel_deploy_state: vd?.deployState ?? null,
              vercel_deploy_checked_at: vd ? checkedAt : null,
              vercel_deploy_detail: vd?.detail ?? null,
            },
          ],
        });
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.STEP_STATUS,
          message: `Plan step ${step.order} completed (${step.title || step.id}) after ${gateAttempt} gate attempt(s)`,
          details: {
            plan_id: plan.id,
            step_id: step.id,
            step_order: step.order,
            status: 'completed',
            gate_attempts_used: gateAttempt,
          },
        });
        return { ok: true };
      }

      lastGateError = gate.error || 'Step completion gate failed';
      console.error(`[CronStep] Step ${step.order} gate failed (attempt ${gateAttempt}/${MAX_GATE_ATTEMPTS}): ${lastGateError}`);

      if (gateAttempt < MAX_GATE_ATTEMPTS) {
        continue;
      }

      await updateInstancePlanCore({
        plan_id: plan.id,
        instance_id,
        site_id,
        steps: [
          {
            id: step.id,
            status: 'failed',
            error_message: lastGateError,
            completed_at: new Date().toISOString(),
          },
        ],
      });
      await logCronInfrastructureEvent(audit, {
        event: CronInfraEvent.STEP_STATUS,
        level: 'error',
        message: `Plan step ${step.order} failed gate after ${MAX_GATE_ATTEMPTS} attempts: ${lastGateError.slice(0, 400)}`,
        details: {
          plan_id: plan.id,
          step_id: step.id,
          step_order: step.order,
          status: 'failed',
          phase: 'gate',
          gate_attempts: MAX_GATE_ATTEMPTS,
        },
      });
      return { ok: false, gateError: lastGateError };
    }
    return { ok: false, gateError: 'Step gate exhausted without result' };
  } catch (error: any) {
    console.error(`[CronStep] Step ${step.order} execution error: ${error.message}`);
    await updateInstancePlanCore({
      plan_id: plan.id, instance_id, site_id,
      steps: [{ id: step.id, status: 'failed', error_message: error.message, completed_at: new Date().toISOString() }],
    });
    await logCronInfrastructureEvent(audit, {
      event: CronInfraEvent.STEP_STATUS,
      level: 'error',
      message: `Plan step ${step.order} execution error: ${(error.message || '').slice(0, 400)}`,
      details: {
        plan_id: plan.id,
        step_id: step.id,
        step_order: step.order,
        status: 'failed',
        phase: 'executor_exception',
      },
    });
    throw error;
  }
}
