import {
  bumpItemAttempts,
  downgradeScope,
  getBacklogItem,
  logAssumption,
  markNeedsReview,
  recordToolFailure,
} from '@/lib/services/requirement-backlog';
import { classifyFailure } from '@/lib/services/failure-classification';
import { planNextHealingAction } from '@/lib/services/requirement-self-heal';
import type { GateFailureCategory } from './step-iteration-signals';
import type { FlowGateSignal } from './gates/types';

export async function applyGateFailureHealing(params: {
  requirementId: string;
  backlogItemId: string;
  error: string;
  categories: GateFailureCategory[];
  flow: string;
  signals: FlowGateSignal[];
  skipAttemptBump?: boolean;
  remediationScheduled?: boolean;
  logPrefix: string;
}): Promise<void> {
  if (params.remediationScheduled) {
    console.log(
      `${params.logPrefix} Mandatory remediation scheduled; preserving the parent attempt budget.`,
    );
    return;
  }

  const classifiedSignals = params.signals.filter(
    (signal) => signal.disposition !== undefined,
  );
  if (
    classifiedSignals.length > 0 &&
    !classifiedSignals.some(
      (signal) => signal.disposition === 'hard_fail',
    )
  ) {
    console.log(
      `${params.logPrefix} Gate returned only advisory/unknown findings; preserving the product attempt budget.`,
    );
    return;
  }

  const { item } = await getBacklogItem(
    params.requirementId,
    params.backlogItemId,
  );
  if (!item) return;

  const classified = classifyFailure(params.error, params.categories, {
    flow: params.flow,
    signals: params.signals,
    skipAttemptBump: params.skipAttemptBump,
  });
  if (
    params.skipAttemptBump ||
    classified.failureClass === 'plumbing' ||
    !classified.countsTowardAttempts
  ) {
    const toolName = classified.toolName || `gate:${params.flow || 'task'}`;
    console.log(
      `${params.logPrefix} Plumbing failure detected for ${toolName}; preserving the product attempt budget.`,
    );
    await recordToolFailure({
      requirementId: params.requirementId,
      itemId: params.backlogItemId,
      toolName,
      reason: `[plumbing] Tool ${toolName} failed: ${params.error.slice(0, 150)}`,
    });
    return;
  }

  const bumped = await bumpItemAttempts({
    requirementId: params.requirementId,
    itemId: params.backlogItemId,
    reason: `gate_failed: ${params.error.slice(0, 200)}`,
  });
  const attempts = bumped?.attempts ?? item.attempts + 1;
  const action = planNextHealingAction({
    item,
    verdict: {
      verdict: 'rejected',
      reason: params.error || 'Gate failed',
      matched_acceptance: [],
      unmatched_acceptance: [],
    },
    attempts,
  });

  switch (action.kind) {
    case 'rotate_strategy':
      await logAssumption({
        requirementId: params.requirementId,
        itemId: item.id,
        assumption: `[rotate] ${action.hint}`,
      });
      break;
    case 'downgrade_scope':
      await downgradeScope({
        requirementId: params.requirementId,
        itemId: item.id,
      });
      await logAssumption({
        requirementId: params.requirementId,
        itemId: item.id,
        assumption: `[downgrade ${action.from}→${action.to}] ${action.reason}`,
      });
      break;
    case 'log_assumption_and_continue':
      await logAssumption({
        requirementId: params.requirementId,
        itemId: item.id,
        assumption: action.assumption,
      });
      break;
    case 'mark_needs_review':
      await markNeedsReview({
        requirementId: params.requirementId,
        itemId: item.id,
        reason: action.reason,
      });
      break;
  }
}
