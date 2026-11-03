import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { DB_EVENT_TABLES } from './types';
import { materializeRunFromGraph } from './materialize';
import { runWorkflowPlan } from './run-plan';
import { matchesFilter } from './filter';
import { assertProcurementWorkflowActorAccess, isProcurementWorkflowTable } from './procurement-access';

export { matchesFilter };

export interface DispatchEvent {
  table: string;
  op: 'insert' | 'update' | 'delete';
  row: Record<string, unknown>;
  site_id: string;
  instance_id?: string;
  /** Identity of one DB mutation, preserved verbatim across delivery retries. */
  event_id?: string;
}

function eventIdentity(event: DispatchEvent): string {
  if (typeof event.event_id === 'string' && event.event_id.trim()) {
    return `event:${event.event_id.trim()}`;
  }
  // Legacy direct emitters have no mutation UUID. Hash the complete snapshot,
  // including created_at/updated_at (not just row.id), with stable object order.
  // JSON's normal array order and toJSON handling are retained.
  const canonical = JSON.stringify(event.row, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return sorted;
  });
  return `snapshot:${createHash('sha256').update(canonical).digest('hex')}`;
}

export async function dispatchWorkflowEvent(event: DispatchEvent): Promise<{ started: number; skipped: number }> {
  if (!DB_EVENT_TABLES.includes(event.table as (typeof DB_EVENT_TABLES)[number])) {
    return { started: 0, skipped: 0 };
  }

  let query = supabaseAdmin
    .from('workflow_triggers')
    .select('id, instance_id, template_plan_id, config, site_id')
    .eq('site_id', event.site_id)
    .eq('kind', 'db_event')
    .eq('enabled', true);

  if (event.instance_id) query = query.eq('instance_id', event.instance_id);

  const { data: triggers, error } = await query;
  if (error || !triggers?.length) return { started: 0, skipped: 0 };

  let started = 0;
  let skipped = 0;
  const identity = eventIdentity(event);

  for (const trigger of triggers) {
    const cfg = (trigger.config || {}) as { 
      table?: string; 
      op?: string | string[]; 
      filter?: Record<string, unknown>;
      db_events?: { table: string; op: string[] }[];
    };
    
    let matchesTableEvent = false;
    
    if (Array.isArray(cfg.db_events)) {
      matchesTableEvent = cfg.db_events.some(
        (ev) => ev.table === event.table && ev.op.includes(event.op)
      );
    } else {
      const ops = Array.isArray(cfg.op) ? cfg.op : cfg.op ? [cfg.op] : [];
      const matchesTable = cfg.table ? cfg.table === event.table : false;
      const matchesOp = ops.length === 0 || ops.includes(event.op);
      matchesTableEvent = matchesTable && matchesOp;
    }
    
    if (!matchesTableEvent) {
      skipped++;
      continue;
    }
    
    if (!matchesFilter(event.row, cfg.filter)) {
      skipped++;
      continue;
    }

    // Distinct mutations and distinct triggers must not collapse to one run,
    // even when they operate on the same row or share a template plan.
    const idempotency_key = `${event.table}:${event.op}:${trigger.id}:${identity}`;

    try {
      if (isProcurementWorkflowTable(event.table)) {
        const { data: instance, error: instanceError } = await supabaseAdmin
          .from('remote_instances')
          .select('user_id')
          .eq('id', trigger.instance_id)
          .eq('site_id', event.site_id)
          .single();
        if (instanceError || !instance?.user_id) throw new Error('Procurement workflow actor is required');
        await assertProcurementWorkflowActorAccess(event.site_id, instance.user_id);
      }
      const materialized = await materializeRunFromGraph({
        instance_id: trigger.instance_id,
        trigger_id: trigger.id,
        trigger_payload: { table: event.table, op: event.op, ...(event.event_id ? { event_id: event.event_id } : {}), [event.table.replace(/s$/, '')]: event.row, row: event.row },
        idempotency_key,
      });
      if (materialized.steps.length === 0 && materialized.run_plan_id) {
        if (!materialized.resume_existing_run) {
          skipped++;
          continue;
        }
      }
      started++;
      void runWorkflowPlan(materialized.run_plan_id).catch((err) => {
        console.error(`[WorkflowDispatch] run failed for ${materialized.run_plan_id}:`, err);
      });
    } catch (err) {
      console.error('[WorkflowDispatch] materialize failed:', err);
      skipped++;
    }
  }

  return { started, skipped };
}

export function fireWorkflowDispatch(event: DispatchEvent): void {
  void dispatchWorkflowEvent(event).catch((err) => {
    console.error('[WorkflowDispatch] background dispatch failed:', err);
  });
}
