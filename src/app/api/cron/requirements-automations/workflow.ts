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
  checkRecentPlansGuardStep,
  reconcilePlanStep,
  commitAndPushStep,
  postFinallyBuildStep,
  recordPostFinallyBuildFailureStep,
  getPreviewUrlStep,
  checkSourceCodeStep,
  stopSandboxStep,
  extendRunLockStep,
  releaseRunLockStep,
} from '../shared/cron-steps';
import { executeStepsPhaseStep, type ExecuteStepsPhaseResult } from '../shared/cron-execute-steps-phase';
import { runOrchestratorStep } from '../shared/cron-orchestrator-step';
import { validateDeliverablesStep, createFinalStatusStep } from '../shared/cron-workflow-finalize';
import { recordRequirementBlockedStep } from '../shared/workflow-db-steps';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

export interface CronAutoWorkflowInput {
  reqId: string;
  title: string;
  instructions: string | null;
  type: string;
  site_id: string;
  user_id: string;
  instanceId: string;
  previousWorkContext: string;
  /** Advisory lock id acquired by the cron route; used to release on workflow end. */
  cronLockRunId?: string;
}

export async function runCronAutoWorkflow(input: CronAutoWorkflowInput) {
  'use workflow';

  const { reqId, title, instructions, type, site_id, user_id, instanceId, previousWorkContext, cronLockRunId } = input;
  console.log(`[CronAutoWorkflow] Starting for req ${reqId}: ${title}`);

  const cronAudit: CronAuditContext = {
    instanceId,
    siteId: site_id,
    userId: user_id,
    requirementId: reqId,
  };

  // Hoisted so the `finally` can always stop the latest VM even when a step
  // throws. Without this, any exception between create and the happy-path
  // stop leaks the sandbox: it keeps billing memory until Vercel kills it on
  // timeout. Every step that may reprovision the VM updates this via
  // `effectiveSandboxId`.
  let sandboxId: string | null = null;

  try {
  // Step 1: Create sandbox (automation repo)
  const created = await createSandboxStep(reqId, 'automation', title, cronAudit);
  sandboxId = created.sandboxId;
  const { branchName, workDir, isNewBranch } = created;

  // Step 1b: Remove any nested project directories left by previous agent cycles
  const cleanup = await cleanupNestedProjectsStep(sandboxId, cronAudit);
  sandboxId = cleanup.effectiveSandboxId;

  const orchestratorPrompt = `You are an automation runner inside a Vercel Sandbox.

${SANDBOX_REPO_ROOT_INVARIANT}

WORKSPACE:
- ${workDir} is the GIT REPOSITORY ROOT on branch "${branchName}".
- All project files live at this root. Do NOT create nested project directories.
${isNewBranch ? '- NEW branch — no prior code.' : '- Existing branch — review current state before planning.'}

AUTOMATION: ${reqId} — ${title}
Instructions: ${instructions || 'None'}
instance_id: ${instanceId} | site_id: ${site_id}
${previousWorkContext}
INSTRUCTIONS AS LIVING README:
requirement.instructions is the single source of truth. Update it every cycle.

YOUR ROLE: ORCHESTRATOR — PLAN and DELEGATE. Do NOT write code.
- ${ORCHESTRATOR_SKILL_LOOKUP_HINT}
- Use sandbox tools to INVESTIGATE (sandbox_list_files path=".", sandbox_read_file).
- Use instance_plan to create steps (each with role, title, instructions, expected_output, order). BREAK DOWN the automation into specific, actionable execution steps (e.g., 1. investigate/setup, 2. core logic, 3. tests). Do NOT just copy the item title into a single step.
- Automations MUST support ?mode=test and ?mode=prod.
- NEVER run git commit or git push as orchestrator — the workflow checkpoints to origin after each plan step.
- ${ORCHESTRATOR_STEP_ORIGIN_RULE}
- ${TOOL_LOOKUP_HINT}

CRITICAL EXECUTION RULES:
1. ALWAYS THINK OUT LOUD: You MUST explain your reasoning and plan inside the \`thought_process\` parameter of every tool call.
2. MAXIMIZE PARALLELISM: If you need to read multiple files, list multiple directories, or run independent commands, you MUST call multiple tools in parallel in a single response. Do not do things sequentially if they can be batched.
3. AVOID LOOPS: If you find yourself reading the same files or running the same commands without making progress, STOP. Re-evaluate your approach and use a different tool (like sandbox_code_search instead of reading files blindly).`;

  // Step 2: Check for active plan
  const existingPlan = await getActiveInstancePlanStep(instanceId, site_id);
  const actionableSteps = existingPlan?.steps
    ? (existingPlan.steps as any[]).filter((s: any) =>
        s.status === 'pending' || s.status === 'in_progress' || (s.status === 'failed' && (s.retry_count ?? 0) < 2))
    : [];
  const hasActivePlan = !!(existingPlan && actionableSteps.length > 0);

  // Step 2b: Recent-plan guard — same rationale as requirements-apps: after
  // switching to Gemini + tool_lookup the orchestrator was re-planning every
  // cycle because previous plans closed as `completed` while the requirement
  // stayed in-progress. Break the loop by skipping (or blocking) instead of
  // creating duplicate plans.
  let recentPlansGuard: Awaited<ReturnType<typeof checkRecentPlansGuardStep>> = {
    recentCount: 0,
    latestCompletedAtMs: null,
    shouldSkipOrchestrator: false,
    shouldBlockRequirement: false,
  };
  if (!hasActivePlan) {
    recentPlansGuard = await checkRecentPlansGuardStep({ instanceId, siteId: site_id });
    if (recentPlansGuard.reason) {
      console.log(`[CronAutoWorkflow] Recent-plans guard: ${recentPlansGuard.reason}`);
    }
  }

  if (recentPlansGuard.shouldBlockRequirement) {
    const rec = await recordRequirementBlockedStep({
      site_id,
      instance_id: instanceId,
      requirement_id: reqId,
      message: `Re-plan loop detected on automation: ${recentPlansGuard.reason}. Review recent instance_plans for this requirement and re-open manually once unblocked.`,
    });
    if (!rec.ok) {
      console.error(`[CronAutoWorkflow] Failed to record re-plan-loop blocker: ${rec.error}`);
    }
    // Let the outer `finally` stop the sandbox — single exit point.
    return { reqId, branch: branchName, previewUrl: null, status: 'blocked' as const };
  }

  const skipOrchestrator = hasActivePlan || recentPlansGuard.shouldSkipOrchestrator;

  // Step 3: Run orchestrator (if needed)
  if (!skipOrchestrator) {
    console.log(`[CronAutoWorkflow|orchestrator] PHASE 1: Orchestrator`);
    const prompt = isNewBranch
      ? `Process automation "${title}". Investigate, then create an instance_plan.`
      : `Continue "${title}". All previous steps done — create a NEW plan.`;

    const orch = await runOrchestratorStep({
      sandboxId,
      reqId,
      requirementType: type,
      orchestratorPrompt,
      instanceId,
      site_id,
      user_id,
      initialMessage: prompt,
      git_repo_kind: 'automation',
      requirementTitle: title,
    });
    sandboxId = orch.effectiveSandboxId;

    // Safety net: same reasoning as requirements-apps — if the orchestrator
    // produced no plan and no plan exists, flag the requirement as blocked so
    // the next cycle has a clear signal instead of silently looping.
    if (!orch.createdPlan) {
      const postOrchPlan = await getActiveInstancePlanStep(instanceId, site_id);
      if (!postOrchPlan) {
          console.warn(
            `[CronAutoWorkflow|orchestrator] Orchestrator produced no instance_plan for req ${reqId} — recording blocker status.`,
          );
        const rec = await recordRequirementBlockedStep({
          site_id,
          instance_id: instanceId,
          requirement_id: reqId,
          message:
            'Orchestrator finished without producing an instance_plan (automation workflow). Likely causes: tool schema rejection, model tool-call loop, or missing skills. Next cycle will retry; escalate if this repeats.',
        });
        if (!rec.ok) {
          console.error(`[CronAutoWorkflow|orchestrator] Failed to record orchestrator-no-plan blocker: ${rec.error}`);
        }
      }
    }
  } else if (hasActivePlan) {
    console.log(`[CronAutoWorkflow] SKIP ORCHESTRATOR — ${actionableSteps.length} actionable step(s)`);
  } else {
    console.log(
      `[CronAutoWorkflow] SKIP ORCHESTRATOR — recent plan activity for instance ${instanceId}; not re-planning this cycle.`,
    );
  }

  await extendRunLockStep(reqId, cronLockRunId);

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
        git_repo_kind: 'automation',
      });
      smokeError = stepsPhase?.smokeError ?? null;
      if (stepsPhase?.effectiveSandboxId) {
        sandboxId = stepsPhase.effectiveSandboxId;
      }
      const reconciledStatus = await reconcilePlanStep(activePlan.id);
      planCompleted = reconciledStatus === 'completed';
    }
  } finally {
    const anyFail = stepsPhase?.anyStepFailed ?? false;
    if (!anyFail) {
      const pushed = await commitAndPushStep(sandboxId, title, reqId, undefined, cronAudit, 'automation');
      pushResult = pushed;
      if (pushed?.effectiveSandboxId) {
        sandboxId = pushed.effectiveSandboxId;
      }
    } else {
      console.log(
        '[CronAutoWorkflow] Skipping commitAndPushStep — anyStepFailed (policy: no forced platform push)',
      );
      pushResult = { branch: branchName, pushed: false, commitCount: 0 };
    }
  }

  await extendRunLockStep(reqId, cronLockRunId);

  let postFinallyBuildError: string | undefined;
  if (pushResult && !(stepsPhase?.anyStepFailed)) {
    const pf = await postFinallyBuildStep(sandboxId, cronAudit, {
      requirementId: reqId,
      title,
      instanceType: 'automation',
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

  // Step 6: Preview + source code — resolve the automation repo from the
  // requirement's persisted git binding (metadata.git) with env fallback.
  const { getRequirementGitBinding, resolveDefaultGitBinding } = await import('@/lib/services/requirement-git-binding');
  let binding;
  try {
    binding = await getRequirementGitBinding(reqId, 'automation');
  } catch {
    binding = resolveDefaultGitBinding('automation');
  }
  const gitOrg = binding.org;
  const autoRepo = binding.repo;
  const previewUrl = await getPreviewUrlStep(gitOrg, autoRepo, effectiveBranch, reqId);
  const sourceCodeUrl = await checkSourceCodeStep(reqId);

  // Step 7: HTTP validation — also checks repo_url / branch consistency vs
  // the requirement's metadata.git (advisory unless REQUIREMENT_GIT_STRICT=true).
  const repoUrl = `https://github.com/${gitOrg}/${autoRepo}/tree/${effectiveBranch}`;
  const { repoOk, previewOk } = await validateDeliverablesStep({
    repoUrl,
    previewUrl: previewUrl || undefined,
    requirementId: reqId,
    audit: cronAudit,
  });

  // Step 8: Final status — all gates must pass (including smoke test)
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

  // Sandbox stop happens in the outer `finally` — never in the happy path.
  return { reqId, branch: effectiveBranch, previewUrl, status: finalStatus };
  } finally {
    if (sandboxId) {
      try {
        await stopSandboxStep(sandboxId, cronAudit);
      } catch (e: unknown) {
        console.warn(
          '[CronAutoWorkflow] stopSandboxStep threw in finally:',
          e instanceof Error ? e.message : e,
        );
      }
    }
    await releaseRunLockStep(reqId, cronLockRunId);
  }
}
