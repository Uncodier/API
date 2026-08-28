import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  countRecentRespawns,
  evaluateInstanceStall,
  LOOKBACK_MS,
  spawnSilentContinueWorkflow,
} from '@/lib/services/robot-instance/assistant-respawn';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const STALL_LOG_TYPES = ['user_action', 'agent_action', 'thinking', 'tool_call', 'infrastructure'];

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET?.trim()}`) {
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

      const lastLog = logs.find((row) => row.log_type !== 'infrastructure');
      const siteId = lastLog?.site_id;
      if (!siteId) {
        results.push({ instance_id: instanceId, status: 'skipped_no_site_id' });
        continue;
      }

      console.log(`[CronAssistantRespawn] Stall detected for instance ${instanceId}. Respawning (${recentRespawnCount + 1})`);
      await spawnSilentContinueWorkflow({
        instanceId,
        siteId,
        userId: lastLog?.user_id || '',
      });

      results.push({ instance_id: instanceId, status: 'respawned' });
    } catch (err: any) {
      console.error(`[CronAssistantRespawn] Error processing instance ${instanceId}:`, err);
      results.push({ instance_id: instanceId, status: `error: ${err.message}` });
    }
  }

  return NextResponse.json({ message: `Processed ${results.length} active instances`, results });
}
