'use workflow';

import {
  cleanupNestedProjectsStep,
  getActiveInstancePlanStep,
  getInstancePlanByIdStep,
  checkRecentPlansGuardStep,
  reconcilePlanStep,
  commitAndPushStep,
  postFinallyBuildStep,
  recordPostFinallyBuildFailureStep,
  getPreviewUrlStep,
} from '../shared/cron-steps';
import {
  createSandboxStep,
  stopSandboxStep,
  checkBackgroundCommandStep,
  extendRunLockStep,
  releaseRunLockStep,
} from '../shared/cron-sandbox-lifecycle-steps';
import { applyDatabaseMigrationsStep } from '../shared/step-db-migrations';
// Import directly — the 'use step' plugin forbids re-exports, so the step
// lives in its own module.
import { bootstrapRequirementSpecStep } from '../shared/bootstrap-spec-step';
import { provisionTrackingScriptStep } from '../shared/tracking-script-step';
import { ensureSourceArchiveStep } from '../shared/ensure-source-archive-step';
import {
  classifyRequirementType,
  getFlow,
  productAttemptLimits,
} from '@/lib/services/requirement-flows';
import {
  activeBacklogItemIdsFromPlanSteps,
  countPendingPlanSteps,
  feedbackRequiredBacklogItems,
  hasRunnableBacklogWork,
} from '@/lib/services/cycle-wrapup-prompt';
import { 
  getPlanExecutionGateStep,
  updatePlanStepStatusStep,
  reconnectSandboxStep,
  logCronInfrastructureEventStep,
  recordStepInfraTransientStep,
  clearStepInfrastructureStateStep,
  blockRequirementForCronInfrastructureCyclesStep,
  requestNoProgressStepAdjudicationStep,
  selectPlanStepsForExecution,
  shouldDeferNoProgressBlock,
} from '../shared/cron-execute-steps-phase';
import {
  scopeInfrastructureCircuitStep,
  scopeProductNoProgressCircuitStep,
} from '../shared/cron-blocker-scope-steps';
import { executeSingleTurnStep, type SingleTurnResult } from '../shared/single-turn-executor';
import { runGateStep } from '../shared/gate-step-executor';
import { runOrchestratorStep } from '../shared/cron-orchestrator-step';
import { validateDeliverablesStep, createFinalStatusStep } from '../shared/cron-workflow-finalize';
import { provisionPlatformKeyStep } from '../shared/platform-key-step';
import { detectAdminLoopStep } from '../shared/admin-loop-step';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';
import {
  recordRequirementBlockedStep,
  createFallbackInstancePlanStep,
  checkInstanceAndPlanStatusStep,
  getRequirementFullContextStep,
  isRequirementExecutionCurrentStep,
  updateInstanceStatusStep,
  recordCronCycleOutcomeStep,
  syncCompletedPlanBacklogStep,
} from '../shared/workflow-db-steps';
import { buildCoordinatorPromptForFlow } from './prompt';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import type { DocsDigestResult } from '../shared/docs-digest-step';
import { sleep } from 'workflow';
import type { CronCycleOutcome } from '@/lib/services/requirement-metadata-patch';
import {
  CRON_INFRASTRUCTURE_PROVENANCE,
  DEPLOYMENT_INFRASTRUCTURE_PROVENANCE,
} from '@/lib/services/cron-infrastructure-state';
import type { GitRepoKind } from '../shared/cron-commit-helpers';
import {
  finalizePlanCycleOutcome,
  selectCycleAccountingScope,
  shouldPersistCycleWorkspace,
  shouldUseLightweightCycleFinalization,
} from '../shared/plan-cycle-outcome';
import { shouldHoldNoProgressBlock } from '../shared/no-progress-adjudication';

export interface CronAppsWorkflowInput {
  reqId: string;
  title: string;
  instructions: string | null;
  type: string;
  site_id: string;
  user_id: string;
  instanceId: string;
  previousWorkContext: string;
  /** Legacy normalized sandbox kind retained in the durable workflow payload. */
  instance_type: GitRepoKind;
  /** Advisory lock id acquired by the cron route; used to release on workflow end. */
  cronLockRunId: string;
  /** Stable ordering key used by exactly-once cycle accounting. */
  cycleStartedAt: string;
  /** Rejects stale product blockers after a user resumes execution. */
  executionGeneration: number;
  /** Persisted repository binding normalized for sandbox and Vercel operations. */
  gitRepoKind?: GitRepoKind;
}

export async function runCronAppsWorkflow(input: CronAppsWorkflowInput) {
  'use workflow';

  const { reqId, title, instructions, type, site_id, user_id, instanceId, previousWorkContext, cronLockRunId, cycleStartedAt, executionGeneration } = input;
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
  let planCompleted = false;
  let latestPlanSteps: any[] | undefined;
  let previewUrl: string | null = null;
  let repoUrl: string | null = null;
  let digest: DocsDigestResult | null = null;
  let wrapUpAttempted = false;
  let wrapUpReason: string | null = null;
  let wrapUpRequiresUserFeedback = false;
  let cycleOutcome: CronCycleOutcome = 'idle';
  let preservePausedState = false;
  let hasRunnableBacklog = false;
  let attemptedPlanId: string | undefined;
  let attemptedStepId: string | undefined;
  let progressPlanId: string | undefined;
  let progressStepId: string | undefined;
  let lightweightCycleFinalization = false;
  const requirementKind = classifyRequirementType(type);
  const requirementFlow = getFlow(requirementKind);
  const gitRepoKind: GitRepoKind =
    input.gitRepoKind ??
    (requirementKind === 'automation' ? 'automation' : 'applications');
  const feedbackAttemptLimits = productAttemptLimits(requirementFlow);

  try {
  // Step 0: Check if instance or plan is paused
  let pausedCheck = await checkInstanceAndPlanStatusStep(instanceId);
  if (pausedCheck.isPaused) {
    console.log(`[CronAppsWorkflow] Instance or plan is paused. Waiting for up to 5 minutes...`);
    for (let i = 0; i < 5; i++) {
      await sleep(60000); // 1 minute
      pausedCheck = await checkInstanceAndPlanStatusStep(instanceId);
      if (!pausedCheck.isPaused) {
        console.log(`[CronAppsWorkflow] Resumed after ${i + 1} minutes.`);
        break;
      }
    }
    
    if (pausedCheck.isPaused) {
      console.log(`[CronAppsWorkflow] Still paused after 5 minutes. Ending workflow without changing the pause.`);
      cycleOutcome = 'paused';
      preservePausedState = true;
      wrapUpReason = 'The instance remained paused for five minutes, so this work cycle stopped.';
      wrapUpRequiresUserFeedback = true;
      return { reqId, branch: null, previewUrl: null, status: 'paused' as const };
    }
  }

  // Step 1: Check for active plan BEFORE creating the sandbox
  // This saves VM costs if we are in a re-plan loop cooldown or blocked state.
  const existingPlan = await getActiveInstancePlanStep(
    instanceId,
    site_id,
    reqId,
  );
  const actionableSteps = selectPlanStepsForExecution(
    Array.isArray(existingPlan?.steps) ? existingPlan.steps : [],
  );
  const hasActivePlan = !!(existingPlan && actionableSteps.length > 0);

  if (existingPlan && actionableSteps[0]) {
    const preflightGate = await getPlanExecutionGateStep(
      existingPlan.id,
      actionableSteps[0].id,
      reqId,
    );
    if (!preflightGate.runnable) {
      if (preflightGate.reason === 'infrastructure_circuit_open') {
        cycleOutcome = 'infrastructure_exhausted';
        const provenance =
          preflightGate.infrastructureProvenance ||
          (preflightGate.infrastructureKind === 'deployment'
            ? DEPLOYMENT_INFRASTRUCTURE_PROVENANCE
            : CRON_INFRASTRUCTURE_PROVENANCE);
        wrapUpRequiresUserFeedback =
          provenance !== DEPLOYMENT_INFRASTRUCTURE_PROVENANCE;
        wrapUpReason = wrapUpRequiresUserFeedback
          ? 'Infrastructure retry budget exhausted. User or operator intervention is required before execution can resume.'
          : 'Deployment infrastructure retry budget exhausted. Waiting for the correlated deployment recovery signal.';
        const blockedBacklogItemId =
          actionableSteps[0]?.metadata?.backlog_item_id ||
          actionableSteps[0]?.backlog_item_id;
        const blockResult =
          await scopeInfrastructureCircuitStep({
          requirementId: reqId,
          siteId: site_id,
          instanceId,
          planId: existingPlan.id,
          stepId: actionableSteps[0].id,
          backlogItemId:
            typeof blockedBacklogItemId === 'string'
              ? blockedBacklogItemId
              : undefined,
          expectedGeneration:
            preflightGate.infrastructureGeneration || 0,
          provenance,
          message: wrapUpReason,
          eventId:
            `${cronLockRunId}:${actionableSteps[0].id}:preflight-circuit`,
          expectedExecutionGeneration: executionGeneration,
          attemptLimits: feedbackAttemptLimits,
        });
        if (blockResult.itemIsolated) {
          cycleOutcome = 'remediation_handoff';
          wrapUpReason =
            'Infrastructure failure was isolated to the current item; independent backlog work remains runnable.';
          wrapUpRequiresUserFeedback = false;
        } else if (!blockResult.requirementBlocked) {
          cycleOutcome = 'idle';
          wrapUpReason = null;
          wrapUpRequiresUserFeedback = false;
        }
      } else if (preflightGate.reason === 'infrastructure_wait') {
        cycleOutcome = 'infrastructure_wait';
      } else if (preflightGate.reason === 'paused') {
        cycleOutcome = 'paused';
        preservePausedState = true;
      } else {
        cycleOutcome = 'idle';
      }
      wrapUpAttempted =
        preflightGate.reason !== 'infrastructure_circuit_open' ||
        !wrapUpRequiresUserFeedback;
      console.log(
        `[CronAppsWorkflow] Preflight stopped before sandbox creation for step ${actionableSteps[0].id}: ${preflightGate.reason}`,
      );
      return {
        reqId,
        branch: null,
        previewUrl: null,
        status: cycleOutcome,
      };
    }
  }

  // Fetch full requirement context up-front so it is available to both the
  // orchestrator prompt and the skip-cycle guard below.
  const reqContext = await getRequirementFullContextStep(reqId, instanceId, site_id, user_id);
  
  let isAllBacklogDone = false;
  let isOrnamentalOnly = false;
  const relevantDecisions: string[] = [];
  let hasAttemptedActiveItems = false;
  let hasRecentlyUpdatedActiveItems = false;
  let activeItems: any[] = [];
  if (reqContext.backlog?.items) {
    const { isBacklogComplete, isOrnamentalOnlyOutstanding, hasOutstandingWork } = require('@/lib/services/requirement-backlog');
    isAllBacklogDone = isBacklogComplete(reqContext.backlog.items) && !hasOutstandingWork(reqContext.backlog.items);
    isOrnamentalOnly = isOrnamentalOnlyOutstanding(reqContext.backlog.items);

    // Check for ANY active item, even if it has 0 attempts
    activeItems = reqContext.backlog.items.filter((i: any) => 
      i.status === 'in_progress' || i.status === 'needs_review' || i.status === 'pending'
    );
    // Count items with attempts > 0 as attempted
    hasAttemptedActiveItems = activeItems.some((i: any) => (i.attempts || 0) > 0);
    
    // Check if any active item was updated in the last 15 minutes
    const nowMs = Date.now();
    hasRecentlyUpdatedActiveItems = activeItems.some((i: any) => {
      const updatedMs = new Date(i.updated_at || i.created_at || 0).getTime();
      return (nowMs - updatedMs) < 15 * 60 * 1000;
    });
    
    activeItems.forEach((item: any) => {
      if (item.assumptions && item.assumptions.length > 0) {
        relevantDecisions.push(...item.assumptions.map((a: string) => `[${item.title}] ${a}`));
      }
    });

    const feedbackItems = feedbackRequiredBacklogItems(
      activeItems,
      feedbackAttemptLimits,
      {
        activeItemIds: activeBacklogItemIdsFromPlanSteps(existingPlan?.steps),
        currentPhaseId: reqContext.backlog.current_phase_id,
        hasRunnablePlanSteps: hasActivePlan,
      },
    );
    hasRunnableBacklog = hasRunnableBacklogWork(
      reqContext.backlog.items,
      feedbackAttemptLimits,
    );
    if (feedbackItems.length > 0 && !hasRunnableBacklog) {
      wrapUpRequiresUserFeedback = true;
      wrapUpReason = `Feedback is required for backlog item(s): ${feedbackItems
        .map((item: any) => `"${item.title}" (status=${item.status}, attempts=${item.attempts || 0})`)
        .join(', ')}.`;
    }
  }

  // Step 2: If no active plan, decide whether re-planning is safe.
  let recentPlansGuard: Awaited<ReturnType<typeof checkRecentPlansGuardStep>> = {
    recentCount: 0,
    latestCompletedAtMs: null,
    shouldSkipOrchestrator: false,
    shouldBlockRequirement: false,
  };
  
  if (!hasActivePlan) {
    const guardParams: Parameters<typeof checkRecentPlansGuardStep>[0] = { instanceId, siteId: site_id };
    if (isOrnamentalOnly && hasAttemptedActiveItems) {
      guardParams.blockAfter = parseInt(process.env.CRON_ORNAMENTAL_REPLAN_BLOCK_AFTER || '1', 10);
      guardParams.skipAfterMinutes = parseInt(process.env.CRON_ORNAMENTAL_REPLAN_SKIP_MIN || '30', 10);
    }
    recentPlansGuard = await checkRecentPlansGuardStep(guardParams);
    if (recentPlansGuard.reason) {
      console.log(`[CronAppsWorkflow] Recent-plans guard: ${recentPlansGuard.reason} (ornamentalOnly: ${isOrnamentalOnly}, hasAttemptedActiveItems: ${hasAttemptedActiveItems})`);
    }
  }

  if (recentPlansGuard.shouldBlockRequirement && !hasRunnableBacklog) {
    cycleOutcome = 'remediation_handoff';
    wrapUpRequiresUserFeedback = true;
    wrapUpReason = `Re-plan loop detected: ${recentPlansGuard.reason}.`;
    const rec = await recordRequirementBlockedStep({
      site_id,
      instance_id: instanceId,
      requirement_id: reqId,
      message: `Re-plan loop detected: ${recentPlansGuard.reason}. Review recent instance_plans for this requirement and re-open manually once unblocked.`,
      provenance: 'product_replan_circuit',
      event_id: `${cronLockRunId}:replan-circuit`,
      expected_execution_generation: executionGeneration,
    });
    if (!rec.ok) {
      throw new Error(
        `Failed to record re-plan-loop blocker: ${rec.error || 'unknown error'}`,
      );
    }
    // Early exit without creating a sandbox
    return { reqId, branch: null, previewUrl: null, status: 'blocked' as const };
  }

  const isFreshWork = (!hasAttemptedActiveItems || hasRecentlyUpdatedActiveItems) && activeItems.length > 0;
  const skipOrchestrator =
    hasActivePlan ||
    (
      recentPlansGuard.shouldSkipOrchestrator &&
      !isFreshWork &&
      !hasRunnableBacklog
    );

  // If the backlog is empty or fully done we still want the orchestrator to
  // run so it can either seed the initial items or finalize the requirement.
  const isBacklogEmptyOrDone = !reqContext.backlog?.items || reqContext.backlog.items.length === 0 || isAllBacklogDone;

  // Early exit if we are skipping the orchestrator AND there is no active plan.
  // This means we are in the cooldown period and there is no work to do.
  // We don't want to create a sandbox just to do nothing and push an empty commit.
  // NOTE: If the backlog is empty, we DO want to run so we can finalize the Cycle or create items.
  // If all backlog is done, we DO NOT run the orchestrator (it will just loop). We will emit the final status manually later.
  
  // NOTE: IsFreshWork is true when we have active items but NONE of them have any attempts.
  // So the first time an ornamental item is pending (0 attempts), isFreshWork = true
  // skipOrchestrator = (false && !true) = false -> runs!
  // BUT if there's a recent plan, shouldSkipOrchestrator = true
  // skipOrchestrator = (true && !true) = false -> runs!
  // Wait, if it has 1 attempt, isFreshWork = false
  // skipOrchestrator = (true && !false) = true -> skips!
  // This matches your request: we only skip if it has AT LEAST 1 attempt.

  if (skipOrchestrator && !hasActivePlan && !(!reqContext.backlog?.items || reqContext.backlog.items.length === 0)) {
    console.log(`[CronAppsWorkflow] Skipping cycle: cooling down to avoid re-plan loop. No active plan to execute. (isFreshWork: ${isFreshWork})`);
    cycleOutcome = 'scheduler_cooldown';
    if (hasAttemptedActiveItems) {
      wrapUpRequiresUserFeedback = true;
      wrapUpReason ||= 'Attempted backlog work remains, but no runnable plan is available.';
    }
    return { reqId, branch: null, previewUrl: null, status: 'in-progress' as const };
  }

  // Step 3: Create sandbox → returns serializable info
  // We only create it if we actually need to run steps, run the orchestrator,
  // or if we are skipping the orchestrator but still want to finalize the cycle
  // (e.g., to check if a Vercel preview URL is now ready).
  const created = await createSandboxStep(reqId, gitRepoKind, title, cronAudit);
  sandboxId = created.sandboxId;
  const { branchName, workDir, isNewBranch, instanceType } = created;

  if (requirementFlow.delivery.validate_deployment) {
    // Deployable flows enforce the canonical Next.js repository layout.
    const cleanup = await cleanupNestedProjectsStep(sandboxId!, cronAudit);
    sandboxId = cleanup.effectiveSandboxId;
  }

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
  const platformKeyResult = await provisionPlatformKeyStep({
    sandboxId: sandboxId!,
    requirementId: reqId,
    siteId: site_id,
    userId: user_id,
    instanceId,
    branchName: requirementFlow.delivery.validate_deployment
      ? branchName
      : undefined,
    authProvider: requirementFlow.delivery.provision_app_tenant
      ? 'supabase'
      : null,
    gitRepoKind,
  });
  const provisionedEnvKeys = platformKeyResult.injected_env_keys;

  if (requirementFlow.delivery.provision_tracking_script) {
    // Application flows expose browser telemetry through the root layout.
    await provisionTrackingScriptStep({
      sandboxId: sandboxId!,
      siteId: site_id,
      audit: cronAudit,
    });
  }

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
  // Note: reqContext is already populated above

  // Use the workflow-injected previousWorkContext from route.ts, or fallback to the one fetched from DB
  const finalPreviousWorkContext = previousWorkContext || reqContext.previousWorkContext;

  const orchestratorPrompt = buildCoordinatorPromptForFlow({
    reqId, title, type, instructions, instanceId, site_id,
    workDir, branchName, isNewBranch, 
    previousWorkContext: finalPreviousWorkContext,
    backlog: reqContext.backlog,
    recentProgress: reqContext.progress || undefined,
    relevantDecisions,
    agentBackground: reqContext.agentBackground,
    memoriesContext: reqContext.memoriesContext,
    historyContext: reqContext.historyContext,
    provisionedEnvKeys,
  });

  // Step 4: Run orchestrator (if no pending plan)
  if ((!skipOrchestrator || (!reqContext.backlog?.items || reqContext.backlog.items.length === 0)) && !isAllBacklogDone) {
    console.log(`[CronAppsWorkflow|orchestrator] PHASE 1: Running orchestrator`);
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
      instanceContext: reqContext.instanceContext,
      git_repo_kind: gitRepoKind,
      validate_deployment: requirementFlow.delivery.validate_deployment,
    });
    sandboxId = orch.effectiveSandboxId;

    // Safety net: if the orchestrator finished without creating a plan AND no
    // active plan exists yet, the cron would otherwise commit empty and flip
    // the requirement back to in-progress forever. Record an explicit blocker
    // so the next cycle sees a clear reason and operators can intervene.
    if (!orch.createdPlan) {
      const postOrchPlan = await getActiveInstancePlanStep(
        instanceId,
        site_id,
        reqId,
      );
      if (!postOrchPlan) {
        if (orch.timedOut) {
          console.warn(
            `[CronAppsWorkflow|orchestrator] Orchestrator timed out before creating instance_plan for req ${reqId} — skipping blocker to allow retry next cycle.`,
          );
        } else {
          console.warn(
            `[CronAppsWorkflow|orchestrator] Orchestrator produced no instance_plan for req ${reqId} — creating fallback plan.`,
          );
          await createFallbackInstancePlanStep({
            instanceId,
            siteId: site_id,
            userId: user_id,
            requirementId: reqId,
          });
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

  // Step 5: Execute plan steps (always re-fetch so pause/delete in the same cycle is respected)
  const activePlan = await getActiveInstancePlanStep(
    instanceId,
    site_id,
    reqId,
  );
  latestPlanSteps = activePlan?.steps;

  let smokeError: string | null = null;
  let pushResult: {
    ok: boolean;
    branch: string;
    pushed: boolean;
    commitCount: number;
  } | null = null;
  let stepsPhase: any = null;
  let infrastructureHalt = false;
  let persistWorkspaceOnInfrastructureHalt = false;
  let attemptedProductWork = false;
  let durableProductProgress = false;
  let executionPhaseCompleted = false;

  try {
    if (activePlan?.steps) {
      const allSteps = activePlan.steps as any[];
      const stepsToRun = selectPlanStepsForExecution(allSteps);
      
      let executed = 0;
      let anyStepFailed = false;
      let lastTouchedStepId: string | null = null;
      const startTime = Date.now();
      const MAX_EXECUTION_TIME_MS = 11 * 60 * 1000; // 11 minutes
      const MIN_NEXT_STEP_BUDGET_MS = 4 * 60 * 1000;
      const configuredStepsPerCycle = Number.parseInt(
        process.env.CRON_MAX_STEPS_PER_CYCLE || '4',
        10,
      );
      const MAX_STEPS_PER_CYCLE =
        Number.isFinite(configuredStepsPerCycle) && configuredStepsPerCycle > 0
          ? configuredStepsPerCycle
          : 4;

      const completedStepsBefore = allSteps.filter((s) => s.status === 'completed').length;

      outer: for (const planStep of stepsToRun) {
         let stepCompleted = false;
         let turnCount = 0;
         const MAX_TURNS = 30;
         let workingStep = planStep;
         
         while (!stepCompleted && turnCount < MAX_TURNS) {
            if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
               console.log(`[CronAppsWorkflow] Approaching Vercel timeout (${MAX_EXECUTION_TIME_MS}ms). Pausing for next cycle.`);
               break outer;
            }

            turnCount++;
            
            // Check plan gate
            const gate = await getPlanExecutionGateStep(
              activePlan.id,
              workingStep.id,
              reqId,
            );
            if (!gate.runnable) {
               console.log(`[CronAppsWorkflow] Plan execution halted (reason=${gate.reason})`);
               if (
                 gate.reason === 'infrastructure_wait' ||
                 gate.reason === 'infrastructure_circuit_open'
               ) {
                 infrastructureHalt = true;
                 cycleOutcome =
                   gate.reason === 'infrastructure_circuit_open'
                     ? 'infrastructure_exhausted'
                     : 'infrastructure_wait';
                 wrapUpAttempted = true;
               } else if (gate.reason === 'paused') {
                 cycleOutcome = 'paused';
                 preservePausedState = true;
               } else {
                 cycleOutcome = 'idle';
               }
               await logCronInfrastructureEventStep(cronAudit, {
                 event: 'cron_infra_plan_execution_halted',
                 level: 'warn',
                 message: `Plan step loop stopped — ${gate.reason}`,
                 details: { plan_id: activePlan.id, halt_reason: gate.reason },
               });
               break outer;
            }
            
            lastTouchedStepId = workingStep.id;
            attemptedProductWork = true;
            attemptedPlanId = activePlan.id;
            attemptedStepId = workingStep.id;
            
            const turnRes = await executeSingleTurnStep({
               sandboxId: sandboxId!,
               plan: activePlan,
               step: workingStep,
               requirementId: reqId,
               instanceId,
               siteId: site_id,
               userId: user_id,
               title,
               gitRepoKind,
               requirementType: type,
               validateDeployment:
                 requirementFlow.delivery.validate_deployment,
               provisionedEnvKeys,
               cycleId: cronLockRunId,
               executionEventId:
                 `${cronLockRunId}:${workingStep.id}:turn:${turnCount}`,
               executionGeneration,
            });
            
            if (turnRes.effectiveSandboxId) sandboxId = turnRes.effectiveSandboxId;
            durableProductProgress =
              durableProductProgress ||
              turnRes.durableProductProgress === true;
            if (turnRes.durableProductProgress === true) {
              progressPlanId = activePlan.id;
              progressStepId = workingStep.id;
            }
            if (typeof turnRes.infrastructureGeneration === 'number') {
              workingStep.infrastructure_generation =
                turnRes.infrastructureGeneration;
            }
            if (turnRes.concurrencyHalt) {
              infrastructureHalt = true;
              cycleOutcome = 'idle';
              break outer;
            }
            
            if (!turnRes.ok) {
               if (turnRes.transient || isSandboxGoneError(turnRes.error)) {
                 console.warn(`[CronAppsWorkflow] Step ${workingStep.order} transient infra error: ${turnRes.error}`);
                 const infra = await recordStepInfraTransientStep(
                   activePlan.id,
                   workingStep.id,
                   `${cronLockRunId}:${workingStep.id}:turn:${turnCount}:failure`,
                   turnRes.error,
                   turnRes.infrastructureWait,
                   {
                     allowRetryableFailed: workingStep.status === 'failed',
                     expectedGeneration:
                       turnRes.infrastructureGeneration ??
                       Number(workingStep.infrastructure_generation || 0),
                   },
                 );
                 infrastructureHalt = true;
                 if (
                   infra.state !== 'applied' &&
                   infra.state !== 'duplicate'
                 ) {
                   cycleOutcome = 'idle';
                   break outer;
                 }
                 cycleOutcome = infra.circuitOpen
                   ? 'infrastructure_exhausted'
                   : turnRes.infrastructureWait?.kind === 'deployment'
                     ? 'infrastructure_wait'
                     : 'infrastructure_retry';
                 if (infra.circuitOpen) {
                   const provenance =
                     turnRes.infrastructureWait?.provenance ||
                     CRON_INFRASTRUCTURE_PROVENANCE;
                   wrapUpRequiresUserFeedback =
                     provenance !== DEPLOYMENT_INFRASTRUCTURE_PROVENANCE;
                   wrapUpReason = wrapUpRequiresUserFeedback
                     ? 'Infrastructure retry budget exhausted. User or operator intervention is required before execution can resume.'
                     : 'Deployment infrastructure retry budget exhausted. Waiting for the correlated deployment recovery signal.';
                   const blockedBacklogItemId =
                     workingStep?.metadata?.backlog_item_id ||
                     workingStep?.backlog_item_id;
                   const scopedCircuit =
                     await scopeInfrastructureCircuitStep({
                       requirementId: reqId,
                       siteId: site_id,
                       instanceId,
                       planId: activePlan.id,
                       stepId: workingStep.id,
                       backlogItemId:
                         typeof blockedBacklogItemId === 'string'
                           ? blockedBacklogItemId
                           : undefined,
                       expectedGeneration:
                         infra.generation ??
                         Number(workingStep.infrastructure_generation || 0),
                       provenance,
                       message: wrapUpReason,
                       eventId:
                         `${cronLockRunId}:${workingStep.id}:turn:${turnCount}:circuit`,
                       expectedExecutionGeneration: executionGeneration,
                       retryAfter: infra.retryAt,
                       attemptLimits: feedbackAttemptLimits,
                     });
                   if (scopedCircuit.itemIsolated) {
                     cycleOutcome = 'remediation_handoff';
                     wrapUpRequiresUserFeedback = false;
                     wrapUpReason =
                       'Infrastructure failure was isolated to the current item; independent backlog work remains runnable.';
                     await logCronInfrastructureEventStep(cronAudit, {
                       event: 'cron_infra_item_isolated',
                       level: 'warn',
                       message: wrapUpReason,
                       details: {
                         plan_id: activePlan.id,
                         step_id: workingStep.id,
                         backlog_item_id: blockedBacklogItemId,
                         affected_item_ids: scopedCircuit.affectedItemIds,
                       },
                     });
                     break outer;
                   }
                   if (!scopedCircuit.requirementBlocked) {
                     cycleOutcome = 'idle';
                     wrapUpReason = null;
                     wrapUpRequiresUserFeedback = false;
                     break outer;
                   }
                   await logCronInfrastructureEventStep(cronAudit, {
                     event: 'cron_infra_circuit_open',
                     level: 'error',
                     message: `Infrastructure circuit opened for step ${workingStep.id}; automatic execution is paused pending recovery or intervention.`,
                     details: {
                       plan_id: activePlan.id,
                       step_id: workingStep.id,
                       infra_retry_count: infra.infraCount,
                       infrastructure_kind:
                         turnRes.infrastructureWait?.kind || 'gate',
                     },
                   });
                 }
                 wrapUpAttempted =
                   !infra.circuitOpen || !wrapUpRequiresUserFeedback;
                 break outer;
               } else {
                 // Step failed genuinely
                 anyStepFailed = true;
                 console.warn(`[CronAppsWorkflow] Step ${workingStep.order} turn failed: ${turnRes.error}`);
                 const clearResult = await clearStepInfrastructureStateStep(
                   activePlan.id,
                   workingStep.id,
                   `${cronLockRunId}:${workingStep.id}:turn:${turnCount}:product-failure-clear`,
                   Number(workingStep.infrastructure_generation || 0),
                 );
                 if (
                   clearResult.state !== 'applied' &&
                   !(clearResult.state === 'duplicate' && clearResult.cleared)
                 ) {
                   infrastructureHalt = true;
                   cycleOutcome = 'idle';
                   break outer;
                 }
                 if (typeof clearResult.generation === 'number') {
                   workingStep.infrastructure_generation = clearResult.generation;
                 }
                 const failureMutation = await updatePlanStepStatusStep(
                   activePlan.id,
                   workingStep.id,
                   'failed',
                   turnRes.error,
                   Number(workingStep.infrastructure_generation || 0),
                 );
                 cycleOutcome = failureMutation.persisted
                   ? 'product_failure'
                   : 'idle';
                 infrastructureHalt = !failureMutation.persisted;
                 break outer;
               }
            }

            if (turnRes.remediationScheduled) {
               const clearResult = await clearStepInfrastructureStateStep(
                 activePlan.id,
                 workingStep.id,
                 `${cronLockRunId}:${workingStep.id}:turn:${turnCount}:remediation-clear`,
                 Number(workingStep.infrastructure_generation || 0),
               );
               if (
                 clearResult.state !== 'applied' &&
                 !(clearResult.state === 'duplicate' && clearResult.cleared) &&
                 clearResult.state !== 'terminal'
               ) {
                 infrastructureHalt = true;
                 cycleOutcome = 'idle';
                 break outer;
               }
               if (typeof clearResult.generation === 'number') {
                 workingStep.infrastructure_generation = clearResult.generation;
               }
               cycleOutcome = 'remediation_handoff';
               console.log(
                 `[CronAppsWorkflow] Step ${workingStep.order} handed off to remediation work.`,
               );
               break outer;
            }
            if (turnRes.gateFailureKind === 'missing_precondition') {
               infrastructureHalt = true;
               persistWorkspaceOnInfrastructureHalt = true;
               cycleOutcome = 'infrastructure_wait';
               wrapUpReason =
                 turnRes.gateErrorExcerpt ||
                 'Origin validation is waiting for a required external precondition.';
               wrapUpRequiresUserFeedback = false;
               console.warn(
                 `[CronAppsWorkflow] Step ${workingStep.order} is waiting on an origin precondition.`,
               );
               break outer;
            }
            if (turnRes.sleepRequested && !turnRes.backgroundTask) {
               console.log(`[CronAppsWorkflow] Turn requested sleep for ${turnRes.sleepRequested}s (generic)`);
               await sleep(turnRes.sleepRequested * 1000);
            }

            if (turnRes.backgroundTask) {
               console.log(`[CronAppsWorkflow] Background task detected (PID: ${turnRes.backgroundTask.pid}). Workflow will poll until completion.`);
               let isRunning = true;
               let pollDelayMs = 2000;
               while (isRunning) {
                  // Check if we approach timeout before sleeping
                  if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
                      console.log(`[CronAppsWorkflow] Approaching Vercel timeout while waiting for background task. Pausing for next cycle.`);
                      break outer;
                  }
                  
                  await sleep(pollDelayMs);
                  
                  try {
                     const checkRes = await checkBackgroundCommandStep(
                       sandboxId!,
                       turnRes.backgroundTask.pid,
                       turnRes.backgroundTask.logFile,
                       {
                         ...cronAudit,
                         planId: activePlan.id,
                         stepId: workingStep.id,
                       },
                       workingStep.metadata?.backlog_item_id ||
                         workingStep.backlog_item_id ||
                         undefined,
                     );
                     isRunning = checkRes.isRunning;
                     if (!isRunning) {
                         console.log(`[CronAppsWorkflow] Background task completed. Output length: ${checkRes.output.length}`);
                     } else {
                         pollDelayMs = Math.min(
                           15000,
                           Math.ceil(pollDelayMs * 1.75),
                         );
                     }
                  } catch (e: unknown) {
                     console.warn(`[CronAppsWorkflow] Failed to check background command:`, e instanceof Error ? e.message : e);
                     const infra = await recordStepInfraTransientStep(
                       activePlan.id,
                       workingStep.id,
                       `${cronLockRunId}:${workingStep.id}:turn:${turnCount}:background`,
                       e instanceof Error ? e.message : String(e),
                       undefined,
                       {
                         allowRetryableFailed: workingStep.status === 'failed',
                         expectedGeneration:
                           Number(workingStep.infrastructure_generation || 0),
                       },
                     );
                     infrastructureHalt = true;
                     if (
                       infra.state !== 'applied' &&
                       infra.state !== 'duplicate'
                     ) {
                       cycleOutcome = 'idle';
                       break outer;
                     }
                     cycleOutcome = infra.circuitOpen
                       ? 'infrastructure_exhausted'
                       : 'infrastructure_retry';
                     if (infra.circuitOpen) {
                       wrapUpRequiresUserFeedback = true;
                       wrapUpReason =
                         'Infrastructure retry budget exhausted while monitoring a background command. User or operator intervention is required.';
                       const blockedBacklogItemId =
                         workingStep?.metadata?.backlog_item_id ||
                         workingStep?.backlog_item_id;
                       const scopedCircuit =
                         await scopeInfrastructureCircuitStep({
                           requirementId: reqId,
                           siteId: site_id,
                           instanceId,
                           planId: activePlan.id,
                           stepId: workingStep.id,
                           backlogItemId:
                             typeof blockedBacklogItemId === 'string'
                               ? blockedBacklogItemId
                               : undefined,
                           expectedGeneration:
                             infra.generation ??
                             Number(workingStep.infrastructure_generation || 0),
                           provenance: CRON_INFRASTRUCTURE_PROVENANCE,
                           message: wrapUpReason,
                           eventId:
                             `${cronLockRunId}:${workingStep.id}:turn:${turnCount}:background-circuit`,
                           expectedExecutionGeneration: executionGeneration,
                           retryAfter: infra.retryAt,
                           attemptLimits: feedbackAttemptLimits,
                         });
                       if (scopedCircuit.itemIsolated) {
                         cycleOutcome = 'remediation_handoff';
                         wrapUpRequiresUserFeedback = false;
                         wrapUpReason =
                           'Background infrastructure failure was isolated to the current item; independent backlog work remains runnable.';
                         await logCronInfrastructureEventStep(cronAudit, {
                           event: 'cron_infra_item_isolated',
                           level: 'warn',
                           message: wrapUpReason,
                           details: {
                             plan_id: activePlan.id,
                             step_id: workingStep.id,
                             backlog_item_id: blockedBacklogItemId,
                             affected_item_ids: scopedCircuit.affectedItemIds,
                           },
                         });
                         break outer;
                       }
                       if (!scopedCircuit.requirementBlocked) {
                         cycleOutcome = 'idle';
                         wrapUpReason = null;
                         wrapUpRequiresUserFeedback = false;
                         break outer;
                       }
                       await logCronInfrastructureEventStep(cronAudit, {
                         event: 'cron_infra_circuit_open',
                         level: 'error',
                         message: `Infrastructure circuit opened while monitoring step ${workingStep.id}.`,
                         details: {
                           plan_id: activePlan.id,
                           step_id: workingStep.id,
                           infra_retry_count: infra.infraCount,
                         },
                       });
                     }
                     wrapUpAttempted = !infra.circuitOpen;
                     break outer;
                  }
               }
            }

            if (turnRes.persistedTerminalStatus === 'completed') {
              stepCompleted = true;
              executed++;
              progressPlanId = activePlan.id;
              progressStepId = workingStep.id;
              break;
            }
            if (turnRes.persistedTerminalStatus === 'failed') {
              anyStepFailed = true;
              cycleOutcome = 'product_failure';
              break outer;
            }

            const clearResult = await clearStepInfrastructureStateStep(
              activePlan.id,
              workingStep.id,
              `${cronLockRunId}:${workingStep.id}:turn:${turnCount}:success-clear`,
              Number(workingStep.infrastructure_generation || 0),
            );
            if (
              clearResult.state !== 'applied' &&
              !(clearResult.state === 'duplicate' && clearResult.cleared)
            ) {
              infrastructureHalt = true;
              cycleOutcome = 'idle';
              break outer;
            }
            if (typeof clearResult.generation === 'number') {
              workingStep.infrastructure_generation = clearResult.generation;
            }
            
            if (turnRes.isDone) {
               if (turnRes.effectiveSandboxId) sandboxId = turnRes.effectiveSandboxId;
               
               if (turnRes.gatePassed) {
                  const completionMutation = await updatePlanStepStatusStep(
                    activePlan.id,
                    workingStep.id,
                    'completed',
                    undefined,
                    Number(workingStep.infrastructure_generation || 0),
                  );
                  stepCompleted = completionMutation.persisted;
                  if (completionMutation.persisted) {
                    executed++;
                    progressPlanId = activePlan.id;
                    progressStepId = workingStep.id;
                  }
                  if (!completionMutation.persisted) {
                    infrastructureHalt = true;
                    cycleOutcome = 'idle';
                    break outer;
                  }
               } else {
                  // Gate failed, do adaptation loop
                  anyStepFailed = true;
                  console.warn(`[CronAppsWorkflow] Step ${workingStep.order} gate failed`);
                  const failureMutation = await updatePlanStepStatusStep(
                    activePlan.id,
                    workingStep.id,
                    'failed',
                    turnRes.gateErrorExcerpt,
                    Number(workingStep.infrastructure_generation || 0),
                  );
                  cycleOutcome = failureMutation.persisted
                    ? 'product_failure'
                    : 'idle';
                  infrastructureHalt = !failureMutation.persisted;
                  
                  // For now, if the gate fails, we mark the step failed and break to let the next cron orchestrate adaptation
                  break outer;
               }
               if (stepCompleted) break;
            }
         }

         if (stepCompleted) {
            activePlan.steps = (activePlan.steps as any[]).map((candidate) =>
              candidate.id === workingStep.id
                ? { ...candidate, status: 'completed' }
                : candidate,
            );
            if (executed >= MAX_STEPS_PER_CYCLE) {
              console.log(
                `[CronAppsWorkflow] Completed ${executed} step(s); reached per-cycle cap ${MAX_STEPS_PER_CYCLE}.`,
              );
              break outer;
            }
            const remainingExecutionMs =
              MAX_EXECUTION_TIME_MS - (Date.now() - startTime);
            if (remainingExecutionMs < MIN_NEXT_STEP_BUDGET_MS) {
              console.log(
                `[CronAppsWorkflow] Completed ${executed} step(s); reserving ${MIN_NEXT_STEP_BUDGET_MS}ms instead of starting another step.`,
              );
              break outer;
            }
            continue outer;
         }
         
         if (!stepCompleted && !anyStepFailed) {
            // Max turns reached
            console.warn(`[CronAppsWorkflow] Step ${workingStep.order} reached max turns (${MAX_TURNS}) - pausing for next cycle`);
            // Do NOT fail the step, leave it in_progress so the next cycle continues
            break outer;
         }
      }
      
      stepsPhase = {
         executed,
         smokeError: null,
         anyStepFailed,
         lastTouchedStepId,
         effectiveSandboxId: sandboxId!
      };

      const reconciledStatus = await reconcilePlanStep(activePlan.id);
      planCompleted = reconciledStatus === 'completed';

      // Re-fetch the final plan to count completed steps
      const finalPlan = await getInstancePlanByIdStep(activePlan.id);
      if (Array.isArray(finalPlan?.steps)) latestPlanSteps = finalPlan.steps;

      if (planCompleted && finalPlan) {
        const syncResult = await syncCompletedPlanBacklogStep({
          requirementId: reqId,
          plan: finalPlan,
          sandboxId: sandboxId ?? undefined,
          instanceType: gitRepoKind,
          title,
          audit: cronAudit,
        });
        if (syncResult.effectiveSandboxId) {
          sandboxId = syncResult.effectiveSandboxId;
        }
      }

      const completedStepsAfter = (finalPlan?.steps as any[] || [])
        .filter((s) => s.status === 'completed').length;
      cycleOutcome = finalizePlanCycleOutcome({
        completedStepsBefore,
        completedStepsAfter,
        attemptedProductWork,
        durableProductProgress,
        infrastructureHalt,
        currentOutcome: cycleOutcome,
      });
    } else {
      console.log(`[CronAppsWorkflow] No active plan found.`);
      // If there's no active plan, but we didn't skip the cycle, it means we
      // either just finished a plan or we are finalizing a previous cycle.
      // We check the most recent plan to see if it was completed.
    if (planCompleted) {
      // If we completed a plan AND all core items are now done, we can fast-track the requirement closure
      // without waiting for the next cron cycle to wake up the orchestrator
      const { isBacklogComplete, hasOutstandingWork } = require('@/lib/services/requirement-backlog');
      const reqContextAfter = await getRequirementFullContextStep(reqId, instanceId, site_id, user_id);
      const trulyDone = isBacklogComplete(reqContextAfter.backlog?.items || []) && !hasOutstandingWork(reqContextAfter.backlog?.items || []);
      if (trulyDone) {
         console.log(`[CronAppsWorkflow] Plan completed and all backlog is done. Fast-tracking requirement to on-review.`);
           try {
             const { supabaseAdmin } = await import('@/lib/database/supabase-client');
             await supabaseAdmin.from('requirements').update({ status: 'on-review', updated_at: new Date().toISOString() }).eq('id', reqId);
             
             // Also add a requirement_status to make it visible in the UI
             await supabaseAdmin.from('requirement_status').insert({
               requirement_id: reqId,
               site_id: site_id,
               instance_id: instanceId,
               stage: 'on-review',
               message: 'Project complete (all core backlog items done)',
             });
             
           } catch (e) {
             console.warn(`[CronAppsWorkflow] Failed to fast-track requirement to on-review:`, e);
           }
        }
      }
    }
    executionPhaseCompleted = true;
  } finally {
    const anyFail = stepsPhase?.anyStepFailed ?? false;
    lightweightCycleFinalization = shouldUseLightweightCycleFinalization({
      planCompleted,
      anyStepFailed: anyFail,
      infrastructureHalt,
      cycleOutcome,
    });
    
    // Application database migrations only run on a successful app/site cycle.
    if (
      requirementFlow.delivery.apply_database_migrations &&
      executionPhaseCompleted &&
      !anyFail &&
      !infrastructureHalt
    ) {
      const dbMig = await applyDatabaseMigrationsStep(sandboxId!, reqId, instanceType, title, cronAudit);
      sandboxId = dbMig.effectiveSandboxId;
      if (dbMig.errors.length > 0) {
         lightweightCycleFinalization = false;
         console.warn(`[CronAppsWorkflow] DB Migrations had errors:`, dbMig.errors);
      } else if (dbMig.applied.length > 0) {
         console.log(`[CronAppsWorkflow] Applied ${dbMig.applied.length} DB migrations.`);
      }
    }

    if (shouldPersistCycleWorkspace({
      infrastructureHalt,
      persistWorkspaceOnInfrastructureHalt,
    })) {
      // Save product work even when a product gate failed.
      const commitMsg = anyFail
        ? `Cron cycle complete (with failures): ${title}`
        : `Cron cycle complete: ${title}`;

      const pushed = await commitAndPushStep(
        sandboxId!,
        title,
        reqId,
        commitMsg,
        cronAudit,
        gitRepoKind,
        {
          validateDeployment:
            requirementFlow.delivery.validate_deployment,
          lightweightCheckpoint: lightweightCycleFinalization,
        },
      );
      pushResult = pushed;
      cycleOutcome = finalizePlanCycleOutcome({
        completedStepsBefore: 0,
        completedStepsAfter: 0,
        attemptedProductWork,
        durableProductProgress,
        infrastructureHalt,
        currentOutcome: cycleOutcome,
      });
      if (pushed?.effectiveSandboxId) {
        sandboxId = pushed.effectiveSandboxId;
      }
    }
  }

  if (infrastructureHalt) {
    return {
      reqId,
      branch: null,
      previewUrl: null,
      status: cycleOutcome,
    };
  }

  if (
    lightweightCycleFinalization &&
    pushResult?.ok === true
  ) {
    wrapUpAttempted = true;
    return {
      reqId,
      branch: pushResult?.branch || branchName,
      previewUrl: null,
      status: 'in-progress' as const,
    };
  }

  await extendRunLockStep(reqId, cronLockRunId);

  let postFinallyBuildError: string | undefined;
  if (
    pushResult?.ok === true &&
    !(stepsPhase?.anyStepFailed) &&
    requirementFlow.delivery.validate_deployment
  ) {
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
  const { getRequirementGitBinding, resolveDefaultGitBinding } = await import('@/lib/services/requirement-git-binding');
  let binding;
  try {
    binding = await getRequirementGitBinding(reqId, gitRepoKind);
  } catch {
    binding = resolveDefaultGitBinding(gitRepoKind);
  }
  const owner = binding.org;
  const repoName = binding.repo;
  previewUrl = requirementFlow.delivery.validate_deployment
    ? await getPreviewUrlStep(owner, repoName, effectiveBranch, reqId)
    : null;

  // Step 7: Check source code
  const sourceCodeUrl = await ensureSourceArchiveStep(reqId, sandboxId);

  // Step 8: HTTP validation — also checks repo_url / branch consistency vs
  // the requirement's metadata.git (advisory unless REQUIREMENT_GIT_STRICT=true).
  repoUrl = `https://github.com/${owner}/${repoName}/tree/${effectiveBranch}`;
  const { repoOk, previewOk } = await validateDeliverablesStep({
    repoUrl,
    previewUrl: previewUrl || undefined,
    requirementId: reqId,
    audit: cronAudit,
  });

  const executionIsCurrentBeforeFinalStatus =
    await isRequirementExecutionCurrentStep(reqId, executionGeneration);
  if (!executionIsCurrentBeforeFinalStatus) {
    console.warn(
      `[CronAppsWorkflow] Skipping finalization for stale execution generation ${executionGeneration}.`,
    );
    preservePausedState = true;
    wrapUpAttempted = true;
    cycleOutcome = 'idle';
    return {
      reqId,
      branch: effectiveBranch,
      previewUrl,
      status: 'stale_execution' as const,
    };
  }

  // Step 8.5: Emit Docs Digest and Cycle Wrap-Up
  if (sandboxId) {
    const { emitDocsDigestStep } = await import('../shared/docs-digest-step');
    digest = await emitDocsDigestStep({
      sandboxId,
      siteId: site_id,
      instanceId,
      userId: user_id,
      requirementId: reqId,
      audit: cronAudit,
    });
    
    const pendingPlanSteps = countPendingPlanSteps(latestPlanSteps);
    const finalRequirementContext = await getRequirementFullContextStep(
      reqId,
      instanceId,
      site_id,
      user_id,
    );
    const finalBacklogItems = finalRequirementContext.backlog?.items || [];
    hasRunnableBacklog = hasRunnableBacklogWork(
      finalBacklogItems,
      feedbackAttemptLimits,
    );
    if (postFinallyBuildError) {
      wrapUpRequiresUserFeedback = true;
      wrapUpReason = postFinallyBuildError;
    } else {
      const finalFeedbackItems = feedbackRequiredBacklogItems(
        finalBacklogItems,
        feedbackAttemptLimits,
        {
          activeItemIds: activeBacklogItemIdsFromPlanSteps(latestPlanSteps),
          currentPhaseId: finalRequirementContext.backlog?.current_phase_id,
          hasRunnablePlanSteps: pendingPlanSteps > 0,
        },
      );
      if (!hasRunnableBacklog && finalFeedbackItems.length > 0) {
        wrapUpRequiresUserFeedback = true;
        wrapUpReason = `Feedback is required for backlog item(s): ${finalFeedbackItems
          .map((item: any) => `"${item.title}" (status=${item.status}, attempts=${item.attempts || 0})`)
          .join(', ')}.`;
      } else if (stepsPhase?.anyStepFailed && !hasRunnableBacklog) {
        wrapUpRequiresUserFeedback = true;
        wrapUpReason =
          'A confirmed product failure exhausted the current item and no independent backlog work remains runnable.';
      } else if (stepsPhase?.anyStepFailed) {
        wrapUpReason =
          'The failed item was isolated; independent backlog work remains runnable and will continue automatically.';
      }
    }

    const { emitCycleWrapUpStep } = await import('../shared/cycle-wrapup-step');
    const wrapUpResult = await emitCycleWrapUpStep({
      sandboxId,
      siteId: site_id,
      instanceId,
      userId: user_id,
      requirementId: reqId,
      title,
      instructions,
      digest,
      planCompleted,
      pendingPlanSteps,
      hasRunnableBacklogWork: hasRunnableBacklog,
      previewUrl,
      repoUrl,
      audit: cronAudit,
      forceWrapUp: wrapUpRequiresUserFeedback,
      wrapUpReason,
      requiresUserFeedback: wrapUpRequiresUserFeedback,
    });
    // Intentional skips are handled. Actual failures remain retryable in the
    // outer finally block.
    wrapUpAttempted = wrapUpResult.outcome !== 'failed';

    const { emitSyncDocsToBacklogStep } = await import('../shared/sync-docs-to-backlog-step');
    await emitSyncDocsToBacklogStep({
      sandboxId,
      siteId: site_id,
      instanceId,
      userId: user_id,
      requirementId: reqId,
      digest,
      audit: cronAudit,
    });
  }

  // Step 9: Final status — all gates must pass (including smoke test)
  const smokeOk = !smokeError;
  const finalStatusResult = await createFinalStatusStep({
    site_id, instanceId, reqId, sandboxId: sandboxId || undefined,
    repoUrl,
    previewUrl: previewUrl || undefined,
    sourceCodeUrl: sourceCodeUrl || undefined,
    didPush,
    planCompleted,
    repoOk,
    previewOk,
    smokeError: smokeError || undefined,
    postFinallyBuildError,
    flowKind: requirementKind,
    audit: cronAudit,
    expectedExecutionGeneration: executionGeneration,
    cycleId: cronLockRunId,
  });
  if (finalStatusResult.state === 'stale') {
    preservePausedState = true;
    wrapUpAttempted = true;
    cycleOutcome = 'idle';
    return {
      reqId,
      branch: effectiveBranch,
      previewUrl,
      status: 'stale_execution' as const,
    };
  }
  const finalStatus = finalStatusResult.effectiveStatus;

  // Sandbox stop happens in the outer `finally` — never in the happy path.
  // Keeping a single exit point guarantees we never leak a VM even when a
  // late step (validate/final-status/preview) throws.
  return { reqId, branch: effectiveBranch, previewUrl, status: finalStatus };
  } catch (e: any) {
    console.error(`[CronAppsWorkflow] 🚨 CRITICAL ERROR in workflow for req ${reqId}:`, e);
    if (
      cycleOutcome !== 'progress' &&
      cycleOutcome !== 'product_failure' &&
      cycleOutcome !== 'product_no_progress'
    ) {
      cycleOutcome = 'infrastructure_retry';
    }
    wrapUpAttempted = false;
    wrapUpRequiresUserFeedback = true;
    wrapUpReason = `The work cycle stopped because of an error: ${e?.message || String(e)}`;
    // Let the finally block handle the sandbox stop
    throw e;
  } finally {
    let executionIsCurrent = false;
    try {
      executionIsCurrent = await isRequirementExecutionCurrentStep(
        reqId,
        executionGeneration,
      );
    } catch (generationError: unknown) {
      console.warn(
        '[CronAppsWorkflow] Failed to validate execution generation:',
        generationError instanceof Error
          ? generationError.message
          : generationError,
      );
    }
    if (!executionIsCurrent) {
      wrapUpAttempted = true;
      preservePausedState = true;
      cycleOutcome = 'idle';
    }
    if (!wrapUpAttempted) {
      try {
        const { emitCycleWrapUpStep } = await import('../shared/cycle-wrapup-step');
        await emitCycleWrapUpStep({
          sandboxId: sandboxId || undefined,
          siteId: site_id,
          instanceId,
          userId: user_id,
          requirementId: reqId,
          title,
          instructions,
          digest,
          planCompleted,
          pendingPlanSteps: countPendingPlanSteps(latestPlanSteps),
          hasRunnableBacklogWork: hasRunnableBacklog,
          previewUrl,
          repoUrl,
          audit: cronAudit,
          forceWrapUp: wrapUpRequiresUserFeedback,
          wrapUpReason: wrapUpReason || 'The work cycle ended before the normal wrap-up stage.',
          requiresUserFeedback: wrapUpRequiresUserFeedback,
        });
      } catch (wrapUpError: unknown) {
        console.warn(
          '[CronAppsWorkflow] Final wrap-up failed:',
          wrapUpError instanceof Error ? wrapUpError.message : wrapUpError,
        );
      }
    }

    if (instanceId && !preservePausedState) {
      try {
        await updateInstanceStatusStep(instanceId, 'pending');
      } catch (e: unknown) {
        console.warn('[CronAppsWorkflow] Failed to reset instance status to pending:', e);
      }
    }
    
    if (sandboxId && executionIsCurrent) {
      try {
        await stopSandboxStep(sandboxId, cronAudit);
      } catch (e: unknown) {
        console.warn(
          '[CronAppsWorkflow] stopSandboxStep threw in finally:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    const accountingScope = selectCycleAccountingScope({
      outcome: cycleOutcome,
      attemptedPlanId,
      attemptedStepId,
      progressPlanId,
      progressStepId,
    });
    const accounting = await recordCronCycleOutcomeStep({
      requirementId: reqId,
      cycleId: cronLockRunId,
      cycleStartedAt,
      outcome: cycleOutcome,
      expectedExecutionGeneration: executionGeneration,
      runnerInstanceId: instanceId,
      planId: accountingScope.planId,
      stepId: accountingScope.stepId,
    });
    if (
      accounting.is_latest &&
      accounting.recorded_outcome === 'product_no_progress' &&
      accounting.no_progress_cycles === 2
    ) {
      const recoveryPlan = attemptedPlanId
        ? await getInstancePlanByIdStep(attemptedPlanId)
        : null;
      const recoveryStep = Array.isArray(recoveryPlan?.steps)
        ? recoveryPlan.steps.find((step: any) => step.id === attemptedStepId)
        : undefined;
      if (recoveryPlan && recoveryStep) {
        try {
          const request = await requestNoProgressStepAdjudicationStep({
            planId: recoveryPlan.id,
            stepId: recoveryStep.id,
            expectedGeneration: Number(
              recoveryStep.infrastructure_generation || 0,
            ),
            expectedExecutionGeneration: executionGeneration,
            cycleId: cronLockRunId,
            persistedMetadata: recoveryStep.metadata,
          });
          if (request.persisted) {
            await logCronInfrastructureEventStep(cronAudit, {
              event: 'cron_product_no_progress_adjudication_requested',
              level: 'warn',
              message:
                `Step ${recoveryStep.id} made no terminal progress for two cycles. ` +
                'The next execution will skip free-form work and run the existing technical gate and final Judge directly.',
              details: {
                plan_id: recoveryPlan.id,
                step_id: recoveryStep.id,
                no_progress_cycles: accounting.no_progress_cycles,
                infrastructure_generation: request.generation,
              },
            });
          }
        } catch (error: unknown) {
          console.warn(
            '[CronAppsWorkflow] Failed to request no-progress adjudication:',
            error instanceof Error ? error.message : error,
          );
        }
      }
    } else if (
      accounting.is_latest &&
      accounting.recorded_outcome === 'product_no_progress' &&
      accounting.no_progress_cycles >= 3
    ) {
      // Re-read after accounting to avoid blocking a plan completed by a
      // concurrent assistant or webhook between reconciliation and teardown.
      const stillActivePlan = attemptedPlanId
        ? await getInstancePlanByIdStep(attemptedPlanId)
        : null;
      const stillActiveStep = Array.isArray(stillActivePlan?.steps)
        ? stillActivePlan.steps.find((step: any) =>
            step.id === attemptedStepId &&
            ['pending', 'in_progress', 'failed'].includes(step.status))
        : undefined;
      if (stillActivePlan && stillActiveStep) {
        const message =
          `The plan failed to complete a step after a bounded no-progress adjudication ` +
          `(${accounting.no_progress_cycles} accepted no-progress cycles since the last completed step). ` +
          'Circuit breaker triggered to avoid an infinite loop.';
        const adjudication =
          stillActiveStep?.metadata?.no_progress_adjudication;
        const adjudicationState =
          adjudication?.execution_generation === executionGeneration
            ? adjudication.state
            : undefined;
        let blockerDeferred = false;
        if (
          stillActiveStep &&
          shouldHoldNoProgressBlock(adjudicationState)
        ) {
          if (adjudicationState === 'requested') {
            blockerDeferred = true;
          } else {
            try {
              const request = await requestNoProgressStepAdjudicationStep({
                planId: stillActivePlan.id,
                stepId: stillActiveStep.id,
                expectedGeneration: Number(
                  stillActiveStep.infrastructure_generation || 0,
                ),
                expectedExecutionGeneration: executionGeneration,
                cycleId: cronLockRunId,
                persistedMetadata: stillActiveStep.metadata,
              });
              blockerDeferred = shouldDeferNoProgressBlock(request);
            } catch (error: unknown) {
              console.warn(
                '[CronAppsWorkflow] Final no-progress adjudication request failed:',
                error instanceof Error ? error.message : error,
              );
            }
          }
          if (blockerDeferred) {
            console.warn(
              '[CronAppsWorkflow] Deferring the no-progress blocker until the requested adjudication completes.',
            );
          }
        }
        const backlogItemId =
          stillActiveStep?.metadata?.backlog_item_id ||
          stillActiveStep?.backlog_item_id;
        if (!blockerDeferred) {
          const scopedCircuit =
            await scopeProductNoProgressCircuitStep({
              requirementId: reqId,
              siteId: site_id,
              instanceId,
              planId: stillActivePlan.id,
              stepId: stillActiveStep.id,
              backlogItemId:
                typeof backlogItemId === 'string'
                  ? backlogItemId
                  : undefined,
              expectedStepGeneration: Number(
                stillActiveStep.infrastructure_generation || 0,
              ),
              cycleId: cronLockRunId,
              minimumFailures: 3,
              message,
              expectedExecutionGeneration: executionGeneration,
              attemptLimits: feedbackAttemptLimits,
            });
          if (scopedCircuit.itemIsolated) {
            await logCronInfrastructureEventStep(cronAudit, {
              event: 'cron_product_no_progress_item_isolated',
              level: 'warn',
              message:
                `Isolated backlog item ${backlogItemId}; independent work remains runnable.`,
              details: {
                plan_id: stillActivePlan.id,
                step_id: stillActiveStep.id,
                backlog_item_id: backlogItemId,
                affected_item_ids: scopedCircuit.affectedItemIds,
              },
            });
          } else if (scopedCircuit.requirementBlocked) {
            console.warn(`[CronAppsWorkflow] ${message}`);
          }
        }
      } else {
        console.log(
          '[CronAppsWorkflow] Skipping no-progress blocker because no active runnable step remains.',
        );
      }
    } else if (
      accounting.is_latest &&
      accounting.recorded_outcome === 'infrastructure_retry' &&
      accounting.infrastructure_failure_cycles >= 4
    ) {
      const message =
        `Infrastructure persistence failed for ${accounting.infrastructure_failure_cycles} consecutive retry attempts without a successful remediation handoff. Automatic execution is blocked pending operator intervention.`;
      console.warn(`[CronAppsWorkflow] ${message}`);
      await blockRequirementForCronInfrastructureCyclesStep({
        requirementId: reqId,
        siteId: site_id,
        instanceId,
        cycleId: cronLockRunId,
        minimumFailures: 4,
        message,
        expectedExecutionGeneration: executionGeneration,
      });
    }
    await releaseRunLockStep(reqId, cronLockRunId);
  }
}

