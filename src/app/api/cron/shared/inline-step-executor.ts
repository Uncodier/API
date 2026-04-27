/**
 * Inline plan step executor — runs WITHIN a 'use step' function so
 * tool closures (sandbox references) survive. This must NOT have
 * 'use step' itself.
 */

import { Sandbox } from '@vercel/sandbox';
import { SkillsService } from '@/lib/services/skills-service';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import { routeTools } from '@/app/api/agents/tools/tool_lookup/assistantProtocol';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import type { AssistantContext } from '@/app/api/robots/instance/assistant/steps';
import { getStepCheckpointPromptFragment, SANDBOX_REPO_ROOT_INVARIANT, TOOL_LOOKUP_HINT } from './step-git-prompts';
import { runGateForFlow } from './gates';
import type { GitRepoKind } from './cron-commit-helpers';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import { SandboxService } from '@/lib/services/sandbox-service';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import {
  deriveCategoriesFailed,
  deriveRetryBucket,
  formatIterationSignals,
  type StepIterationSignals,
  type VisualDefect,
} from './step-iteration-signals';
import { runArchetypePostGate, extractBacklogItemId } from './step-archetype-postgate';
import { detectActionLoop, type AssistantToolCallSnapshot } from './loop-detectors';
import { syncProgressEntry } from '@/lib/services/requirement-ground-truth';
import { logAssumption } from '@/lib/services/requirement-backlog';

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

function collectStepToolCallSnapshots(messages: any[]): AssistantToolCallSnapshot[] {
  const out: AssistantToolCallSnapshot[] = [];
  for (const m of messages) {
    const toolCalls = (m as any)?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const name = tc?.function?.name;
      if (typeof name !== 'string') continue;
      let command: string | undefined;
      if (name === 'sandbox_run_command') {
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          if (typeof args?.command === 'string') command = args.command;
          else if (Array.isArray(args?.args)) command = [args?.cmd, ...args.args].filter(Boolean).join(' ');
        } catch { /* ignore */ }
      }
      out.push({ name, command });
    }
  }
  return out;
}

/**
 * Infer the role from step title/instructions when the orchestrator didn't set one.
 */
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

/**
 * Retry budgets are split so subjective polish (visual) can't consume retries
 * reserved for hard failures. Categories are derived from signal state.
 */
const MAX_BUILD_RETRIES = 6;
const MAX_RUNTIME_RETRIES = 4;
const MAX_VISUAL_RETRIES = 3;

type RetryBucket = 'build' | 'runtime' | 'visual';

function budgetFor(bucket: RetryBucket): number {
  if (bucket === 'build') return MAX_BUILD_RETRIES;
  if (bucket === 'runtime') return MAX_RUNTIME_RETRIES;
  return MAX_VISUAL_RETRIES;
}

function buildGateRetryUserMessage(signals: StepIterationSignals, oversizeFiles?: string[]): string {
  const wd = SandboxService.WORK_DIR;
  const baseMessage = [
    formatIterationSignals(signals),
    '',
    `(sandbox work_dir: ${wd}) After fixing, call sandbox_push_checkpoint once the build + runtime are clean.`,
  ].join('\\n');

  if (oversizeFiles && oversizeFiles.length > 0) {
    const warning = [
      '',
      '🚨 MANDATORY REFACTORING REQUIRED 🚨',
      'The following files exceed the 500-line limit:',
      ...oversizeFiles.map(f => `  - ${f}`),
      '',
      'You MUST refactor these files into smaller components (e.g., extract sections into new files) BEFORE attempting to fix any visual regressions or logic bugs. Editing oversized files leads to duplications and stray characters.',
    ].join('\\n');
    return baseMessage + warning;
  }

  return baseMessage;
}

/**
 * Checks for modified files that exceed the 500-line limit.
 */
async function checkOversizeFiles(sandbox: Sandbox): Promise<string[]> {
  const wd = SandboxService.WORK_DIR;
  const script = `
    cd ${wd}
    # Get modified files (unstaged + staged) or just check common large files if no diff
    files=$(git diff --name-only HEAD || find src -name "*.tsx" -o -name "*.ts" | head -n 20)
    oversize=""
    for f in $files; do
      if [ -f "$f" ]; then
        lines=$(wc -l < "$f" | tr -d ' ')
        if [ "$lines" -gt 500 ]; then
          oversize="$oversize$f ($lines lines)\\n"
        fi
      fi
    done
    echo -n "$oversize"
  `;
  try {
    const res = await sandbox.runCommand('sh', ['-c', script]);
    const out = await res.stdout();
    return out.split('\\n').filter(line => line.trim().length > 0);
  } catch (e) {
    console.warn('[CronStep] Failed to check oversize files:', e);
    return [];
  }
}

/**
 * Persists visual critic feedback to the ground truth (progress.md and backlog assumptions)
 * so that QA or subsequent cycles are aware of visual defects that didn't block the gate
 * or were present when retries were exhausted.
 */
async function persistVisualFeedback(params: {
  sandbox: Sandbox;
  requirementId: string;
  itemId: string;
  defects: VisualDefect[];
}) {
  if (!params.defects || params.defects.length === 0) return;
  
  try {
    const defectLines = params.defects.map(d => `[${d.severity}] ${d.category}: ${d.description}`).join(' | ');
    const feedbackMsg = `Visual Critic Feedback: ${defectLines}`;
    
    // 1. Log to progress.md for session history
    await syncProgressEntry({
      sandbox: params.sandbox,
      cwd: SandboxService.WORK_DIR,
      requirementId: params.requirementId,
      entry: {
        ts: new Date().toISOString(),
        item_id: params.itemId,
        summary: feedbackMsg.slice(0, 200),
      }
    });
    
    // 2. Add to backlog assumptions so it reflects in instructions
    await logAssumption({
      requirementId: params.requirementId,
      itemId: params.itemId,
      assumption: feedbackMsg.slice(0, 500)
    });
    
    console.log(`[CronStep] Persisted visual critic feedback for item ${params.itemId}`);
  } catch (e) {
    console.warn(`[CronStep] Failed to persist visual critic feedback:`, e);
  }
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
  | { ok: false; gateError: string; sandboxUnavailable?: boolean };

/**
 * Completes when gate passes ({ ok: true }) or after all gate retries ({ ok: false, gateError }).
 * Throws on unexpected execution errors.
 */
export async function inlineExecutePlanStep(
  context: AssistantContext,
  plan: any,
  step: any,
  sandbox: Sandbox,
  execOpts?: {
    gitRepoKind?: GitRepoKind;
    flow?: RequirementKind;
    sandboxActiveRef?: { current: Sandbox };
    globalStartTime?: number;
  },
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

  const effectiveRole = step.role || inferRoleFromStep(step) || 'general';
  if (!step.role && effectiveRole !== 'general') {
    console.log(`[CronStep|${effectiveRole}] Inferred role "${effectiveRole}" for step ${step.order} (no explicit role set)`);
  }

  let skillContext = '';
  const skillName = step.skill || (effectiveRole && ROLE_TO_SKILL[effectiveRole]);
  if (skillName) {
    const matched = SkillsService.getSkillBySlugOrName(skillName);
    if (matched) {
      console.log(`[CronStep|${effectiveRole}] Injecting skill "${skillName}" for step ${step.order}`);
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
- CRITICAL EXECUTION RULES:
  1. ALWAYS THINK OUT LOUD: You MUST explain your reasoning and plan inside the \`thought_process\` parameter of every tool call.
  2. MAXIMIZE PARALLELISM: If you need to read multiple files, list multiple directories, or run independent commands, you MUST call multiple tools in parallel in a single response. Do not do things sequentially if they can be batched.
  3. AVOID LOOPS: If you find yourself reading the same files or running the same commands without making progress, STOP. Re-evaluate your approach and use a different tool (like sandbox_code_search instead of reading files blindly).
  4. DATA VS UI RULE: If visual feedback shows "Missing Content" or empty lists, DO NOT change CSS/UI first. Verify the API response, database seed, and console logs. You might be trying to fix a data problem with CSS. You can use \`sandbox_read_logs\` to check server/console logs if needed.
  5. CIRCUIT BREAKER: If you attempt to fix the same visual regression or UI bug 3 times and fail, YOU MUST STOP. Revert your last broken changes, mark the step as blocked, and explain the technical reason. Do not enter infinite loops.
  6. FILE SIZE LIMIT: You MUST respect the 500-line limit per file. If a file is too large, refactor it into smaller components BEFORE applying fixes. Duplications and stray characters occur when editing files that are too large.
  7. VISUAL CRITIC FEEDBACK: If the gate returns visual defects, you MUST fix them. If a defect is impossible to fix in this step, you MUST use the \`requirement_backlog\` tool with \`action="log_assumption"\` to document it for QA before you stop.
- Use sandbox_write_file, sandbox_run_command, sandbox_read_file to write and test code. You MUST use sandbox_push_checkpoint before finishing the step when you changed the repo (see CHECKPOINTS below). Use sandbox_restore_checkpoint (action=list | restore) only if you need to rewind locally. Use sandbox_read_logs to read server and console logs.
- After implementing, VALIDATE your work: run "npm run build" and check for errors. If the build fails, fix it before finishing.
- CRITICAL: Do NOT mock data or use hardcoded responses in the UI unless explicitly requested. You MUST integrate with real backend APIs and databases. If a feature is transactional (e.g., booking, creating, updating), you MUST implement the full end-to-end flow.
- CRITICAL: For authentication and user management (login, signup, roles, protected routes), you MUST implement real authentication (e.g., Supabase Auth, NextAuth, or custom JWT) and enforce it in the backend and frontend. Do NOT use fake "isLoggedIn = true" states.
- CRITICAL: TDD & DB MIGRATIONS. You MUST write Jest tests and Supabase migrations before marking the step as complete. Run tests using: \`${step.test_command || 'npm run test'}\`. The Judge will reject core items without passing tests.

${TOOL_LOOKUP_HINT}
${getStepCheckpointPromptFragment(requirementId, instance_id)}`;

  // Route tools through `tool_lookup` so the LLM only sees the always-on
  // minimal surface (sandbox_*, instance_plan, requirement_status,
  // requirements, skill_lookup, tool_lookup). Every other tool — media,
  // messaging, CRM, social, content, infra, research — is discoverable via
  // `tool_lookup({ action: "list" })` and invocable via `tool_lookup({ action:
  // "call", name, args })`. Drastically shrinks the schema payload sent to
  // Gemini/GPT on every turn without removing any capability.
  const fullTools = routeTools(
    getAssistantTools(site_id, user_id, instance_id, context.customTools),
  );
  
  // Añadir explícitamente instance_logs a las herramientas disponibles en el prompt
  const hasLogsTool = fullTools.some(t => t.name === 'tool_lookup' || t.name === 'instance_logs');
  const initialUser = {
    role: 'user' as const,
    content: `Execute step ${step.order}: ${step.title}. ${step.instructions}`,
  };

  let currentMessages: any[] = [initialUser];
  let lastResult: any;
  const MAX_TURNS = 10;
  const globalStartTime = execOpts?.globalStartTime ?? Date.now();
  const MAX_EXECUTION_TIME_MS = 4 * 60 * 1000; // 4 minutes

  try {
    const used: Record<RetryBucket, number> = { build: 0, runtime: 0, visual: 0 };
    let lastSignals: StepIterationSignals | null = null;
    let lastGateError: string | null = null;
    let totalAttempts = 0;
    const HARD_CAP_ATTEMPTS = MAX_BUILD_RETRIES + MAX_RUNTIME_RETRIES + MAX_VISUAL_RETRIES;

    while (totalAttempts < HARD_CAP_ATTEMPTS) {
      totalAttempts++;
      if (lastSignals) {
        const recentCalls = collectStepToolCallSnapshots(currentMessages).slice(-12);
        const action = detectActionLoop(recentCalls);
        if (action.triggered) {
          console.warn(
            `[CronStep|${effectiveRole}] Step ${step.order} action loop detected (${action.reason}). Skipping retry → falling back to gate failure for self-heal.`,
          );
          await logCronInfrastructureEvent(audit, {
            event: CronInfraEvent.STEP_STATUS,
            level: 'warn',
            message: `Action loop on step ${step.order}: ${action.reason}`,
            details: { step_id: step.id, metrics: action.metrics },
          });
          return { ok: false, gateError: action.reason ?? 'Action loop detected' };
        }
      }
      if (lastSignals) {
        const oversizeFiles = await checkOversizeFiles(sandbox);
        currentMessages = [
          ...currentMessages,
          { role: 'user', content: buildGateRetryUserMessage(lastSignals, oversizeFiles) },
        ];
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.STEP_STATUS,
          level: 'warn',
          message: `Plan step ${step.order} gate retry ${totalAttempts} bucket=${lastSignals.bucket || 'n/a'} (error context sent to model)`,
          details: {
            plan_id: plan.id,
            step_id: step.id,
            step_order: step.order,
            phase: 'gate_retry',
            bucket: lastSignals.bucket,
            categories_failed: lastSignals.categories_failed,
            error_excerpt: (lastGateError || '').slice(0, 500),
            used_budgets: { ...used },
            oversize_files: oversizeFiles,
          },
        });
      }

      const systemPromptThisRound =
        totalAttempts > 1
          ? `${stepPrompt}\n\n*** GATE RETRY ${totalAttempts} (bucket=${lastSignals?.bucket || 'unknown'}) ***\nA previous attempt failed automated validation. Read the latest user message for the exact error output and fix it before stopping.`
          : stepPrompt;

      let isDone = false;
      let turns = 0;

      while (!isDone && turns < MAX_TURNS) {
        if (Date.now() - globalStartTime > MAX_EXECUTION_TIME_MS) {
          console.log(`[CronStep|${effectiveRole}] Step ${step.order} reached max execution time (${MAX_EXECUTION_TIME_MS}ms). Halting to prevent Vercel timeout.`);
          break;
        }

        turns++;
        console.log(`[CronStep|${effectiveRole}] Step ${step.order} attempt ${totalAttempts} turn ${turns}`);
        try {
          lastResult = await executeAssistantStep(currentMessages, context.instance, {
            ...context.executionOptions,
            system_prompt: systemPromptThisRound,
            custom_tools: fullTools,
          });
          
          // If any tool returned a sandbox gone error to the LLM, intercept it
          // so we can reprovision the sandbox instead of letting the LLM give up.
          const hasSandboxGoneError = lastResult.messages?.some((m: any) => 
            m.role === 'tool' && isSandboxGoneError(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
          );
          
          if (hasSandboxGoneError) {
            throw new Error('410 Gone / sandbox_stopped');
          }
          
          currentMessages = lastResult.messages;
          isDone = lastResult.isDone;
        } catch (err: any) {
          if (isSandboxGoneError(err?.message || String(err))) {
            console.warn(`[CronStep|${effectiveRole}] Sandbox gone mid-step (turn ${turns}). Reprovisioning and retrying turn...`);
            const re = await connectOrRecreateRequirementSandbox({
              sandboxId: sandbox.sandboxId,
              requirementId,
              instanceType: execOpts?.gitRepoKind === 'automation' ? 'automation' : 'applications',
              title: plan.title || step.title || requirementId,
              audit,
            });
            sandbox = re.sandbox;
            if (execOpts?.sandboxActiveRef) {
              execOpts.sandboxActiveRef.current = sandbox;
            }
            // Re-run the turn
            turns--;
            continue;
          }
          throw err;
        }
      }

      const planTitle = plan.title || step.title || 'plan';
      const flow: RequirementKind = execOpts?.flow ?? 'app';
      const gateSandbox = execOpts?.sandboxActiveRef?.current ?? sandbox;
      
      let gate: Awaited<ReturnType<typeof runGateForFlow>>;
      if (Date.now() - globalStartTime > MAX_EXECUTION_TIME_MS) {
        console.log(`[CronStep|${effectiveRole}] Skipping gate validation because max execution time was reached during LLM turns. Saving WIP state.`);
        try {
          await SandboxService.commitAndPush(gateSandbox, {
            requirementId,
            title: planTitle,
            message: `WIP: Paused due to time limit on step ${step.order}`,
          });
        } catch (e) {
          console.warn(`[CronStep|${effectiveRole}] Failed to save WIP state:`, e);
        }
        gate = { ok: false, error: 'Execution time limit reached before validation. Will resume next cycle.', flow, signals: [] };
      } else {
        gate = await runGateForFlow({
          sandbox: gateSandbox,
          workDir: SandboxService.WORK_DIR,
          requirementId,
          flow,
          audit,
          appContext: {
            planTitle,
            stepOrder: step.order,
            stepPrompt: systemPromptThisRound,
            stepContext: {
              title: step.title,
              instructions: step.instructions,
              expected_output: step.expected_output,
              brand_context: (plan as any)?.brand_context,
            },
            currentMessages,
            assistantContext: context,
            fullTools,
            lastResult,
            gitRepoKind: execOpts?.gitRepoKind,
          },
        });
      }

      // Back-compat shape for the rest of the loop: the app/site gate
      // populates `richSignals` + `vercelDeploy` + `lastResult`; light gates
      // only populate `signals[]`. Fall back to empty objects so downstream
      // code that reads `gate.signals.*` keeps working.
      const rich = gate.richSignals ?? {};

      // --- PERSIST VISUAL CRITIC FEEDBACK ---
      const visualDefects = rich.visual?.defects;
      if (visualDefects && visualDefects.length > 0) {
        const backlogItemId = extractBacklogItemId(step);
        if (backlogItemId) {
          try {
            const defectLines = visualDefects.map(d => `[${d.severity}] ${d.category}: ${d.description}`).join(' | ');
            const feedbackMsg = `Visual Critic Feedback: ${defectLines}`;
            
            // 1. Log to progress.md for session history
            await syncProgressEntry({
              sandbox: gateSandbox,
              cwd: SandboxService.WORK_DIR,
              requirementId,
              entry: {
                ts: new Date().toISOString(),
                item_id: backlogItemId,
                summary: feedbackMsg.slice(0, 200),
              }
            });
            
            // 2. Add to backlog assumptions so it reflects in instructions
            await logAssumption({
              requirementId,
              itemId: backlogItemId,
              assumption: feedbackMsg.slice(0, 500)
            });
            
            console.log(`[CronStep|${effectiveRole}] Persisted visual critic feedback for item ${backlogItemId}`);
          } catch (e) {
            console.warn(`[CronStep|${effectiveRole}] Failed to persist visual critic feedback:`, e);
          }
        }
      }
      // --------------------------------------

      if (!gate.ok && gate.sandboxUnavailable) {
        const msg = gate.error || 'Sandbox microVM is no longer available.';
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.STEP_STATUS,
          level: 'warn',
          message: `Plan step ${step.order} gate: sandbox unavailable (infra) — ${msg.slice(0, 400)}`,
          details: {
            plan_id: plan.id,
            step_id: step.id,
            step_order: step.order,
            phase: 'gate_sandbox_gone',
            sandbox_unavailable: true,
          },
        });
        return { ok: false, gateError: msg, sandboxUnavailable: true };
      }
      if (gate.ok) {
        lastResult = gate.lastResult ?? lastResult;
        const checkedAt = new Date().toISOString();
        const vd = gate.vercelDeploy;
        console.log(`[CronStep|${effectiveRole}] Gate OK for flow "${flow}" after step ${step.order} (attempt ${totalAttempts})`);

        const backlogItemId = extractBacklogItemId(step);
        
        // --- PERSIST VISUAL CRITIC FEEDBACK ---
        // Even if the gate passes, there might be minor visual defects that QA should know about.
        const visualDefects = rich.visual?.defects;
        if (visualDefects && visualDefects.length > 0 && backlogItemId) {
          await persistVisualFeedback({
            sandbox: gateSandbox,
            requirementId,
            itemId: backlogItemId,
            defects: visualDefects,
          });
        }
        // --------------------------------------

        if (backlogItemId) {
          await runArchetypePostGate({
            sandbox: gateSandbox,
            requirementId,
            backlogItemId,
            stepId: step.id,
            signals: rich,
            capturedAt: checkedAt,
            audit,
          });
        }

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
          message: `Plan step ${step.order} completed (${step.title || step.id}) after ${totalAttempts} attempt(s)`,
          details: {
            plan_id: plan.id,
            step_id: step.id,
            step_order: step.order,
            status: 'completed',
            attempts_used: totalAttempts,
            budgets_used: used,
          },
        });
        return { ok: true };
      }

      lastGateError = gate.error || 'Step completion gate failed';
      const categories = deriveCategoriesFailed(rich);
      const bucket = deriveRetryBucket(categories);
      used[bucket]++;
      const nextSignals: StepIterationSignals = {
        attempt: totalAttempts,
        max_attempts: HARD_CAP_ATTEMPTS,
        bucket,
        step: {
          order: step.order,
          title: step.title,
          expected_output: step.expected_output,
        },
        build: rich.build,
        runtime: rich.runtime,
        api: rich.api,
        console: rich.console,
        visual: rich.visual,
        scenarios: rich.scenarios,
        origin: rich.origin,
        deploy: rich.deploy,
        categories_failed: categories,
        top_level_error: lastGateError,
      };
      lastSignals = nextSignals;
      console.error(
        `[CronStep|${effectiveRole}] Step ${step.order} gate failed (attempt ${totalAttempts}, bucket=${bucket}, budgets_used=${JSON.stringify(used)}): ${lastGateError.slice(0, 200)}`,
      );

      const bucketLimit = budgetFor(bucket);
      const bucketExhausted = used[bucket] > bucketLimit;

      if (bucketExhausted || Date.now() - globalStartTime > MAX_EXECUTION_TIME_MS) {
        const reason = bucketExhausted 
          ? `bucket "${bucket}" exhausted after ${used[bucket] - 1}/${bucketLimit} retries`
          : `max execution time reached (${MAX_EXECUTION_TIME_MS}ms)`;
          
        if (bucketExhausted) {
          // --- PERSIST VISUAL CRITIC FEEDBACK ON FAILURE ---
          // If we exhausted retries and there are visual defects, log them so they aren't lost.
          const backlogItemId = extractBacklogItemId(step);
          const visualDefects = rich.visual?.defects;
          if (visualDefects && visualDefects.length > 0 && backlogItemId) {
            await persistVisualFeedback({
              sandbox: gateSandbox,
              requirementId,
              itemId: backlogItemId,
              defects: visualDefects,
            });
          }
          // -------------------------------------------------

          await updateInstancePlanCore({
            plan_id: plan.id,
            instance_id,
            site_id,
            steps: [
              {
                id: step.id,
                status: 'failed',
                error_message: `${reason}: ${lastGateError}`,
                completed_at: new Date().toISOString(),
              },
            ],
          });
        }
        
        await logCronInfrastructureEvent(audit, {
          event: CronInfraEvent.STEP_STATUS,
          level: bucketExhausted ? 'error' : 'warn',
          message: bucketExhausted 
            ? `Plan step ${step.order} failed gate (${reason}): ${lastGateError!.slice(0, 300)}`
            : `Plan step ${step.order} paused due to time limit. Will resume next cycle.`,
          details: {
            plan_id: plan.id,
            step_id: step.id,
            step_order: step.order,
            status: bucketExhausted ? 'failed' : 'paused',
            phase: 'gate',
            bucket,
            bucket_limit: bucketLimit,
            budgets_used: used,
            categories_failed: categories,
          },
        });
        return { ok: false, gateError: lastGateError! };
      }
    }

    return { ok: false, gateError: 'Step gate exhausted without result' };
  } catch (error: any) {
    console.error(`[CronStep|${effectiveRole}] Step ${step.order} execution error: ${error.message}`);
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
