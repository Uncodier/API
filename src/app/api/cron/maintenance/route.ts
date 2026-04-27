import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runMaintenanceWorkflow } from './workflow';
import { acquireRunLock, getSupabaseUrlHostForLogs, releaseRunLock } from '../shared/cron-run-lock';

/** Instance type for maintenance runners to keep them separate from main builders */
const REMOTE_INSTANCE_TYPE_MAINTENANCE = 'browser' as const;

function maintenanceRemoteInstancePayload(base: {
  site_id: string;
  user_id: string;
  name: string;
  created_by: string;
}) {
  return {
    ...base,
    status: 'pending' as const,
    instance_type: REMOTE_INSTANCE_TYPE_MAINTENANCE,
    provider_instance_id: null as string | null,
    cdp_url: null as string | null,
  };
}

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('[Cron Maintenance] Starting maintenance cycle');

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Look for requirements that are active or recently finished.
    // The maintenance orchestrator will specifically look for `done` items in their backlog.
    const { data: requirements, error } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .in('status', ['in-progress', 'done'])
      .gte('updated_at', oneWeekAgo)
      .order('updated_at', { ascending: false })
      .limit(3);

    if (error) throw error;
    if (!requirements || requirements.length === 0) {
      return NextResponse.json({ message: 'No requirements to maintain' });
    }

    const results = [];

    for (const requirement of requirements) {
      const { id: reqId, title, instructions, type, site_id, user_id } = requirement;
      
      // Use a distinct lock key so it doesn't block the main builder cron
      const maintenanceLockKey = `${reqId}-maint`;
      const runLock = await acquireRunLock(maintenanceLockKey);
      
      if (!runLock) {
        console.log(`[Cron Maintenance] Skipping ${reqId} — maintenance already running`);
        results.push({ reqId, skipped: true, reason: 'locked' });
        continue;
      }

      console.log(`[Cron Maintenance] Processing ${reqId}: ${title}`);

      // Find or create a dedicated remote_instance for maintenance
      let instanceId: string | undefined;
      const instanceName = `req-maint-${reqId}`;
      
      const { data: instances } = await supabaseAdmin
        .from('remote_instances')
        .select('id')
        .eq('site_id', site_id)
        .eq('name', instanceName)
        .limit(1);

      if (instances && instances.length > 0) {
        instanceId = instances[0].id;
      } else {
        const { data: newInstance, error: insertErr } = await supabaseAdmin
          .from('remote_instances')
          .insert(
            maintenanceRemoteInstancePayload({
              site_id,
              user_id,
              name: instanceName,
              created_by: user_id,
            }),
          )
          .select('id')
          .single();
        if (insertErr) console.error('[Cron Maintenance] Error inserting remote_instance:', insertErr);
        instanceId = newInstance?.id;
      }

      if (!instanceId) {
        console.error(`[Cron Maintenance] Failed to create or find remote_instance for req ${reqId}`);
        results.push({ reqId, error: 'Failed to create or find remote_instance' });
        await releaseRunLock(maintenanceLockKey, runLock.runId);
        continue;
      }

      try {
        const workflowRun = await start(runMaintenanceWorkflow, [{
          reqId,
          title,
          instructions,
          type,
          site_id,
          user_id,
          instanceId,
          previousWorkContext: '', // Maintenance doesn't strictly need the main builder's blocker context
          instance_type: type,
          cronLockRunId: runLock.runId,
          maintenanceLockKey,
        }]);

        results.push({ reqId, runId: workflowRun.runId, started: true });
      } catch (err: any) {
        console.error(`[Cron Maintenance] Error starting workflow for req ${reqId}:`, err);
        results.push({ reqId, error: err?.message || 'Failed to start workflow' });
        await releaseRunLock(maintenanceLockKey, runLock.runId);
      }
    }

    return NextResponse.json({
      message: `Processed ${results.length} requirements for maintenance`,
      results,
    });

  } catch (e: any) {
    console.error(`[Cron Maintenance] Top-level error:`, e?.message || e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
