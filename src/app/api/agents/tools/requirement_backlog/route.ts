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
  type BacklogItemStatus,
  type BacklogItemKind,
  type BacklogItemTier,
} from '@/lib/services/requirement-backlog';

export type BacklogAction =
  | 'list'
  | 'upsert'
  | 'start'
  | 'complete'
  | 'downgrade'
  | 'log_assumption'
  | 'mark_needs_review'
  | 'set_status';

export interface BacklogCoreParams {
  action: BacklogAction;
  requirement_id: string;
  item_id?: string;
  title?: string;
  kind?: BacklogItemKind;
  phase_id?: string;
  acceptance?: string[];
  touches?: string[];
  scope_level?: 'full' | 'mvp' | 'minimal';
  tier?: BacklogItemTier;
  depends_on?: string[];
  status?: BacklogItemStatus;
  reason?: string;
  assumption?: string;
}

export async function executeBacklogCore(params: BacklogCoreParams) {
  const { action, requirement_id } = params;
  if (!requirement_id) throw new Error('requirement_id is required');

  switch (action) {
    case 'list': {
      const { kind, backlog } = await listBacklog(requirement_id);
      return { action, requirement_id, kind, backlog };
    }
    case 'upsert': {
      if (!params.title || !params.kind || !params.phase_id || !Array.isArray(params.acceptance) || params.acceptance.length === 0) {
        throw new Error('upsert requires title, kind, phase_id, acceptance[]');
      }
      const item = await upsertBacklogItem({
        requirementId: requirement_id,
        item: {
          id: params.item_id,
          title: params.title,
          kind: params.kind,
          phase_id: params.phase_id,
          acceptance: params.acceptance,
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
    case 'set_status': {
      if (!params.item_id || !params.status) throw new Error('set_status requires item_id + status');
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
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
