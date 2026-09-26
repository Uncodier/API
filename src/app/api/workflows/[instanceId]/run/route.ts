import { NextRequest, NextResponse } from 'next/server';
import { materializeRunFromGraph } from '@/lib/services/workflow-robot/materialize';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';
import { authorizeWorkflowInstanceWrite } from '@/lib/services/workflow-robot/route-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    const denied = await authorizeWorkflowInstanceWrite(request, instanceId);
    if (denied) return denied;
    // A generic LIVE run does not pick a trigger branch. Never turn a
    // channel_message workflow into a tool-capable manual run, including in
    // the window between graph edits and trigger synchronization.
    const { data: channelTriggers, error: triggerError } = await supabaseAdmin
      .from('workflow_triggers').select('id').eq('instance_id', instanceId)
      .eq('kind', 'channel_message').limit(1);
    if (triggerError) throw triggerError;
    const { data: triggerNodes, error: nodeError } = await supabaseAdmin
      .from('instance_nodes').select('settings').eq('instance_id', instanceId).eq('type', 'wf-trigger');
    if (nodeError) throw nodeError;
    if (channelTriggers?.length || triggerNodes?.some(({ settings }) => {
      const cfg = settings?.trigger || settings || {};
      return cfg.kind === 'channel_message' ||
        (Array.isArray(cfg.active_kinds) && cfg.active_kinds.includes('channel_message'));
    })) {
      return NextResponse.json({ error: 'Channel message workflows cannot be run manually' }, { status: 400 });
    }
    const body = await request.json().catch(() => ({}));
    const materialized = await materializeRunFromGraph({
      instance_id: instanceId,
      trigger_payload: body.payload || {},
      dry_run: false,
      from_step_id: body.from_step_id,
    });
    const result = await runWorkflowPlan(materialized.run_plan_id);
    return NextResponse.json({ success: true, ...materialized, ...result });
  } catch (error: any) {
    console.error('[WorkflowRun]', error);
    return NextResponse.json({ success: false, error: 'Failed to run workflow' }, { status: 500 });
  }
}
