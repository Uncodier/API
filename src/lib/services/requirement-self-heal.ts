/**
 * Escalated self-healing policy. When the Judge rejects an item or its budget
 * is exhausted, the orchestrator asks `planNextHealingAction(item, verdict)`
 * and gets a deterministic next action:
 *
 *   attempt 1 → rotate_strategy      (keep scope, try a different approach)
 *   attempt 2 → root-cause diagnosis (keep the requested behavior intact)
 *   attempt 3 → stop core work for review; ornamental work may be deferred
 *
 * `needs_review` releases the scheduler but does not count as successful
 * requirement completion.
 */

import type { BacklogItem } from './requirement-backlog-types';
import type { JudgeResult } from '@/app/api/cron/shared/archetype-runner';

export type HealingAction =
  | { kind: 'rotate_strategy'; hint: string }
  | { kind: 'log_assumption_and_continue'; assumption: string; relaxed_acceptance: string[] }
  | { kind: 'mark_needs_review'; reason: string };

export interface HealingContext {
  item: BacklogItem;
  verdict: JudgeResult;
  /** Total attempts including the one that just failed. */
  attempts: number;
}

/**
 * Deterministic. No LLM call; the hint strings are stable text the Producer
 * prompt can render verbatim.
 */
export function planNextHealingAction(ctx: HealingContext): HealingAction {
  const attempts = ctx.attempts;
  const reason = ctx.verdict.reason || 'Unknown reason';
  
  // Extract a single clear next action if the judge provided one (often prefixed by "Next:")
  // Otherwise default to the generic rotate advice.
  let nextAction = 'switch approach — different library primitive, different data shape, or different route layout. Do not retry the exact same commands.';
  
  // If the reason already embeds the next action, we can strip it from the base reason 
  // to avoid duplication in the hint.
  let baseReason = reason;
  
  if (reason.includes('Next:')) {
    const parts = reason.split('Next:');
    baseReason = parts[0].trim();
    nextAction = parts[1].trim();
  } else if (reason.includes('Fix the')) {
    const fixMatch = reason.match(/Fix the[^.]+\./);
    if (fixMatch) {
      nextAction = fixMatch[0];
      baseReason = reason.replace(fixMatch[0], '').trim();
    }
  } else if (reason.includes('Produce evidence')) {
    const prodMatch = reason.match(/Produce evidence[^.]+\./);
    if (prodMatch) {
      nextAction = prodMatch[0];
      baseReason = reason.replace(prodMatch[0], '').trim();
    }
  }

  // Clean up trailing dots/spaces from stripping
  baseReason = baseReason.replace(/\.+$/, '').trim();

  // Include top unmatched item to help focus the next attempt
  const unmatched = ctx.verdict.unmatched_acceptance?.[0];
  const unmatchedContext = unmatched ? ` Missing evidence for e.g. "${unmatched}".` : '';

  if (attempts <= 1) {
    const hint = `Previous attempt rejected: ${baseReason}.${unmatchedContext} Keep scope (${ctx.item.scope_level}). ${nextAction}`;
    return {
      kind: 'rotate_strategy',
      hint: hint.length > 800 ? hint.slice(0, 797) + '...' : hint,
    };
  }

  if (attempts === 2) {
    const hint =
      `ROOT-CAUSE DIAGNOSIS REQUIRED after two failed attempts. ` +
      `Do not deploy, rename tests, edit comments, or retry the same probe. ` +
      `Trace the failing request and persisted state, identify the first false assumption, ` +
      `then make one product-code repair. Last failure: ${baseReason}.${unmatchedContext}`;
    return {
      kind: 'rotate_strategy',
      hint: hint.length > 800 ? hint.slice(0, 797) + '...' : hint,
    };
  }

  if (
    attempts >= 3 &&
    ctx.item.tier === 'ornamental'
  ) {
    const assumption = deriveAssumption(ctx);
    return {
      kind: 'log_assumption_and_continue',
      assumption,
      relaxed_acceptance: ctx.item.acceptance.slice(0, Math.max(1, Math.floor(ctx.item.acceptance.length / 2))),
    };
  }

  return {
    kind: 'mark_needs_review',
    reason:
      `Item "${ctx.item.title}" exhausted the three-attempt product budget ` +
      `(last verdict: ${ctx.verdict.reason}). Automatic retries are stopped for human review.`,
  };
}

function deriveAssumption(ctx: HealingContext): string {
  const topReason = ctx.verdict.reason || 'acceptance unmet';
  const unmatched = ctx.verdict.unmatched_acceptance?.[0];
  if (unmatched) {
    return `Assumption (auto-logged): the requirement "${unmatched}" is deferred — current evidence covers the critical path but not this edge case. Reason: ${topReason}.`;
  }
  return `Assumption (auto-logged): delivering the minimal viable variant of "${ctx.item.title}" and deferring strict validation. Reason: ${topReason}.`;
}
