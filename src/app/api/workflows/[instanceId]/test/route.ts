import { NextRequest, NextResponse } from 'next/server';
import { materializeRunFromGraph } from '@/lib/services/workflow-robot/materialize';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canAccessSite } from '@/lib/security/site-access';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import { authorizeWorkflowInstanceWrite } from '@/lib/services/workflow-robot/route-access';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    const body = await request.json().catch(() => ({}));
    if (!hasAuthenticatedPrincipal(request) || !/^[\da-f-]{36}$/i.test(instanceId)) {
      return NextResponse.json({ error: 'Authentication is required' }, { status: 401 });
    }
    const { data: instance, error: instanceError } = await supabaseAdmin.from('remote_instances')
      .select('site_id').eq('id', instanceId).maybeSingle();
    if (instanceError || !instance || !await canAccessSite(request, instance.site_id)) {
      return NextResponse.json({ error: 'Workflow is not accessible' }, { status: 403 });
    }
    const denied = await authorizeWorkflowInstanceWrite(request, instanceId);
    if (denied) return denied;
    const isChannelTest = body.payload?.source === 'channel_message';
    let channelTriggerId: string | undefined;
    if (isChannelTest) {
      if (typeof body.payload?.trigger_id !== 'string') {
        return NextResponse.json({ error: 'trigger_id is required' }, { status: 400 });
      }
      const { data: trigger, error } = await supabaseAdmin.from('workflow_triggers')
        .select('id, site_id').eq('node_id', body.payload.trigger_id)
        .eq('instance_id', instanceId).eq('kind', 'channel_message').maybeSingle();
      if (error || !trigger || trigger.site_id !== instance.site_id) {
        return NextResponse.json({ error: 'Trigger is not accessible' }, { status: 403 });
      }
      channelTriggerId = trigger.id;
    } else {
      // Do not allow a generic test of a channel graph to bypass the
      // pre-response-only tool policy by omitting `source` or `trigger_id`.
      const { data: channelTriggers, error } = await supabaseAdmin.from('workflow_triggers')
        .select('id').eq('instance_id', instanceId).eq('kind', 'channel_message').limit(1);
      if (error || channelTriggers?.length) {
        return NextResponse.json({ error: 'Select a channel_message trigger to test this workflow' }, { status: 400 });
      }
      // A graph edit can precede trigger sync. Do not allow the generic test
      // runner to bypass the pre-response tool policy during that window.
      const { data: triggerNodes, error: nodeError } = await supabaseAdmin.from('instance_nodes')
        .select('settings').eq('instance_id', instanceId).eq('type', 'wf-trigger');
      if (nodeError || triggerNodes?.some(({ settings }) => {
        const cfg = settings?.trigger || settings || {};
        return cfg.kind === 'channel_message' ||
          (Array.isArray(cfg.active_kinds) && cfg.active_kinds.includes('channel_message'));
      })) {
        return NextResponse.json({ error: 'Select a channel_message trigger to test this workflow' }, { status: 400 });
      }
    }
    const materialized = await materializeRunFromGraph({
      instance_id: instanceId,
      trigger_payload: body.payload || { test: true },
      dry_run: true,
      ...(channelTriggerId ? { trigger_id: channelTriggerId, pre_response_only: true } : {}),
    });
    const result = await runWorkflowPlan(materialized.run_plan_id);
    if (result.status !== 'completed') {
      return NextResponse.json(
        { success: false, error: 'Workflow test did not complete', ...materialized, ...result },
        { status: result.status === 'already_running' ? 409 : 422 },
      );
    }
    return NextResponse.json({ success: true, ...materialized, ...result });
  } catch (error: any) {
    console.error('[WorkflowTest]', error);
    return NextResponse.json({ success: false, error: error.message || 'Test failed' }, { status: 500 });
  }
}
