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
  isRequirementReopened,
  isBacklogComplete,
  hasUserRequestedMoreWork,
  type BacklogItemStatus,
  type BacklogItemKind,
  type BacklogItemTier,
} from '@/lib/services/requirement-backlog';
import { checkAndResetCronAttempts } from '@/lib/services/requirement-cron-reset';
import { getRequirementById } from '@/lib/database/requirement-db';

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
  confirm_reopen?: boolean;
}

export async function executeBacklogCore(params: BacklogCoreParams) {
  const { action, requirement_id } = params;
  if (!requirement_id) throw new Error('requirement_id is required');

  // Async unblock if there was a recent user action
  getRequirementById(requirement_id).then(req => {
    if (req?.metadata) {
      checkAndResetCronAttempts(requirement_id, req.metadata).catch(console.error);
    }
  }).catch(console.error);

  switch (action) {
    case 'list': {
      const { kind, backlog } = await listBacklog(requirement_id);
      
      // TRUNCATE EVIDENCE TO AVOID CRASHING LLM CONTEXT
      if (backlog && Array.isArray(backlog.items)) {
        backlog.items = backlog.items.map((item: any) => {
          const newItem = { ...item };
          if (newItem.evidence) {
             newItem.evidence = { 
               _truncated: "Evidence data removed to save context window. Use other tools to inspect." 
             };
          }
          return newItem;
        });
      }
      
      return { action, requirement_id, kind, backlog };
    }
    case 'upsert': {
      if (!params.title || !params.kind || !params.phase_id || !Array.isArray(params.acceptance) || params.acceptance.length === 0) {
        throw new Error('upsert requires title, kind, phase_id, acceptance[]');
      }
      const { backlog } = await listBacklog(requirement_id);
      if (isBacklogComplete(backlog?.items || [])) {
        const reopened = await isRequirementReopened(requirement_id);
        const userRequested = await hasUserRequestedMoreWork(requirement_id);
        if (!reopened && !userRequested) {
          throw new Error(
            'Backlog cerrado: el requirement está en cooldown (todos los items entregables están completados y nunca fue reabierto). ' +
            'Llama `requirement_status stage=\'on-review\' message=\'Project complete\'` y termina el turno. ' +
            'Si el usuario pidió trabajo extra, reabre explícitamente el proyecto usando: ' +
            'requirements.update(requirement_id=..., completion_status=\'pending\', status=\'in-progress\') + ' +
            'requirement_status(stage=\'in-progress\', message=\'reopen: <motivo>\'). ' +
            'NO crees un requirement nuevo ni agregues items sin reabrir.'
          );
        }
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
      
      // Fix #4: Protect done items from silent reopens
      const { backlog } = await listBacklog(requirement_id);
      const existingItem = backlog?.items?.find((i: any) => i.id === params.item_id);
      if (existingItem?.status === 'done' && params.status !== 'done' && !params.confirm_reopen) {
        throw new Error(
          'Reapertura bloqueada: este item está en estado "done". ' +
          'Si realmente necesitas reabrirlo por un bug o cambio, debes reabrir explícitamente el requirement ' +
          'usando requirements.update(completion_status=\'pending\', status=\'in-progress\') y luego ' +
          'llamar a set_status pasando confirm_reopen=true y un reason detallado.'
        );
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
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
