'use step';

import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import {
  buildCycleWrapUpSystemPrompt,
  shouldRunCycleWrapUp,
  shouldSkipWrapUpForPendingSteps,
} from '@/lib/services/cycle-wrapup-prompt';
import { loadLatestDocsDigestFromLogs } from '@/lib/services/docs-cycle-digest';
// Import from lib/tools via assistantProtocol that only pulls requirement-status-core
// (no next/server). Do NOT import system_notification here — its route pulls next/server
// and breaks the Vercel Workflow bundler.
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';
import { createRequirementStatusCore } from '@/lib/tools/requirement-status-core';
import type { DocsDigestResult } from './docs-digest-step';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import {
  hasRetryablePlanFailure,
  hasRunnableRequirementPlan,
} from './cycle-wrapup-retry-policy';
import type { CycleRecoveryDisposition } from './cycle-recovery-policy';
import { assertCronExecutionOwnership } from './cron-execution-ownership';
import { loadCycleInterventionState } from '@/lib/services/cycle-wrapup-state';
import { createHarnessDiagnosticTools, refreshHarnessToolManifest } from '@/lib/services/harness-diagnostics/tools';
import { ensureCycleTechnicalEscalation } from '@/lib/services/harness-diagnostics/cycle-escalation';
import type { MigrationSecurityReview } from '@/lib/services/apps-platform/migration-security-review';

const STEP_FAILURE_REASON_PREFIX = 'One or more execution steps failed';
const AUTOMATED_RECOVERY_ERROR = /^(?:Build failed|Post-finally|Pre-push)/i;
const INTERNAL_REVIEW_MESSAGE =
  'Work is paused because the update could not be completed safely. Technical/platform review is required before work can continue. No customer approval is needed.';

export interface CycleWrapUpParams {
  sandboxId?: string;
  siteId: string;
  instanceId: string;
  userId?: string;
  requirementId: string;
  title: string;
  instructions: string | null;
  /** Slim digest marker from emitDocsDigestStep — full bodies are reloaded from logs. */
  digest: DocsDigestResult | null;
  planCompleted: boolean;
  pendingPlanSteps?: number;
  hasRunnableBacklogWork?: boolean;
  previewUrl?: string | null;
  repoUrl?: string | null;
  audit?: CronAuditContext;
  /** Bypass empty-history and pending-plan suppression for terminal reporting. */
  forceWrapUp?: boolean;
  wrapUpReason?: string | null;
  requiresUserFeedback?: boolean;
  /** Authoritative recovery policy. Omitted only for older durable payloads. */
  recoveryDisposition?: CycleRecoveryDisposition;
  /** Host-validated reviewer receipt, never inferred from stop-reason prose. */
  productDecision?: Extract<MigrationSecurityReview, { decision: 'needs_product_decision' }>;
}

export type CycleWrapUpResult =
  // Completion refers only to reporting, never authorization to resume the requirement.
  | { ran: true; outcome: 'completed' }
  | { ran: false; outcome: 'skipped' | 'failed' };

export async function emitCycleWrapUpStep(params: CycleWrapUpParams): Promise<CycleWrapUpResult> {
  'use step';
  const {
    siteId,
    instanceId,
    userId,
    requirementId,
    title,
    instructions,
    digest,
    planCompleted,
    pendingPlanSteps,
    hasRunnableBacklogWork,
    previewUrl,
    repoUrl,
    forceWrapUp,
    wrapUpReason,
    requiresUserFeedback,
    recoveryDisposition,
  } = params;

  try {
    const ownership = params.audit?.executionOwnership;
    if (ownership) await assertCronExecutionOwnership({ ...ownership, allowTerminal: true });
    // Terminal product failures cannot be reopened by stale plan retry counts.
    const explicitTechnicalHold = recoveryDisposition === 'internal_review' ||
      recoveryDisposition === 'product_failure';
    const retryableStepFailure = recoveryDisposition
      ? recoveryDisposition === 'retry' ||
        (recoveryDisposition === 'delivery_failure' &&
          await hasRunnableRequirementPlan(instanceId, requirementId))
      : !!requiresUserFeedback && !!wrapUpReason && (
          // Compatibility for previously queued workflows. New callers pass policy.
          wrapUpReason.startsWith(STEP_FAILURE_REASON_PREFIX)
            ? await hasRetryablePlanFailure(instanceId, requirementId)
            : AUTOMATED_RECOVERY_ERROR.test(wrapUpReason) &&
              await hasRunnableRequirementPlan(instanceId, requirementId)
        );
    const interventionRequired = !retryableStepFailure &&
      (!!recoveryDisposition || !!requiresUserFeedback);
    const verifiedDecision = params.productDecision;
    const decisionState = interventionRequired ? await loadCycleInterventionState(requirementId, siteId)
      : { userDecisionBlockers: [], technicalReviewRequired: false };
    if (decisionState === null) {
      await createRequirementStatusCore({ site_id: siteId, instance_id: instanceId, requirement_id: requirementId,
        stage: 'blocked', message: 'Work remains paused. The current blocker could not be verified; no recovery or customer decision is being claimed.' });
      return { ran: false, outcome: 'failed' };
    }
    const userDecisionBlockers = [...decisionState.userDecisionBlockers];
    if (interventionRequired && verifiedDecision?.decisionId && verifiedDecision.question && verifiedDecision.options?.length >= 2) {
      userDecisionBlockers.push({ blocker_id: verifiedDecision.decisionId, category: 'user_decision', resolution_actor: 'user',
        reason: `${verifiedDecision.question} Options: ${verifiedDecision.options.join(' / ')}` });
    }
    const technicalReviewRequired = explicitTechnicalHold || decisionState.technicalReviewRequired ||
      (interventionRequired && userDecisionBlockers.length === 0);
    const effectiveRequiresUserFeedback = interventionRequired && userDecisionBlockers.length > 0;
    const internalReviewRequired = technicalReviewRequired && !effectiveRequiresUserFeedback;
    const effectiveForceWrapUp = forceWrapUp || technicalReviewRequired;
    // Internal diagnostics stay in execution logs, not client-facing status/prose inputs.
    const effectiveWrapUpReason = internalReviewRequired
      ? INTERNAL_REVIEW_MESSAGE
      : retryableStepFailure
      ? `${wrapUpReason || 'The work cycle needs another attempt.'} Automatic retries remaining; continue in the next cycle without requesting user intervention.`
      : effectiveRequiresUserFeedback
      ? userDecisionBlockers.map(blocker => blocker.reason).join('\n') +
        (technicalReviewRequired ? '\nInternal technical review is also required. The customer reply does not release that hold or restart execution.' : '')
      : wrapUpReason;

    if (retryableStepFailure) {
      try {
        await createRequirementStatusCore({
          site_id: siteId,
          instance_id: instanceId,
          requirement_id: requirementId,
          stage: 'in-progress',
          message: effectiveWrapUpReason ?? undefined,
        });
      } catch (statusError: unknown) {
        console.warn(
          `[CycleWrapUpStep] Failed to preserve retryable status for ${requirementId}:`,
          statusError instanceof Error ? statusError.message : statusError,
        );
      }
    } else if (internalReviewRequired || effectiveRequiresUserFeedback) {
      try {
        await createRequirementStatusCore({
          site_id: siteId,
          instance_id: instanceId,
          requirement_id: requirementId,
          stage: 'blocked',
          message: (
            effectiveWrapUpReason ||
            'Work is paused and requires user feedback before it can continue.'
          ).slice(0, 1000),
        });
      } catch (statusError: unknown) {
        console.warn(
          `[CycleWrapUpStep] Failed to persist blocked status for ${requirementId}:`,
          statusError instanceof Error ? statusError.message : statusError,
        );
        return { ran: false, outcome: 'failed' };
      }
    }

    const diagnosticContext = { siteId, instanceId, requirementId, runtime: 'cycle_wrapup', toolNames: ['requirement_status'] };
    const assertCurrent = ownership
      ? () => assertCronExecutionOwnership({ ...ownership, allowTerminal: true }) : undefined;
    // Host-owned and replay-safe: reporting/model failure must not lose the technical handoff.
    const technicalSupport = technicalReviewRequired
      ? await ensureCycleTechnicalEscalation(diagnosticContext, { reason: wrapUpReason, assertCurrent })
      : undefined;

    const history = await loadUserActionHistory(instanceId, { requirementId });
    // Reload full digest from the log written by emitDocsDigestStep (slim workflow payload).
    let digestFiles =
      digest?.emitted
        ? await loadLatestDocsDigestFromLogs(instanceId, requirementId)
        : null;
    if (!digestFiles && digest?.emitted) {
      // Fallback: try without requirement filter
      digestFiles = await loadLatestDocsDigestFromLogs(instanceId);
    }

    if (shouldSkipWrapUpForPendingSteps({
      planCompleted,
      pendingPlanSteps,
      hasRunnableBacklogWork,
      forceWrapUp: effectiveForceWrapUp,
    })) {
      console.log(
        `[CycleWrapUpStep] Skipping wrap-up for ${requirementId} — ${pendingPlanSteps} plan step(s) still pending`,
      );
      return { ran: false, outcome: 'skipped' };
    }

    if (
      !effectiveForceWrapUp &&
      !shouldRunCycleWrapUp({
        hasDigest: !!(digestFiles && digestFiles.length > 0),
        userMessageCount: history.totalCount,
      })
    ) {
      console.log(
        `[CycleWrapUpStep] Skipping wrap-up for ${requirementId} — no docs digest and no user messages`,
      );
      return { ran: false, outcome: 'skipped' };
    }

    const systemPrompt = buildCycleWrapUpSystemPrompt({
      title,
      requirementId,
      instructions,
      historyPromptText: history.promptText,
      historyMode: history.mode,
      digestFiles,
      planCompleted,
      pendingPlanSteps,
      hasRunnableBacklogWork,
      wrapUpReason: effectiveWrapUpReason,
      requiresUserFeedback: effectiveRequiresUserFeedback,
      internalReviewRequired,
      technicalReviewRequired,
      userDecisionBlockers,
      technicalSupport,
      previewUrl,
      repoUrl,
    });

    const statusTool = requirementStatusTool(siteId, instanceId);
    const tools = [{
      ...statusTool,
      execute: async (args: Parameters<typeof statusTool.execute>[0]) => {
        if (ownership) await assertCronExecutionOwnership({ ...ownership, allowTerminal: true });
        if ((args.action || 'create') === 'create') {
          if (internalReviewRequired) {
            // Neither a model verdict nor raw diagnostics may reopen or misreport this hold.
            args = { ...args, stage: 'blocked', message: INTERNAL_REVIEW_MESSAGE };
          } else if (retryableStepFailure) {
            args = { ...args, stage: 'in-progress' };
          } else if (effectiveRequiresUserFeedback) {
            args = { ...args, stage: 'blocked', message: effectiveWrapUpReason ?? undefined };
          } else if (!['in-progress', 'on-review'].includes(args.stage || '')) {
            return { success: false, error: 'Only the delivery finalizer may complete a requirement. Use in-progress or on-review.' };
          }
        }
        return statusTool.execute({
          ...args,
          requirement_id: requirementId,
          instance_id: instanceId,
        });
      },
    }, ...createHarnessDiagnosticTools(diagnosticContext, { readOnly: true }).map(tool => ({
      ...tool,
      execute: async (args: unknown) => {
        await assertCurrent?.();
        return tool.execute(args);
      },
    }))];
    refreshHarnessToolManifest(tools, 'cycle_wrapup');

    let currentMessages: any[] = [
      {
        role: 'user',
        content:
          'Please review the digest and history, update status if needed, and write the final wrap-up message for the client.',
      },
    ];

    console.log(
      `[CycleWrapUpStep] Running wrap-up for req ${requirementId} with history mode=${history.mode} digestFiles=${digestFiles?.length ?? 0}`,
    );

    const wrapupModel = process.env.AI_CODE_MODEL || process.env.OPENROUTER_CHAT_MODEL;
    let turns = 0;
    let isDone = false;

    while (!isDone && turns < 3) {
      const result = await executeAssistantStep(
        currentMessages,
        { id: instanceId, site_id: siteId, user_id: userId, requirement_id: requirementId },
        {
          use_sdk_tools: false,
          provider: 'openrouter',
          ai_provider: 'openrouter',
          ai_model: wrapupModel,
          instance_id: instanceId,
          site_id: siteId,
          user_id: userId,
          requirement_id: requirementId,
          system_prompt: systemPrompt,
          custom_tools: tools,
        },
      );

      currentMessages = result.messages;
      isDone = result.isDone;
      turns++;
    }

    if (!isDone || technicalSupport?.state === 'unavailable') return { ran: false, outcome: 'failed' };
    console.log(`[CycleWrapUpStep] Completed in ${turns} turns for req ${requirementId}`);
    return { ran: true, outcome: 'completed' };
  } catch (error: unknown) {
    console.warn(
      `[CycleWrapUpStep] Failed to run wrap-up for req ${requirementId}:`,
      error instanceof Error ? error.message : error,
    );
    return { ran: false, outcome: 'failed' };
  }
}
