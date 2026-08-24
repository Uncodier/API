import { supabaseAdmin } from '@/lib/database/supabase-client';
import { DB_EVENT_TABLES } from './types';
import { materializeRunFromGraph } from './materialize';
import { runWorkflowPlan } from './run-plan';
import { matchesFilter } from './filter';

export { matchesFilter };

export interface DispatchEvent {
  table: string;
  op: 'insert' | 'update' | 'delete';
  row: Record<string, unknown>;
  site_id: string;
  instance_id?: string;
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

  for (const trigger of triggers) {
    const cfg = (trigger.config || {}) as { table?: string; op?: string; filter?: Record<string, unknown> };
    if (cfg.table && cfg.table !== event.table) {
      skipped++;
      continue;
    }
    if (cfg.op && cfg.op !== event.op) {
      skipped++;
      continue;
    }
    if (!matchesFilter(event.row, cfg.filter)) {
      skipped++;
      continue;
    }

    const rowId = String(event.row.id || '');
    const idempotency_key = `${event.table}:${event.op}:${rowId}:${trigger.template_plan_id || trigger.id}`;

    try {
      const materialized = await materializeRunFromGraph({
        instance_id: trigger.instance_id,
        trigger_id: trigger.id,
        trigger_payload: { table: event.table, op: event.op, [event.table.replace(/s$/, '')]: event.row, row: event.row },
        idempotency_key,
      });
      if (materialized.steps.length === 0 && materialized.run_plan_id) {
        skipped++;
        continue;
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
