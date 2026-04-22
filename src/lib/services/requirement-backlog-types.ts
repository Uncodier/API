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
