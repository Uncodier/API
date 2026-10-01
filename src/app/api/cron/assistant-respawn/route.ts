import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  countRecentRespawns,
  evaluateInstanceStall,
  LOOKBACK_MS,
  spawnSilentContinueWorkflow,
} from '@/lib/services/robot-instance/assistant-respawn';
import { isRespawnManagedPlan } from '@/lib/services/workflow-robot/plan-ownership';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const STALL_LOG_TYPES = ['user_action', 'agent_action', 'thinking', 'tool_call', 'infrastructure'];

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowMs = Date.now();
  const since = new Date(nowMs - LOOKBACK_MS).toISOString();

  const { data: recentLogs, error } = await supabaseAdmin
    .from('instance_logs')
    .select('instance_id')
    .in('log_type', STALL_LOG_TYPES)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(2000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const activeInstanceIds = Array.from(new Set((recentLogs || []).map((log) => log.instance_id).filter(Boolean)));
  const results: Array<{ instance_id: string; status: string }> = [];

  for (const instanceId of activeInstanceIds) {
    try {
      const { data: logs, error: logsError } = await supabaseAdmin
        .from('instance_logs')
        .select('log_type, message, created_at, details, site_id, user_id')
        .eq('instance_id', instanceId)
        .in('log_type', STALL_LOG_TYPES)
        .order('created_at', { ascending: false })
        .limit(10);

      if (logsError || !logs || logs.length === 0) continue;

      // A tail of tool logs is not authorization to resume a stopped/old task.
      const { data: action, error: actionError } = await supabaseAdmin
        .from('instance_logs').select('id,site_id,user_id,details,created_at')
        .eq('instance_id', instanceId).eq('log_type', 'user_action')
        .eq('trusted_user_action', true).order('created_at', { ascending: false })
        .limit(1).maybeSingle();
      if (actionError || !action?.id || !action.site_id || !action.user_id
        || action.details?.status !== 'running' || !action.details?.assistant_recovery) {
        results.push({ instance_id: instanceId, status: 'skipped_no_active_checkpoint' });
        continue;
      }

      const recentRespawnCount = await countRecentRespawns(instanceId);
      const decision = evaluateInstanceStall({
        logs,
        nowMs,
        recentRespawnCount,
      });

      if (decision !== 'respawn') {
        results.push({ instance_id: instanceId, status: decision });
        continue;
      }

      const { data: activePlan, error: activePlanError } = await supabaseAdmin
        .from('instance_plans')
        .select('metadata')
        .eq('instance_id', instanceId)
        .in('status', ['pending', 'in_progress', 'active', 'paused'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (activePlanError) {
        results.push({ instance_id: instanceId, status: 'skipped_plan_lookup_error' });
        continue;
      }
      if (isRespawnManagedPlan(activePlan)) {
        results.push({ instance_id: instanceId, status: 'skipped_workflow_managed' });
        continue;
      }

      console.log(`[CronAssistantRespawn] Stall detected for instance ${instanceId}. Respawning (${recentRespawnCount + 1})`);
      const spawned = await spawnSilentContinueWorkflow({
        instanceId,
        siteId: action.site_id,
        userId: action.user_id,
        userMessageLogId: action.id,
      });

      results.push({ instance_id: instanceId, status: spawned ? 'respawned' : 'skipped_unsafe_checkpoint' });
    } catch (err: any) {
      console.error(`[CronAssistantRespawn] Recovery check failed for instance ${instanceId}`);
      results.push({ instance_id: instanceId, status: 'recovery_check_failed' });
    }
  }

  return NextResponse.json({ message: `Processed ${results.length} active instances`, results });
}
