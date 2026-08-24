import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { materializeRunFromGraph } from '@/lib/services/workflow-robot/materialize';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';
import { isCronDueInWindow } from '@/lib/services/workflow-robot/cron-window';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET?.trim()}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: triggers, error } = await supabaseAdmin
    .from('workflow_triggers')
    .select('id, instance_id, template_plan_id, config, site_id')
    .eq('kind', 'cron')
    .eq('enabled', true)
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: Array<{ trigger_id: string; started?: boolean; skipped?: string }> = [];
  const now = Date.now();

  for (const trigger of triggers || []) {
    const cron = (trigger.config as { cron?: string })?.cron;
    if (!cron) {
      results.push({ trigger_id: trigger.id, skipped: 'missing_cron' });
      continue;
    }
    try {
      if (!isCronDueInWindow(cron, now)) {
        results.push({ trigger_id: trigger.id, skipped: 'not_due' });
        continue;
      }
      const windowKey = `${trigger.id}:${new Date(now).toISOString().slice(0, 16)}`;
      const materialized = await materializeRunFromGraph({
        instance_id: trigger.instance_id,
        trigger_id: trigger.id,
        trigger_payload: { kind: 'cron', cron, fired_at: new Date().toISOString() },
        idempotency_key: `cron:${windowKey}`,
      });
      void runWorkflowPlan(materialized.run_plan_id).catch((err) => {
        console.error(`[CronWorkflows] run failed ${materialized.run_plan_id}:`, err);
      });
      results.push({ trigger_id: trigger.id, started: true });
    } catch (err: any) {
      console.error(`[CronWorkflows] trigger ${trigger.id}:`, err);
      results.push({ trigger_id: trigger.id, skipped: err.message });
    }
  }

  return NextResponse.json({ message: `Processed ${results.length} cron triggers`, results });
}
