import { NextRequest, NextResponse } from 'next/server';
import {
  completeItem,
  downgradeScope,
  listBacklog,
  logAssumption,
  markInProgress,
  markNeedsReview,
  setItemStatus,
  upsertBacklogItem,
  isBacklogComplete,
  hasUserRequestedMoreWork,
  type BacklogItemStatus,
  type BacklogItemKind,
  type BacklogItemTier,
} from '@/lib/services/requirement-backlog';
import { buildBacklogListView, type BacklogListOptions } from '@/lib/services/requirement-backlog-view';
import { assertAgentBacklogTransitionAllowed } from './agent-transition-policy';
import {
  blockBacklogItem,
  resolveBacklogItemBlocker,
} from '@/lib/services/requirement-backlog-blocker-service';
import type {
  BacklogBlockerCategory,
  BacklogBlockerResolutionActor,
} from '@/lib/services/requirement-backlog-types';
import {
  parseDeclaredAcceptanceContract,
  type AcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';

export type BacklogAction =
  | 'list'
  | 'get'
  | 'upsert'
  | 'start'
  | 'complete'
  | 'downgrade'
  | 'log_assumption'
  | 'mark_needs_review'
  | 'report_blocker'
  | 'resolve_blocker'
  | 'set_status';

export interface BacklogCoreParams extends BacklogListOptions {
  action: BacklogAction;
  requirement_id: string;
  item_id?: string;
  title?: string;
  kind?: BacklogItemKind;
  phase_id?: string;
  acceptance?: string[];
  acceptance_contract?: AcceptanceContract;
  touches?: string[];
  scope_level?: 'full' | 'mvp' | 'minimal';
  tier?: BacklogItemTier;
  depends_on?: string[];
  status?: BacklogItemStatus;
  reason?: string;
  assumption?: string;
  blocker_id?: string;
  blocker_category?: BacklogBlockerCategory;
  resolution_actor?: BacklogBlockerResolutionActor;
  source_step_id?: string;
  user_action_required?: boolean;
  retry_after?: string;
}

export async function executeBacklogCore(params: BacklogCoreParams) {
  const result = await executeBacklogAction(params);
  if ('item' in result && !result.item) {
    throw new Error(`Backlog item ${params.item_id} not found`);
  }
  return { success: true, ...result };
}

async function executeBacklogAction(params: BacklogCoreParams) {
  const { action, requirement_id } = params;
  if (!requirement_id) throw new Error('requirement_id is required');
  assertAgentBacklogTransitionAllowed({
    action,
    status: params.status,
  });

  // Coerce arrays in case stringified JSON bypassed the adapter
  if (typeof params.acceptance === 'string') {
    try { params.acceptance = JSON.parse(params.acceptance); } catch {}
  }
  if (typeof params.touches === 'string') {
    try { params.touches = JSON.parse(params.touches); } catch {}
  }
  if (typeof params.depends_on === 'string') {
    try { params.depends_on = JSON.parse(params.depends_on); } catch {}
  }

  // Recovery belongs to the trusted user-action handler, never to a tool read
  // (or an unawaited side effect racing a backlog mutation).
  switch (action) {
    case 'list': {
      const { kind, backlog } = await listBacklog(requirement_id);
      return { action, requirement_id, kind, ...buildBacklogListView(kind, backlog, params) };
    }
    case 'get': {
      if (!params.item_id) throw new Error('get requires item_id');
      const { kind, backlog } = await listBacklog(requirement_id);
      const item = backlog.items.find((candidate) => candidate.id === params.item_id);
      if (!item) throw new Error(`Backlog item ${params.item_id} not found`);
      return { action, requirement_id, kind, item };
    }
    case 'upsert': {
      if (!params.title || !params.kind || !params.phase_id || !Array.isArray(params.acceptance) || params.acceptance.length === 0) {
        throw new Error('upsert requires title, kind, phase_id, acceptance[]');
      }
      const { backlog } = await listBacklog(requirement_id);
      const existingItem = params.item_id
        ? backlog?.items?.find((item: any) => item.id === params.item_id)
        : undefined;
      let declaredContract: AcceptanceContract | undefined;
      if (params.acceptance_contract !== undefined) {
        let rawContract: unknown = params.acceptance_contract;
        if (typeof rawContract === 'string') {
          try {
            rawContract = JSON.parse(rawContract);
          } catch {
            throw new Error(
              'upsert acceptance_contract must be valid JSON.',
            );
          }
        }
        declaredContract = parseDeclaredAcceptanceContract(
          params.acceptance,
          rawContract,
        );
      }
      if (
        existingItem &&
        ['done', 'needs_review', 'rejected'].includes(existingItem.status)
      ) {
        throw new Error(
          `Backlog item ${params.item_id} is terminal in ` +
          `"${existingItem.status}" and cannot be rewritten by model-facing ` +
          'tools. Inspect its evidence with action="get". A new external ' +
          'user action must authorize a retry; do not clone the same work.',
        );
      }
      const effectiveTier =
        params.tier ?? existingItem?.tier ?? 'core';
      if (isBacklogComplete(backlog?.items || [])) {
        const userRequested = await hasUserRequestedMoreWork(requirement_id);
        if (!userRequested) {
          throw new Error(
            'The backlog is closed: all deliverable items are complete and ' +
            'there is no newer trusted external user action. Report the ' +
            'requirement as complete; only a new user message can authorize ' +
            'additional backlog work.'
          );
        }
      }
      if (!existingItem && effectiveTier === 'core' && !declaredContract) {
        throw new Error(
          'New tier=core backlog items require a declared ' +
          'AcceptanceContractV2.',
        );
      }
      
      const item = await upsertBacklogItem({
        requirementId: requirement_id,
        item: {
          id: params.item_id,
          title: params.title,
          kind: params.kind,
          phase_id: params.phase_id,
          acceptance: params.acceptance,
          ...(declaredContract
            ? { acceptance_contract: declaredContract }
            : {}),
          touches: params.touches,
          scope_level: params.scope_level,
          tier: params.tier,
          depends_on: params.depends_on,
        },
      });
      return { action, requirement_id, item };
    }
    case 'start': {
      if (!params.item_id) throw new Error('start requires item_id');
      const item = await markInProgress({ requirementId: requirement_id, itemId: params.item_id });
      return { action, requirement_id, item };
    }
    case 'complete': {
      if (!params.item_id) throw new Error('complete requires item_id');
      const item = await completeItem({ requirementId: requirement_id, itemId: params.item_id });
      return { action, requirement_id, item };
    }
    case 'downgrade': {
      if (!params.item_id) throw new Error('downgrade requires item_id');
      const item = await downgradeScope({ requirementId: requirement_id, itemId: params.item_id });
      return { action, requirement_id, item };
    }
    case 'log_assumption': {
      if (!params.item_id || !params.assumption) throw new Error('log_assumption requires item_id + assumption');
      const item = await logAssumption({ requirementId: requirement_id, itemId: params.item_id, assumption: params.assumption });
      return { action, requirement_id, item };
    }
    case 'mark_needs_review': {
      if (!params.item_id) throw new Error('mark_needs_review requires item_id');
      const item = await markNeedsReview({ requirementId: requirement_id, itemId: params.item_id, reason: params.reason });
      return { action, requirement_id, item };
    }
    case 'report_blocker': {
      if (
        !params.item_id ||
        !params.blocker_category ||
        !params.reason ||
        !params.resolution_actor
      ) {
        throw new Error(
          'report_blocker requires item_id, blocker_category, reason, and resolution_actor',
        );
      }
      const result = await blockBacklogItem({
        requirementId: requirement_id,
        itemId: params.item_id,
        blockerId: params.blocker_id,
        category: params.blocker_category,
        reason: params.reason,
        resolutionActor: params.resolution_actor,
        sourceStepId: params.source_step_id,
        userActionRequired: params.user_action_required,
        retryAfter: params.retry_after,
      });
      if (!result) {
        throw new Error('Could not persist backlog blocker');
      }
      return { action, requirement_id, ...result };
    }
    case 'resolve_blocker': {
      if (!params.item_id || !params.blocker_id) {
        throw new Error('resolve_blocker requires item_id and blocker_id');
      }
      const item = await resolveBacklogItemBlocker({
        requirementId: requirement_id,
        itemId: params.item_id,
        blockerId: params.blocker_id,
        reason: params.reason,
        resolver: 'agent',
      });
      return { action, requirement_id, item };
    }
    case 'set_status': {
      if (!params.item_id || !params.status) throw new Error('set_status requires item_id + status');
      
      const { backlog } = await listBacklog(requirement_id);
      const existingItem = backlog?.items?.find((i: any) => i.id === params.item_id);
      if (
        (existingItem?.status === 'done' ||
          existingItem?.status === 'needs_review' ||
          existingItem?.status === 'rejected') &&
        params.status !== existingItem.status
      ) {
        throw new Error(
          `Backlog item ${params.item_id} is quarantined in ` +
          `"${existingItem.status}". Model-facing tools cannot reopen terminal ` +
          'items. A new external user action is required to authorize a retry; ' +
          'do not clone the same work.',
        );
      }
      if (params.status === 'in_progress') {
        const item = await markInProgress({
          requirementId: requirement_id,
          itemId: params.item_id,
        });
        return { action, requirement_id, item };
      }
      
      const item = await setItemStatus({
        requirementId: requirement_id,
        itemId: params.item_id,
        status: params.status,
        reason: params.reason,
      });
      return { action, requirement_id, item };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BacklogCoreParams;
    const result = await executeBacklogCore(body);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to execute requirement_backlog';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
