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

export const maxDuration = 800; // Máximo permitido en plan pro (limitado por Vercel)
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
      .select('*, backlog')
      .in('status', ['in-progress', 'on-review'])
      .gte('updated_at', oneWeekAgo)
      .order('updated_at', { ascending: false })
      .limit(10); // increased limit since we'll filter some out

    if (error) throw error;
    if (!requirements || requirements.length === 0) {
      return NextResponse.json({ message: 'No requirements to maintain' });
    }

    const results = [];

    for (const requirement of requirements) {
      const { id: reqId, title, instructions, type, site_id, user_id } = requirement;
      
      const allBacklogDone = requirement.backlog?.items?.length > 0 && requirement.backlog.items.filter((i: any) => (i.tier ?? 'core') === 'core').every((i: any) => i.status === 'done' || i.status === 'needs_review');
      
      // If the requirement is on-review AND all core items are done, it means the main builder is cooling down.
      // QA should respect this cooldown so it doesn't run indefinitely.
      if (requirement.status === 'on-review' && allBacklogDone) {
         console.log(`[Cron Maintenance] Skipping ${reqId} — requirement is on-review and backlog is done (respecting cooldown)`);
         results.push({ reqId, skipped: true, reason: 'on-review_cooldown' });
         continue;
      }
      
      // Use a distinct lock key so it doesn't block the main builder cron
      const maintenanceLockKey = `${reqId}-maint`;
      const runLock = await acquireRunLock(maintenanceLockKey);
      
      if (!runLock) {
        console.log(`[Cron Maintenance] Skipping ${reqId} — maintenance already running`);
        results.push({ reqId, skipped: true, reason: 'locked' });
        continue;
      }

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
      }

      let hasActivePlan = false;
      if (instanceId) {
        const { data: activePlan } = await supabaseAdmin
          .from('instance_plans')
          .select('id')
          .eq('instance_id', instanceId)
          .in('status', ['pending', 'in_progress'])
          .limit(1)
          .single();
        if (activePlan) {
          hasActivePlan = true;
        }
      }

      // Verify QA execution limit
      const doneItemsCount = requirement.backlog?.items?.filter((i: any) => i.status === 'done').length || 0;
      const maxQaRuns = Math.max(2, doneItemsCount); // Max 2 runs if 0/1 items, else 1 run per done item
      const currentQaRuns = requirement.metadata?.qa_successful_runs || 0;
      
      const currentAttempt = requirement.metadata?.cron_attempts || 0;
      const lastQaAttempt = requirement.metadata?.qa_last_attempt_sync || -1;
      
      let mainInstanceActivityMs = 0;
      const runnerInstanceId = requirement.metadata?.runner_instance_id;
      if (runnerInstanceId) {
        const { data: latestLog } = await supabaseAdmin
          .from('instance_logs')
          .select('created_at')
          .eq('instance_id', runnerInstanceId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        if (latestLog) {
          mainInstanceActivityMs = new Date(latestLog.created_at).getTime();
        }
      }
      
      const lastQaActivitySync = requirement.metadata?.qa_last_activity_sync || 0;
      
      if (!hasActivePlan && lastQaAttempt === currentAttempt && lastQaActivitySync >= mainInstanceActivityMs) {
        console.log(`[Cron Maintenance] Skipping ${reqId} — QA already ran for main builder attempt ${currentAttempt} and no recent activity. No active plan.`);
        
        if (instanceId) {
          await supabaseAdmin.from('remote_instances').update({ status: 'pending' }).eq('id', instanceId);
        }

        results.push({ reqId, skipped: true, reason: 'qa_already_run_for_attempt_no_plan' });
        await releaseRunLock(maintenanceLockKey, runLock.runId);
        continue;
      }
      
      // Limit applies regardless of hasActivePlan to prevent perpetual plan loops in QA
      if (currentQaRuns >= maxQaRuns && doneItemsCount > 0) {
        console.log(`[Cron Maintenance] Skipping ${reqId} — reached limit of ${maxQaRuns} successful QA runs (${doneItemsCount} done items).`);
        results.push({ reqId, skipped: true, reason: 'qa_limit_reached' });
        
        if (instanceId) {
          await supabaseAdmin.from('remote_instances').update({ status: 'pending' }).eq('id', instanceId);
        }
        
        // Also cancel any active plan since we hit the hard limit
        if (hasActivePlan) {
           await supabaseAdmin.from('instance_plans').update({ status: 'cancelled' }).eq('instance_id', instanceId).in('status', ['pending', 'in_progress']);
        }
        
        await releaseRunLock(maintenanceLockKey, runLock.runId);
        continue;
      }

      console.log(`[Cron Maintenance] Processing ${reqId}: ${title}`);

      // Update the sync tracker so it doesn't run again for this main workflow cycle
      const updatedMetadata = { 
        ...requirement.metadata, 
        qa_last_attempt_sync: currentAttempt,
        qa_last_activity_sync: mainInstanceActivityMs
      };
      await supabaseAdmin.from('requirements').update({ metadata: updatedMetadata }).eq('id', reqId);
      requirement.metadata = updatedMetadata;

      // Create instance if not found
      if (!instanceId) {
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

      // Validate instance and plan are not paused, otherwise put them in play
      const { data: instanceData } = await supabaseAdmin
        .from('remote_instances')
        .select('status')
        .eq('id', instanceId)
        .single();

      const { data: activePlan } = await supabaseAdmin
        .from('instance_plans')
        .select('id, status')
        .eq('instance_id', instanceId)
        .in('status', ['pending', 'in_progress', 'paused'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Permitir que QA corra incluso si estaba pausado (lo reanudamos)
      if (instanceData && instanceData.status !== 'running') {
        await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', instanceId);
      }
      if (activePlan && activePlan.status !== 'in_progress') {
        await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', activePlan.id);
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
