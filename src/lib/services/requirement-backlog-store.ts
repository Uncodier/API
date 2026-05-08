/**
 * Internal storage helpers for the backlog. Split from `requirement-backlog.ts`
 * so the watchdog / inference helpers can share the same load/write code
 * without forcing the file past the 500-line budget. NOT a public API —
 * consumers should use `requirement-backlog.ts` (CRUD) or
 * `requirement-backlog-watchdog.ts` (lifecycle helpers).
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  emptyBacklog,
  type BacklogItem,
  type RequirementBacklog,
} from './requirement-backlog-types';
import type { FlowDefinition } from './requirement-flows';

export interface RequirementRow {
  id: string;
  type: string | null;
  metadata: Record<string, any> | null;
  backlog: Record<string, any> | null;
}

export async function loadRequirement(requirementId: string): Promise<RequirementRow | null> {
  // Propagate the Supabase error instead of swallowing it: otherwise every
  // transient DB failure (RLS misconfig, env var missing in a different
  // runtime, network hiccup) would bubble up as a misleading
  // `Requirement <id> not found`, masking the real problem at the caller.
  const { data, error } = await supabaseAdmin
    .from('requirements')
    .select('id, type, metadata, backlog')
    .eq('id', requirementId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Failed to load requirement ${requirementId}: ${error.message}${error.code ? ` (code=${error.code})` : ''}`,
    );
  }
  return (data as RequirementRow) ?? null;
}

export function toBacklog(backlogData: Record<string, any> | null, defaultPhase: string): RequirementBacklog {
  const raw = (backlogData as RequirementBacklog | undefined) ?? null;
  if (!raw) return emptyBacklog(defaultPhase);
  return {
    schema_version: 1,
    items: Array.isArray(raw.items) ? raw.items : [],
    current_phase_id: raw.current_phase_id || defaultPhase,
    completion_ratio: typeof raw.completion_ratio === 'number' ? raw.completion_ratio : 0,
    cycles_spent_total: typeof raw.cycles_spent_total === 'number' ? raw.cycles_spent_total : 0,
  };
}

export async function writeBacklog(requirementId: string, backlog: RequirementBacklog): Promise<void> {
  const { error } = await supabaseAdmin.from('requirements').update({ backlog }).eq('id', requirementId);
  if (error) throw new Error(`Failed to persist backlog: ${error.message}`);
}

/**
 * Phase 10: completion ratio is computed over **core** items only. Ornamental
 * items (landings, polish, README sections) do not gate requirement closure.
 * When there are zero core items we fall back to the full-set ratio so
 * existing requirements don't regress to 1.0 trivially.
 */
export function computeRatio(items: BacklogItem[]): number {
  if (!items.length) return 0;
  const core = items.filter((i) => (i.tier ?? 'core') === 'core');
  const denom = core.length > 0 ? core.length : items.length;
  const pool = core.length > 0 ? core : items;
  const done = pool.filter((i) => i.status === 'done').length;
  return Math.round((done / denom) * 1000) / 1000;
}

/**
 * Rewind `current_phase_id` to the earliest phase that still has unfinished
 * items when an upsert/start lands in a phase prior to the current one.
 * No-op when phases are unknown or the item is already in/after the current
 * phase, or when the item itself is already terminal.
 */
export function reconcilePhaseForItem(
  backlog: RequirementBacklog,
  flow: FlowDefinition,
  item: BacklogItem,
): void {
  if (!item.phase_id) return;
  const itemIdx = flow.phases.findIndex((p) => p.id === item.phase_id);
  const curIdx = flow.phases.findIndex((p) => p.id === backlog.current_phase_id);
  if (itemIdx < 0 || curIdx < 0) return;
  if (itemIdx >= curIdx) return;
  if (item.status === 'done' || item.status === 'rejected' || item.status === 'needs_review') return;
  backlog.current_phase_id = item.phase_id;
}
