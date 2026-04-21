'use workflow';

import {
  ORCHESTRATOR_SKILL_LOOKUP_HINT,
  ORCHESTRATOR_STEP_ORIGIN_RULE,
  SANDBOX_REPO_ROOT_INVARIANT,
  TOOL_LOOKUP_HINT,
} from '../shared/step-git-prompts';
import {
  createSandboxStep,
  cleanupNestedProjectsStep,
  getActiveInstancePlanStep,
  reconcilePlanStep,
  commitAndPushStep,
  postFinallyBuildStep,
  recordPostFinallyBuildFailureStep,
  getPreviewUrlStep,
  checkSourceCodeStep,
  stopSandboxStep,
  releaseRunLockStep,
} from '../shared/cron-steps';
import { executeStepsPhaseStep, type ExecuteStepsPhaseResult } from '../shared/cron-execute-steps-phase';
import { runOrchestratorStep } from '../shared/cron-orchestrator-step';
import { validateDeliverablesStep, createFinalStatusStep } from '../shared/cron-workflow-finalize';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

export interface CronAppsWorkflowInput {
  reqId: string;
  title: string;
  instructions: string | null;
  type: string;
  site_id: string;
  user_id: string;
  instanceId: string;
  previousWorkContext: string;
  instance_type: string;
  /** Advisory lock id acquired by the cron route; used to release on workflow end. */
  cronLockRunId?: string;
}

export async function runCronAppsWorkflow(input: CronAppsWorkflowInput) {
  'use workflow';

  const { reqId, title, instructions, type, site_id, user_id, instanceId, previousWorkContext, cronLockRunId } = input;
  console.log(`[CronAppsWorkflow] Starting for req ${reqId}: ${title}`);

  const cronAudit: CronAuditContext = {
    instanceId,
    siteId: site_id,
    userId: user_id,
    requirementId: reqId,
  };

  try {
  // Step 1: Create sandbox → returns serializable info
  const created = await createSandboxStep(reqId, type, title, cronAudit);
  let sandboxId = created.sandboxId;
  const { branchName, workDir, isNewBranch, instanceType } = created;

  // Step 1b: Remove any nested project directories left by previous agent cycles
  const cleanup = await cleanupNestedProjectsStep(sandboxId, cronAudit, {
    requirementId: reqId,
    title,
    instanceType,
  });
  sandboxId = cleanup.effectiveSandboxId;

  // Build orchestrator prompt (pure string, no imports needed)
  const orchestratorPrompt = buildOrchestratorPrompt({
    reqId, title, type, instructions, instanceId, site_id,
    workDir, branchName, isNewBranch, previousWorkContext,
  });

  // Step 2: Check for active plan
  const existingPlan = await getActiveInstancePlanStep(instanceId, site_id);
  const actionableSteps = existingPlan?.steps
    ? (existingPlan.steps as any[]).filter((s: any) =>
        s.status === 'pending' || s.status === 'in_progress' || (s.status === 'failed' && (s.retry_count ?? 0) < 2))
    : [];
  const skipOrchestrator = existingPlan && actionableSteps.length > 0;

  // Step 3: Run orchestrator (if no pending plan)
  if (!skipOrchestrator) {
    console.log(`[CronAppsWorkflow] PHASE 1: Running orchestrator`);
    const prompt = isNewBranch
      ? `Process requirement "${title}". Read instructions, investigate, then create an instance_plan with actionable steps (each with a role).`
      : `Continue "${title}". All previous steps done — create a NEW plan for the next iteration.`;

    const orch = await runOrchestratorStep({
      sandboxId,
      reqId,
      requirementType: type,
      orchestratorPrompt,
      instanceId,
      site_id,
      user_id,
      initialMessage: prompt,
      requirementTitle: title,
    });
    sandboxId = orch.effectiveSandboxId;

    // Safety net: if the orchestrator finished without creating a plan AND no
    // active plan exists yet, the cron would otherwise commit empty and flip
    // the requirement back to in-progress forever. Record an explicit blocker
    // so the next cycle sees a clear reason and operators can intervene.
    if (!orch.createdPlan) {
      const postOrchPlan = await getActiveInstancePlanStep(instanceId, site_id);
      if (!postOrchPlan) {
        console.warn(
          `[CronAppsWorkflow] Orchestrator produced no instance_plan for req ${reqId} — recording blocker status.`,
        );
        try {
          const { createRequirementStatusCore } = await import(
            '@/app/api/agents/tools/requirement_status/route'
          );
          await createRequirementStatusCore({
            site_id,
            instance_id: instanceId,
            requirement_id: reqId,
            status: 'blocked',
            message:
              'Orchestrator finished without producing an instance_plan. Likely causes: tool schema rejection, model tool-call loop, or missing skills. Next cycle will retry; escalate to a human if this repeats.',
          });
        } catch (err) {
          console.error('[CronAppsWorkflow] Failed to record orchestrator-no-plan blocker:', err);
        }
      }
    }
  } else {
    console.log(`[CronAppsWorkflow] SKIP ORCHESTRATOR — plan "${existingPlan!.title}" has ${actionableSteps.length} actionable step(s)`);
  }

  // Step 4: Execute plan steps (always re-fetch so pause/delete in the same cycle is respected)
  const activePlan = await getActiveInstancePlanStep(instanceId, site_id);
  let planCompleted = false;

  let smokeError: string | null = null;
  let pushResult: { branch: string; pushed: boolean; commitCount: number } | null = null;
  let stepsPhase: ExecuteStepsPhaseResult | null = null;

  try {
    if (activePlan?.steps) {
      stepsPhase = await executeStepsPhaseStep({
        sandboxId,
        title,
        reqId,
        requirementType: type,
        orchestratorPrompt,
        instanceId,
        site_id,
        user_id,
        planId: activePlan.id,
        planStatus: activePlan.status,
        steps: activePlan.steps as any[],
      });
      smokeError = stepsPhase?.smokeError ?? null;
      if (stepsPhase?.effectiveSandboxId) {
        sandboxId = stepsPhase.effectiveSandboxId;
      }
      const reconciledStatus = await reconcilePlanStep(activePlan.id);
      planCompleted = reconciledStatus === 'completed';
    } else {
      console.log(`[CronAppsWorkflow] No active plan found.`);
    }
  } finally {
    const anyFail = stepsPhase?.anyStepFailed ?? false;
    if (!anyFail) {
      const pushed = await commitAndPushStep(sandboxId, title, reqId, undefined, cronAudit, 'applications');
      pushResult = pushed;
      if (pushed?.effectiveSandboxId) {
        sandboxId = pushed.effectiveSandboxId;
      }
    } else {
      console.log(
        '[CronAppsWorkflow] Skipping commitAndPushStep — anyStepFailed (policy: no forced platform push)',
      );
      pushResult = { branch: branchName, pushed: false, commitCount: 0 };
    }
  }

  let postFinallyBuildError: string | undefined;
  if (pushResult && !(stepsPhase?.anyStepFailed)) {
    const pf = await postFinallyBuildStep(sandboxId, cronAudit, {
      requirementId: reqId,
      title,
      instanceType,
    });
    sandboxId = pf.effectiveSandboxId;
    if (!pf.ok && pf.error) {
      postFinallyBuildError = pf.error;
      if (activePlan?.id && stepsPhase?.lastTouchedStepId) {
        await recordPostFinallyBuildFailureStep({
          planId: activePlan.id,
          siteId: site_id,
          instanceId,
          stepId: stepsPhase.lastTouchedStepId,
          error: pf.error,
        });
      }
    }
  }

  const effectiveBranch = pushResult?.branch || branchName;
  const didPush = !!pushResult?.pushed;

  // Step 6: Get preview URL using the requirement's persisted git binding
  // (metadata.git) so we query the same repo that the sandbox pushed to.
  const { resolveGitBindingForRequirement } = await import('../shared/cron-commit-helpers');
  const binding = await resolveGitBindingForRequirement(reqId, 'applications');
  const owner = binding.org;
  const repoName = binding.repo;
  const previewUrl = await getPreviewUrlStep(owner, repoName, effectiveBranch);

  // Step 7: Check source code
  const sourceCodeUrl = await checkSourceCodeStep(reqId);

  // Step 8: HTTP validation — also checks repo_url / branch consistency vs
  // the requirement's metadata.git (advisory unless REQUIREMENT_GIT_STRICT=true).
  const repoUrl = `https://github.com/${owner}/${repoName}/tree/${effectiveBranch}`;
  const { repoOk, previewOk } = await validateDeliverablesStep({
    repoUrl,
    previewUrl: previewUrl || undefined,
    requirementId: reqId,
    audit: cronAudit,
  });

  // Step 9: Final status — all gates must pass (including smoke test)
  const smokeOk = !smokeError;
  const { effectiveStatus: finalStatus } = await createFinalStatusStep({
    site_id, instanceId, reqId,
    repoUrl,
    previewUrl: previewUrl || undefined,
    sourceCodeUrl: sourceCodeUrl || undefined,
    didPush,
    planCompleted,
    repoOk,
    previewOk,
    smokeError: smokeError || undefined,
    postFinallyBuildError,
    audit: cronAudit,
  });

  // Step 10: Clean up sandbox
  await stopSandboxStep(sandboxId, cronAudit);

  return { reqId, branch: effectiveBranch, previewUrl, status: finalStatus };
  } finally {
    await releaseRunLockStep(reqId, cronLockRunId);
  }
}

// ─── Helper: build orchestrator prompt (pure string, no external deps) ───

function buildOrchestratorPrompt(p: {
  reqId: string; title: string; type: string; instructions: string | null;
  instanceId: string; site_id: string;
  workDir: string; branchName: string; isNewBranch: boolean;
  previousWorkContext: string;
}): string {
  return `You are a developer assistant running inside a secure Vercel Sandbox.

${SANDBOX_REPO_ROOT_INVARIANT}

WORKSPACE:
- ${p.workDir} is the GIT REPOSITORY ROOT on branch "${p.branchName}".
- The project uses Next.js App Router with the src/ directory: pages are at src/app/, components at src/components/.
- CRITICAL: The GitHub repository may be named "apps" — that is NOT a folder to create inside the sandbox. Do NOT add a root folder called "apps/" unless the existing repo already uses that layout (it does not in this template).
- CRITICAL: Do NOT create a root directory named "app/" for the Next.js project. Docs say "app directory" meaning the App Router segment — in THIS repo that is ONLY "src/app/" (e.g. src/app/page.tsx). A path like "app/src/app/page.tsx" is always wrong.
- NEVER create nested project directories (app/, my-app/, frontend/). NEVER run npx create-next-app.
${p.isNewBranch ? '- This is a NEW branch — you still start from the same base repo (package.json at root); add routes under src/app/, not under a new app/ folder.' : '- This branch already has code — review the current state before planning.'}

REQUIREMENT:
- ID: ${p.reqId}
- Title: ${p.title}
- Type: ${p.type}
- Instructions: ${p.instructions || 'No specific instructions provided.'}

INSTANCE:
- instance_id: ${p.instanceId}
- site_id: ${p.site_id}
${p.previousWorkContext}
INSTRUCTIONS AS LIVING README:
requirement.instructions is the single source of truth — treat it as the README / brain.
EVERY cycle you MUST update instructions (via requirements tool, action="update", requirement_id="${p.reqId}").

YOUR ROLE: ORCHESTRATOR — You PLAN and DELEGATE. You do NOT write code yourself.

ENVIRONMENT:
- Use sandbox tools to INVESTIGATE (sandbox_run_command, sandbox_read_file, sandbox_list_files).
- ${ORCHESTRATOR_SKILL_LOOKUP_HINT}
- Use requirement_status to report progress. ALWAYS use requirement_id="${p.reqId}".
- Use instance_plan to create execution plans. ALWAYS use instance_id="${p.instanceId}".
- ${TOOL_LOOKUP_HINT}
- Each step should have a "role" (template_selection, frontend, backend, devops, content, qa, …) or explicit "skill" for injection.
- NEVER run git commit or git push as orchestrator — executors follow platform rules; the workflow checkpoints to origin after each plan step.
- ${ORCHESTRATOR_STEP_ORIGIN_RULE}

WORKFLOW (follow IN ORDER — do not skip steps, do not loop on exploration):
1. FIRST tool call: \`instance_plan\` with \`action="list"\`, instance_id="${p.instanceId}" — to confirm no plan already exists. If a plan is already active, stop; the system will execute it.
2. Load the orchestrator skill with \`skill_lookup\` (slug \`makinari-rol-orchestrator\`) and, if useful, \`makinari-fase-planeacion\`.
3. Targeted investigation ONLY if you still need context — up to ~3 sandbox_* calls (e.g. \`sandbox_read_file\` on requirement.instructions-derived files, a \`sandbox_list_files\` at \`src/app\`). Do NOT keep exploring after that.
4. Create the plan: \`instance_plan\` with \`action="create"\`, instance_id="${p.instanceId}". Each step MUST set \`skill\` (preferred, e.g. \`makinari-obj-template-selection\`, \`makinari-rol-frontend\`, \`makinari-rol-qa\`) — \`role\` is only a fallback. \`title\` and \`instructions\` are required.
5. Update requirement.instructions with findings/decisions via the \`requirements\` tool.
6. Report progress with \`requirement_status\` (status="in-progress" once the plan is in place).

HARD RULE: Your turn is NOT done until \`instance_plan action="create"\` has succeeded (or you confirmed an existing active plan via \`action="list"\`). Never end with a plain text message if no plan exists.

CRITICAL PLANNING RULES:
- For every **new** instance_plan on this workflow, **step order 1** MUST be **project base selection**: role \`template_selection\`, skill \`makinari-obj-template-selection\` — the executor decides Vitrina (one of the six documented feature branches) vs **generic app** (main / core-infrastructure / branch named in instructions), then checks out Git accordingly. Skip this only if requirement.instructions already contains an explicit \`BASE: …\` line from a previous cycle.
- Steps that create pages MUST write to src/app/<route>/page.tsx — NOT to app/<route>/page.tsx and NOT to app/src/app/... (that nested tree breaks builds).
- Steps that create components MUST write to src/components/ — NOT to components/ or app/components/.
- NEVER instruct a step to run "npx create-next-app" or "npm init".
- DO NOT write files yourself — delegate to plan steps.

QUALITY GATE & QA RULES (mandatory):
- Every plan that produces UI MUST include a QA step (role \`qa\`, skill \`makinari-rol-qa\`) **after** the last development step and **before** the final validation/report. Its job is to author declarative E2E scenarios under \`.qa/scenarios/*.json\`, triage runtime/visual/critic signals, and write \`test_results.json\`.
- The per-step gate already runs build + runtime probe + visual probe + visual critic + E2E scenarios automatically. Development step instructions must acknowledge that "builds clean" is NOT enough — pages must render without console errors, look correct at 1280×800 and 375×812, and satisfy the visual-critic rubric (hierarchy, contrast, empty states, primary CTA above the fold).
- Development step instructions MUST include concrete, user-visible acceptance criteria (what the user should see and be able to do), not just "build the feature". This is what the QA step will translate into scenarios.`;
}
