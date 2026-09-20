/**
 * Backlog types live in their own module so `requirement-flows.ts` can depend
 * on them without pulling in Supabase / runtime code.
 */

import type { EvidenceRecord } from './requirement-ground-truth';

export type BacklogItemStatus =
  | 'pending'
  | 'in_progress'
  | 'critic_review'
  | 'judge_review'
  | 'done'
  | 'needs_review'
  | 'rejected';

export type BacklogItemKind =
  | 'page' | 'component' | 'crud' | 'api' | 'auth' | 'integration'
  | 'section' | 'chapter' | 'glossary'
  | 'doc'
  | 'slide' | 'chart' | 'asset'
  | 'clause' | 'schedule' | 'annex'
  | 'subtask' | 'script'
  | 'polish' | 'content';

export type BacklogItemScope = 'full' | 'mvp' | 'minimal';

/**
 * Tier separates **core** (functional, must ship to call the requirement
 * "done") from **ornamental** (nice-to-have polish, landings, README pages).
 * Introduced in Phase 10 to stop the "map-instead-of-product" failure mode
 * where the producer shipped a landing describing the product and the judge
 * approved because the acceptance was narrative.
 *
 * Rules:
 *   - `completion_ratio` is computed over `core` items only.
 *   - Judge applies kind-specific hard contracts ONLY to core items.
 *   - The requirement cannot reach `completed` while any core item is pending.
 *
 * Backwards-compat: existing items without `tier` are treated as `core`
 * (strict). That means legacy narrative items will now visibly block closure
 * until they are downgraded to `ornamental` or rewritten with real acceptance.
 */
export type BacklogItemTier = 'core' | 'ornamental';

export type BacklogBlockerCategory =
  | 'dependency'
  | 'product_defect'
  | 'infrastructure_unavailable'
  | 'missing_precondition'
  | 'evidence_gap'
  | 'contract_error'
  | 'user_decision';

export type BacklogBlockerResolutionActor =
  | 'executor'
  | 'verifier'
  | 'platform'
  | 'user';

/**
 * A scoped impediment attached to one backlog item.
 *
 * Direct blockers omit `propagated_from_item_id`. Dependency descendants
 * receive materialized copies with that field populated so callers can render
 * why an item is waiting without traversing the graph themselves.
 */
export interface BacklogBlocker {
  blocker_id: string;
  category: BacklogBlockerCategory;
  reason: string;
  resolution_actor: BacklogBlockerResolutionActor;
  source_item_id?: string;
  source_step_id?: string;
  propagated_from_item_id?: string;
  user_action_required?: boolean;
  retry_after?: string;
  created_at?: string;
}

export interface BacklogItem {
  id: string;
  title: string;
  kind: BacklogItemKind;
  phase_id: string;
  acceptance: string[];
  /** MUST NOT / hard rules extracted from the spec (negative acceptance). */
  constraints?: string[];
  touches?: string[];
  status: BacklogItemStatus;
  /** Number of product verification / judge failures. */
  attempts: number;
  /** Counter of plumbing failures by tool name. Informational, does not scale to needs_review. */
  tool_failures?: Record<string, number>;
  assumptions?: string[];
  scope_level: BacklogItemScope;
  tier?: BacklogItemTier;
  depends_on?: string[];
  /** Current direct and dependency-propagated impediments for this item. */
  blocked_by?: BacklogBlocker[];
  /** Durable outbox entry cleared only after bound plan steps are cancelled. */
  plan_cancellation_pending?: {
    reason: string;
    requested_at: string;
  };
  evidence?: EvidenceRecord;
  created_at?: string;
  updated_at?: string;
}

export interface RequirementBacklog {
  schema_version: 1;
  items: BacklogItem[];
  current_phase_id: string;
  completion_ratio: number;
  cycles_spent_total: number;
}

export function emptyBacklog(phaseId: string): RequirementBacklog {
  return {
    schema_version: 1,
    items: [],
    current_phase_id: phaseId,
    completion_ratio: 0,
    cycles_spent_total: 0,
  };
}
