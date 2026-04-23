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

export interface BacklogItem {
  id: string;
  title: string;
  kind: BacklogItemKind;
  phase_id: string;
  acceptance: string[];
  touches?: string[];
  status: BacklogItemStatus;
  attempts: number;
  assumptions?: string[];
  scope_level: BacklogItemScope;
  tier?: BacklogItemTier;
  depends_on?: string[];
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
