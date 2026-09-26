import type { BacklogItem, BacklogItemStatus, RequirementBacklog } from './requirement-backlog-types';
import { isBacklogActiveStatus } from './requirement-backlog-invariants';
import { isBacklogItemRunnable } from './requirement-backlog-blockers';
import { getFlow, productAttemptLimits, type RequirementKind } from './requirement-flows';

export const BACKLOG_LIST_STATUSES = [
  'open', 'all', 'pending', 'in_progress', 'critic_review', 'judge_review',
  'done', 'needs_review', 'rejected',
] as const;

export interface BacklogListOptions {
  list_status?: typeof BACKLOG_LIST_STATUSES[number];
  limit?: number;
  offset?: number;
}

function boundedText(text: string | undefined, limit = 400): string | undefined {
  if (text === undefined || text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function summarizeItem(item: BacklogItem) {
  const evidence = item.evidence;
  return {
    id: item.id,
    title: boundedText(item.title, 240),
    kind: item.kind,
    tier: item.tier ?? 'core',
    phase_id: item.phase_id,
    status: item.status,
    scope_level: item.scope_level,
    attempts: item.attempts,
    tool_failures: item.tool_failures,
    updated_at: item.updated_at,
    depends_on: item.depends_on,
    blocked_by: item.blocked_by?.slice(0, 3).map((blocker) => ({
      blocker_id: blocker.blocker_id,
      category: blocker.category,
      reason: boundedText(blocker.reason),
      resolution_actor: blocker.resolution_actor,
      user_action_required: blocker.user_action_required,
      retry_after: blocker.retry_after,
    })),
    blocked_by_count: item.blocked_by?.length ?? 0,
    review_quarantine: item.review_quarantine ? {
      active: item.review_quarantine.active,
      kind: item.review_quarantine.kind,
      ...(item.review_quarantine.active ? { reason: boundedText(item.review_quarantine.reason) } : {}),
    } : undefined,
    plan_cancellation_pending: !!item.plan_cancellation_pending,
    acceptance_count: item.acceptance.length,
    assumptions_count: item.assumptions?.length ?? 0,
    evidence_summary: evidence ? {
      captured_at: evidence.captured_at,
      judge_verdict: evidence.judge_verdict,
      judge_failure_kind: evidence.judge_failure_kind,
      judge_reason: boundedText(evidence.judge_reason),
      matched_count: evidence.judge_matched_acceptance?.length,
      unmatched_count: evidence.judge_unmatched_acceptance?.length,
    } : undefined,
  };
}

/** A read-only projection. Canonical items and their evidence are never trimmed. */
export function buildBacklogListView(
  kind: RequirementKind,
  backlog: RequirementBacklog,
  options: BacklogListOptions = {},
) {
  const listStatus = options.list_status ?? 'open';
  if (!BACKLOG_LIST_STATUSES.includes(listStatus)) {
    throw new Error(`Invalid list_status: ${listStatus}`);
  }
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('list limit must be an integer between 1 and 50');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('list offset must be a non-negative integer');
  }
  const completedIds = new Set(backlog.items.filter((item) => item.status === 'done').map((item) => item.id));
  const limits = productAttemptLimits(getFlow(kind));
  const runnable = (item: BacklogItem) => isBacklogItemRunnable(item, completedIds, limits) && !item.plan_cancellation_pending;
  const counts: Record<BacklogItemStatus, number> = {
    pending: 0, in_progress: 0, critic_review: 0, judge_review: 0,
    done: 0, needs_review: 0, rejected: 0,
  };
  for (const item of backlog.items) counts[item.status]++;
  const rank = (item: BacklogItem) => isBacklogActiveStatus(item.status) ? 0 : runnable(item) ? 1 : 2;
  const filtered = backlog.items.filter((item) =>
    listStatus === 'all' || (listStatus === 'open'
      ? item.status !== 'done' && item.status !== 'rejected'
      : item.status === listStatus),
  ).sort((a, b) => rank(a) - rank(b));
  const page = filtered.slice(offset, offset + limit);
  const hasMore = offset + page.length < filtered.length;
  return {
    backlog: {
      schema_version: backlog.schema_version,
      current_phase_id: backlog.current_phase_id,
      completion_ratio: backlog.completion_ratio,
      cycles_spent_total: backlog.cycles_spent_total,
      items: page.map(summarizeItem),
    },
    summary: {
      total_items: backlog.items.length,
      counts_by_status: counts,
      active_item_ids: backlog.items.filter((item) => isBacklogActiveStatus(item.status)).map((item) => item.id),
      runnable_pending_count: backlog.items.filter((item) => item.status === 'pending' && runnable(item)).length,
    },
    pagination: {
      list_status: listStatus, limit, offset, total_items: filtered.length,
      has_more: hasMore, next_offset: hasMore ? offset + page.length : null,
    },
    detail_hint: 'Summary only. Use action="get" with item_id for full acceptance, constraints, evidence, and history. Use list_status="all" to include done/rejected items; follow pagination.next_offset for more.',
  };
}