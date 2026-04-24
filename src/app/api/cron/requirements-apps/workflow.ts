'use workflow';

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
// Import directly — the 'use step' plugin forbids re-exports, so the step
// lives in its own module.
import { bootstrapRequirementSpecStep } from '../shared/bootstrap-spec-step';
import { executeStepsPhaseStep, type ExecuteStepsPhaseResult } from '../shared/cron-execute-steps-phase';
import { runOrchestratorStep } from '../shared/cron-orchestrator-step';
import { validateDeliverablesStep, createFinalStatusStep } from '../shared/cron-workflow-finalize';
import { provisionPlatformKeyStep } from '../shared/platform-key-step';
import { detectAdminLoopStep } from '../shared/admin-loop-step';
import {
  getBacklogSnapshotStep,
  recordRequirementBlockedStep,
} from '../shared/workflow-db-steps';
import { buildCoordinatorPromptForFlow } from './prompt';
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

  // Hoisted so the `finally` can always stop the latest VM even when a step
  // throws. Without this, any exception between create and the happy-path
  // stop leaks the sandbox: it keeps billing memory until Vercel kills it on
  // timeout (observed: 280 creates/day vs ~1 stop/day in instance_logs).
  // Every step that may reprovision the VM updates this via `effectiveSandboxId`.
  let sandboxId: string | null = null;

  try {
  // Step 1: Create sandbox → returns serializable info
  const created = await createSandboxStep(reqId, type, title, cronAudit);
  sandboxId = created.sandboxId;
  const { branchName, workDir, isNewBranch, instanceType } = created;

  // Step 1b: Remove any nested project directories left by previous agent cycles
  const cleanup = await cleanupNestedProjectsStep(sandboxId!, cronAudit);
  sandboxId = cleanup.effectiveSandboxId;

  // Step 1b.1: Make sure `requirement.spec.md` exists on the branch before
  // the coordinator runs. The orchestrator prompt asks the model to derive
  // backlog items from this file; when it does not exist (fresh branch, no
  // commit yet) the model loops on failed `sandbox_read_file` calls and
  // never reaches `instance_plan action='create'`. Idempotent — never
  // overwrites a spec that is already on disk.
  try {
    await bootstrapRequirementSpecStep({
      sandboxId: sandboxId!,
      requirementId: reqId,
      audit: cronAudit,
    });
  } catch (e: unknown) {
    console.warn(
      '[CronAppsWorkflow] bootstrap requirement.spec.md failed (non-fatal):',
      e instanceof Error ? e.message : e,
    );
  }

  // Step 1c: Provision the Uncodie Platform API key (test-only) for this
  // requirement and inject it into the sandbox `.env.local` so the generated
  // app can call `/api/platform/*` via the SDK without ever holding raw
  // service credentials. Idempotent: reuses any active key already linked to
  // the remote_instance.
  await provisionPlatformKeyStep({
    sandboxId: sandboxId!,
    requirementId: reqId,
    siteId: site_id,
    userId: user_id,
    instanceId,
  });

  // Step 1d: Run the admin-loop detector against the recent git history. We
  // only log the verdict here; downgrade-on-next-cycle is enforced inside
  // the orchestrator prompt builder (Phase 8) which reads this signal from
  // the metadata audit trail. Treating it as an FYI early avoids breaking
  // workflows that have not yet wired the action.
  try {
    const adminLoop = await detectAdminLoopStep({ sandboxId: sandboxId! });
    if (adminLoop.triggered) {
      console.warn(`[CronAppsWorkflow] ${adminLoop.reason}`);
    }
  } catch (e: unknown) {
    console.warn('[CronAppsWorkflow] admin-loop probe failed:', e instanceof Error ? e.message : e);
  }

  // Pulled via a durable step because the workflow VM forbids direct `fetch`.
  // The step swallows transient errors and returns `backlog: null`, which the
  // prompt builder already handles as "empty backlog" guidance.
  const backlogSnap = await getBacklogSnapshotStep(reqId);
  if (backlogSnap.error) {
    console.warn(`[CronAppsWorkflow] backlog snapshot unavailable: ${backlogSnap.error}`);
  }
  const backlogSnapshot = backlogSnap.backlog;

  const orchestratorPrompt = buildCoordinatorPromptForFlow({
    reqId, title, type, instructions, instanceId, site_id,
    workDir, branchName, isNewBranch, previousWorkContext,
    backlog: backlogSnapshot,
  });

  // Step 2: Check for active plan
  const existingPlan = await getActiveInstancePlanStep(instanceId, site_id);
  const actionableSteps = existingPlan?.steps
    ? (existingPlan.steps as any[]).filter((s: any) =>
        s.status === 'pending' || s.status === 'in_progress' || (s.status === 'failed' && (s.retry_count ?? 0) < 2))
    : [];
  const hasActivePlan = !!(existingPlan && actionableSteps.length > 0);

  // Step 2b: If no active plan, decide whether re-planning is safe.
  // When the orchestrator has already produced one (or several) plans in the
  // recent past for this instance and the requirement is still in-progress,
  // a new plan would just duplicate work and feed the re-plan loop we saw
  // after switching to Gemini. Block or skip instead.
  let recentPlansGuard: Awaited<ReturnType<typeof checkRecentPlansGuardStep>> = {
    recentCount: 0,
    latestCompletedAtMs: null,
    shouldSkipOrchestrator: false,
    shouldBlockRequirement: false,
  };
  if (!hasActivePlan) {
    recentPlansGuard = await checkRecentPlansGuardStep({ instanceId, siteId: site_id });
    if (recentPlansGuard.reason) {
      console.log(`[CronAppsWorkflow] Recent-plans guard: ${recentPlansGuard.reason}`);
    }
  }

  if (recentPlansGuard.shouldBlockRequirement) {
    const rec = await recordRequirementBlockedStep({
      site_id,
      instance_id: instanceId,
      requirement_id: reqId,
      message: `Re-plan loop detected: ${recentPlansGuard.reason}. Review recent instance_plans for this requirement and re-open manually once unblocked.`,
    });
    if (!rec.ok) {
      console.error(`[CronAppsWorkflow] Failed to record re-plan-loop blocker: ${rec.error}`);
    }
    // Let the outer `finally` stop the sandbox — avoids duplicate stop calls
    // and keeps the cleanup path in one place.
    return { reqId, branch: branchName, previewUrl: null, status: 'blocked' as const };
  }

  const skipOrchestrator = hasActivePlan || recentPlansGuard.shouldSkipOrchestrator;

  // Step 3: Run orchestrator (if no pending plan)
  if (!skipOrchestrator) {
    console.log(`[CronAppsWorkflow] PHASE 1: Running orchestrator`);
    const prompt = isNewBranch
      ? `Process requirement "${title}". Read instructions, investigate, then create an instance_plan with actionable steps (each with a role).`
      : `Continue "${title}". All previous steps done — create a NEW plan for the next iteration.`;

    const orch = await runOrchestratorStep({
      sandboxId: sandboxId!,
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
        if (orch.timedOut) {
          console.warn(
            `[CronAppsWorkflow] Orchestrator timed out before creating instance_plan for req ${reqId} — skipping blocker to allow retry next cycle.`,
          );
        } else {
          console.warn(
            `[CronAppsWorkflow] Orchestrator produced no instance_plan for req ${reqId} — recording blocker status.`,
          );
          const rec = await recordRequirementBlockedStep({
            site_id,
            instance_id: instanceId,
            requirement_id: reqId,
            message:
              'Orchestrator finished without producing an instance_plan. Likely causes: tool schema rejection, model tool-call loop, or missing skills. Next cycle will retry; escalate to a human if this repeats.',
          });
          if (!rec.ok) {
            console.error(`[CronAppsWorkflow] Failed to record orchestrator-no-plan blocker: ${rec.error}`);
          }
        }
      }
    }
  } else if (hasActivePlan) {
    console.log(`[CronAppsWorkflow] SKIP ORCHESTRATOR — plan "${existingPlan!.title}" has ${actionableSteps.length} actionable step(s)`);
  } else {
    console.log(
      `[CronAppsWorkflow] SKIP ORCHESTRATOR — recent plan activity for instance ${instanceId}; not re-planning this cycle.`,
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
        sandboxId: sandboxId!,
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
      const pushed = await commitAndPushStep(sandboxId!, title, reqId, undefined, cronAudit, 'applications');
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

  await extendRunLockStep(reqId, cronLockRunId);

  let postFinallyBuildError: string | undefined;
  if (pushResult && !(stepsPhase?.anyStepFailed)) {
    const pf = await postFinallyBuildStep(sandboxId!, cronAudit, {
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
  const previewUrl = await getPreviewUrlStep(owner, repoName, effectiveBranch, reqId);

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

  // Sandbox stop happens in the outer `finally` — never in the happy path.
  // Keeping a single exit point guarantees we never leak a VM even when a
  // late step (validate/final-status/preview) throws.
  return { reqId, branch: effectiveBranch, previewUrl, status: finalStatus };
  } catch (e: any) {
    console.error(`[CronAppsWorkflow] 🚨 CRITICAL ERROR in workflow for req ${reqId}:`, e);
    // Let the finally block handle the sandbox stop
    throw e;
  } finally {
    if (sandboxId) {
      try {
        await stopSandboxStep(sandboxId, cronAudit);
      } catch (e: unknown) {
        console.warn(
          '[CronAppsWorkflow] stopSandboxStep threw in finally:',
          e instanceof Error ? e.message : e,
        );
      }
    }
    await releaseRunLockStep(reqId, cronLockRunId);
  }
}

