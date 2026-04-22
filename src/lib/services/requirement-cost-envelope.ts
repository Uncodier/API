/**
 * Cost envelopes per requirement/item/step. Reads the declarative budget from
 * the Flow Registry and throws typed errors when the caller is over budget, so
 * the self-heal module (see `requirement-self-heal.ts`) can turn an exhausted
 * envelope into a deterministic next action (rotate → downgrade → assume → needs_review).
 *
 * Rationale: keeping budgets declarative (in the registry) and enforcement
 * deterministic (here) prevents ad-hoc "just one more retry" decisions
 * leaking into the orchestrator.
 */

import type { RequirementKind } from './requirement-flows';
import { getFlow } from './requirement-flows';

export type BudgetScope = 'item' | 'step' | 'requirement';

export class BudgetExhaustedError extends Error {
  constructor(
    public readonly scope: BudgetScope,
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`budget exhausted for scope=${scope}: used ${used}/${limit}`);
    this.name = 'BudgetExhaustedError';
  }
}

export interface BudgetUsage {
  cycles_used_item: number;
  turns_used_step: number;
  cycles_used_requirement: number;
}

/**
 * Assert the caller has not blown through its budget. Called from:
 *   - inline-step-executor before each retry (`step` scope).
 *   - cron-execute-steps-phase before advancing to the next step (`item` scope).
 *   - workflow.ts on each cycle entry (`requirement` scope).
 */
export function assertBudget(kind: RequirementKind, usage: BudgetUsage): void {
  const flow = getFlow(kind);
  const env = flow.cost_envelope;
  if (usage.cycles_used_item >= env.max_cycles_per_item) {
    throw new BudgetExhaustedError('item', env.max_cycles_per_item, usage.cycles_used_item);
  }
  if (usage.turns_used_step >= env.max_turns_per_step) {
    throw new BudgetExhaustedError('step', env.max_turns_per_step, usage.turns_used_step);
  }
  if (usage.cycles_used_requirement >= env.max_cycles_per_requirement) {
    throw new BudgetExhaustedError(
      'requirement',
      env.max_cycles_per_requirement,
      usage.cycles_used_requirement,
    );
  }
}

export function budgetRemaining(kind: RequirementKind, usage: BudgetUsage): {
  item: number;
  step: number;
  requirement: number;
} {
  const env = getFlow(kind).cost_envelope;
  return {
    item: Math.max(0, env.max_cycles_per_item - usage.cycles_used_item),
    step: Math.max(0, env.max_turns_per_step - usage.turns_used_step),
    requirement: Math.max(0, env.max_cycles_per_requirement - usage.cycles_used_requirement),
  };
}
