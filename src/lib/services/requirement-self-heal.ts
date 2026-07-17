/**
 * Escalated self-healing policy. When the Judge rejects an item or its budget
 * is exhausted, the orchestrator asks `planNextHealingAction(item, verdict)`
 * and gets a deterministic next action:
 *
 *   attempt 1 → rotate_strategy      (keep scope, try a different approach)
 *   attempt 2 → downgrade_scope      (full → mvp → minimal)
 *   attempt 3 → log_assumption_and_continue (weakens the acceptance via DECISIONS.md)
 *   attempt 4 → mark_needs_review    (non-blocking; human triage if desired)
 *
 * The policy never *blocks* progress — `needs_review` is an informational
 * label. The flow advances even when items stay in that state, so a single
 * stuck item cannot deadlock the whole requirement.
 */

import type { BacklogItem, BacklogItemScope } from './requirement-backlog-types';
import type { JudgeResult } from '@/app/api/cron/shared/archetype-runner';

export type HealingAction =
  | { kind: 'rotate_strategy'; hint: string }
  | { kind: 'downgrade_scope'; from: BacklogItemScope; to: BacklogItemScope; reason: string }
  | { kind: 'log_assumption_and_continue'; assumption: string; relaxed_acceptance: string[] }
  | { kind: 'mark_needs_review'; reason: string };

export interface HealingContext {
  item: BacklogItem;
  verdict: JudgeResult;
  /** Total attempts including the one that just failed. */
  attempts: number;
}

const SCOPE_CHAIN: BacklogItemScope[] = ['full', 'mvp', 'minimal'];

function nextScope(current: BacklogItemScope): BacklogItemScope | null {
  const i = SCOPE_CHAIN.indexOf(current);
  if (i < 0 || i === SCOPE_CHAIN.length - 1) return null;
  return SCOPE_CHAIN[i + 1];
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
    const next = nextScope(ctx.item.scope_level);
    if (next) {
      const hintReason = `Two attempts failed at scope=${ctx.item.scope_level} (Last: ${baseReason}).${unmatchedContext} Downgrading to ${next}. Focus ONLY on the critical path; defer polish to unblock the phase.`;
      return {
        kind: 'downgrade_scope',
        from: ctx.item.scope_level,
        to: next,
        reason: hintReason.length > 800 ? hintReason.slice(0, 797) + '...' : hintReason,
      };
    }
    // Already minimal → fall through to assumption path.
  }

  if (attempts === 3 || (attempts === 2 && ctx.item.scope_level === 'minimal')) {
    const assumption = deriveAssumption(ctx);
    return {
      kind: 'log_assumption_and_continue',
      assumption,
      relaxed_acceptance: ctx.item.acceptance.slice(0, Math.max(1, Math.floor(ctx.item.acceptance.length / 2))),
    };
  }

  return {
    kind: 'mark_needs_review',
    reason: `Item "${ctx.item.title}" exhausted ${attempts} attempts (last verdict: ${ctx.verdict.reason}). Flagging for human review; phase continues with remaining items.`,
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
