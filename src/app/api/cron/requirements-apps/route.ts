import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runCronAppsWorkflow } from './workflow';
import { runMaintenanceWorkflow } from '../maintenance/workflow';
import { acquireRunLock, getSupabaseUrlHostForLogs, releaseRunLock } from '../shared/cron-run-lock';

/** Must match DB check `remote_instances_instance_type_check` (ubuntu | browser | windows). */
const REMOTE_INSTANCE_TYPE_CRON_APPS = 'browser' as const;
const REMOTE_INSTANCE_TYPE_MAINTENANCE = 'browser' as const;

/** Cron runners use Vercel Sandbox workflows — not Scrapybara; keep provider/CDP null. */
function cronRemoteInstancePayload(base: {
  site_id: string;
  user_id: string;
  name: string;
  created_by: string;
  instance_type?: string;
}) {
  return {
    ...base,
    status: 'pending' as const,
    instance_type: base.instance_type || REMOTE_INSTANCE_TYPE_CRON_APPS,
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
    console.log('[Cron Apps] cron debug env', {
      supabaseHost: getSupabaseUrlHostForLogs(),
      supabaseServiceUrlFromEnv: Boolean(process.env.SUPABASE_URL),
      hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      keyStart: process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 15),
      keyEnd: process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(-10),
      keyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length,
      vercelEnv: process.env.VERCEL_ENV ?? 'local',
      vercelUrl: process.env.VERCEL_URL ?? null,
      requestUrl: req.url,
    });

    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Flow-agnostic: the cron picks any requirement kind (app/site/doc/slides/
    // contract/automation/task/makinari). The orchestrator resolves the flow
    // from `requirement.type` via `requirement-flow-engine.ts` and drives the
    // correct phases/gates. Legacy `requirements-automations` cron remains for
    // back-compat and will be deprecated separately.
    const { data: requirements, error } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .in('status', ['backlog', 'in-progress'])
      .or(`created_at.gte.${oneMonthAgo},updated_at.gte.${oneMonthAgo}`)
      .order('updated_at', { ascending: false })
      .limit(3);

    if (error) throw error;
    if (!requirements || requirements.length === 0) {
      return NextResponse.json({ message: 'No app requirements to process' });
    }

    const results = [];

    for (const requirement of requirements) {
      const { id: reqId, title, instructions, type, site_id, user_id } = requirement;
      console.log('[Cron Apps] cron debug pick', {
        reqId,
        status: requirement.status,
        type,
      });

      // Per-requirement advisory lock: prevents two overlapping ticks from
      // launching parallel workflows on the same requirement. Without this we
      // hit `! [rejected] non-fast-forward` on push and clobber sandbox files.
      const runLock = await acquireRunLock(reqId);
      console.log('[Cron Apps] cron debug lock', {
        reqId,
        acquired: runLock != null,
        runId: runLock?.runId ?? null,
      });
      if (!runLock) {
        console.log(`[Cron Apps] Skipping ${reqId} — another workflow is already running (lock held)`);
        results.push({
          reqId,
          skipped: true,
          reason: 'locked',
        });
        continue;
      }

      console.log(`[Cron Apps] Processing requirement ${reqId}: ${title} (lock runId=${runLock.runId})`);

        const currentAttempts = requirement.metadata?.cron_attempts || 0;
      if (currentAttempts >= 10) {
        console.log(`[Cron Apps] Skipping ${reqId} — blocked due to 10 consecutive failures without progress. Triggering QA.`);
        
        // We need to get the latest error/status to send to QA
        const { data: latestStatus } = await supabaseAdmin
          .from('requirement_status')
          .select('message, stage')
          .eq('requirement_id', reqId)
          .order('created_at', { ascending: false })
          .limit(1);
          
        const errorMessage = latestStatus?.[0]?.message || 'Unknown error after 10 attempts';
        const errorSummary = `The main builder failed 10 consecutive times. Last error: ${errorMessage}. YOUR PRIORITY IS TO FIX THIS ERROR. Ignore the "only audit done items" rule for this run and focus on unblocking the main builder by fixing the build/runtime error.`;

        await supabaseAdmin.from('requirements').update({ 
          status: 'blocked',
          updated_at: new Date().toISOString()
        }).eq('id', reqId);
        
        // Verify QA execution limit
        const doneItemsCount = requirement.backlog?.items?.filter((i: any) => i.status === 'done').length || 0;
        const maxQaRuns = doneItemsCount * 3;
        const currentQaRuns = requirement.metadata?.qa_successful_runs || 0;
        
        if (currentQaRuns >= maxQaRuns && doneItemsCount > 0) {
          console.log(`[Cron Apps] Skipping QA workflow for blocked req ${reqId} — reached limit of ${maxQaRuns} successful QA runs (${doneItemsCount} done items)`);
          await releaseRunLock(reqId, runLock.runId);
          results.push({ reqId, skipped: true, reason: 'qa_limit_reached' });
          continue;
        }
        
        // Trigger QA workflow before continuing
        const maintenanceLockKey = `${reqId}-maint`;
        const maintRunLock = await acquireRunLock(maintenanceLockKey);
        
        if (maintRunLock) {
          console.log(`[Cron Apps] Starting QA workflow for blocked req ${reqId}`);
          
          let maintInstanceId: string | undefined;
          const maintInstanceName = `req-maint-${reqId}`;
          
          const { data: maintInstances } = await supabaseAdmin
            .from('remote_instances')
            .select('id')
            .eq('site_id', site_id)
            .eq('name', maintInstanceName)
            .limit(1);

          if (maintInstances && maintInstances.length > 0) {
            maintInstanceId = maintInstances[0].id;
          } else {
            const { data: newMaintInstance } = await supabaseAdmin
              .from('remote_instances')
              .insert(
                cronRemoteInstancePayload({
                  site_id,
                  user_id,
                  name: maintInstanceName,
                  created_by: user_id,
                  instance_type: REMOTE_INSTANCE_TYPE_MAINTENANCE,
                }),
              )
              .select('id')
              .single();
            maintInstanceId = newMaintInstance?.id;
          }

          if (maintInstanceId) {
            // Validate maintenance instance and plan are not paused, otherwise put them in play
            const { data: maintInstanceData } = await supabaseAdmin
              .from('remote_instances')
              .select('status')
              .eq('id', maintInstanceId)
              .single();

            const { data: maintActivePlan } = await supabaseAdmin
              .from('instance_plans')
              .select('id, status')
              .eq('instance_id', maintInstanceId)
              .in('status', ['pending', 'in_progress', 'paused'])
              .order('created_at', { ascending: false })
              .limit(1)
              .single();

            if (maintInstanceData?.status === 'paused' || maintActivePlan?.status === 'paused') {
              console.log(`[Cron Apps] QA workflow for ${reqId} — maintenance instance or plan was paused, resuming it.`);
              if (maintInstanceData?.status === 'paused') {
                await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', maintInstanceId);
              }
              if (maintActivePlan?.status === 'paused') {
                await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', maintActivePlan.id);
              }
            }
            
            {
              if (maintInstanceData && maintInstanceData.status !== 'running') {
                await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', maintInstanceId);
              }
              if (maintActivePlan && maintActivePlan.status !== 'in_progress') {
                await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', maintActivePlan.id);
              }

              try {
                const maintWorkflowRun = await start(runMaintenanceWorkflow, [{
                  reqId,
                  title,
                  instructions,
                  type,
                  site_id,
                  user_id,
                  instanceId: maintInstanceId,
                  previousWorkContext: errorSummary,
                  instance_type: type,
                  cronLockRunId: maintRunLock.runId,
                  maintenanceLockKey,
                }]);

                results.push({ reqId, runId: maintWorkflowRun.runId, started: true, type: 'qa_blocked' });
              } catch (err: any) {
                console.error(`[Cron Apps] Error starting QA workflow for blocked req ${reqId}:`, err);
                await releaseRunLock(maintenanceLockKey, maintRunLock.runId);
              }
            }
          } else {
            await releaseRunLock(maintenanceLockKey, maintRunLock.runId);
          }
        }

        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'blocked_circuit_breaker_qa_triggered' });
        continue;
      }

      // Find or create remote_instance for MAIN BUILDER
      let instanceId: string | undefined = requirement.metadata?.runner_instance_id;
      
      if (!instanceId) {
        // 1. Look up the main builder instance by its canonical name
        const { data: instances } = await supabaseAdmin
          .from('remote_instances')
          .select('id, instance_type')
          .eq('site_id', site_id)
          .eq('name', `req-runner-${reqId}`)
          .limit(1);

        if (instances && instances.length > 0) {
          instanceId = instances[0].id;
          if (!instances[0].instance_type) {
            await supabaseAdmin.from('remote_instances').update({ instance_type: REMOTE_INSTANCE_TYPE_CRON_APPS }).eq('id', instanceId);
          }
        } else {
          // 2. Fallback for legacy instances (before req-runner- naming convention)
          // We must ensure we don't accidentally pick up a maintenance instance.
          const { data: prevStatusForInstance } = await supabaseAdmin
            .from('requirement_status')
            .select('instance_id')
            .eq('requirement_id', reqId)
            .not('instance_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(10);

          if (prevStatusForInstance && prevStatusForInstance.length > 0) {
            // Fetch the names of these instances to filter out maintenance ones
            const instanceIds = prevStatusForInstance.map(s => s.instance_id);
            const { data: legacyInstances } = await supabaseAdmin
              .from('remote_instances')
              .select('id, name')
              .in('id', instanceIds)
              .not('name', 'like', 'req-maint-%');
              
            if (legacyInstances && legacyInstances.length > 0) {
              // Use the most recent non-maintenance instance
              const validIds = new Set(legacyInstances.map(i => i.id));
              const mostRecentValid = prevStatusForInstance.find(s => validIds.has(s.instance_id));
              if (mostRecentValid) {
                instanceId = mostRecentValid.instance_id;
              }
            }
          }

          // 3. If still no valid instance found, create a new one
          if (!instanceId) {
            const { data: newInstance, error: insertErr } = await supabaseAdmin
              .from('remote_instances')
              .insert(
                cronRemoteInstancePayload({
                  site_id,
                  user_id,
                  name: `req-runner-${reqId}`,
                  created_by: user_id,
                }),
              )
              .select('id')
              .single();
            if (insertErr) console.error('[Cron Apps] Error inserting remote_instance:', insertErr);
            instanceId = newInstance?.id;
          }
        }
      }

      const updatedMetadata = { 
        ...requirement.metadata, 
        cron_attempts: currentAttempts + 1 
      };
      if (instanceId) {
        updatedMetadata.runner_instance_id = instanceId;
      }

      if (requirement.status === 'backlog') {
        await supabaseAdmin.from('requirements').update({ 
          status: 'in-progress',
          metadata: updatedMetadata
        }).eq('id', reqId);
      } else {
        await supabaseAdmin.from('requirements').update({ 
          metadata: updatedMetadata
        }).eq('id', reqId);
      }

      if (!instanceId) {
        console.error(`[Cron Apps] Failed to create or find remote_instance for req ${reqId}`);
        results.push({ reqId, error: 'Failed to create or find remote_instance' });
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

      if (instanceData?.status === 'paused' || activePlan?.status === 'paused') {
        console.log(`[Cron Apps] ${reqId} — instance or plan was paused, resuming it.`);
        if (instanceData?.status === 'paused') {
          await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', instanceId);
        }
        if (activePlan?.status === 'paused') {
          await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', activePlan.id);
        }
      }

      if (instanceData && instanceData.status !== 'running') {
        await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', instanceId);
      }
      if (activePlan && activePlan.status !== 'in_progress') {
        await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', activePlan.id);
      }

      // Build previous work context
      const { data: prevStatuses } = await supabaseAdmin
        .from('requirement_status')
        .select('stage, message, preview_url, repo_url, created_at')
        .eq('requirement_id', reqId)
        .order('created_at', { ascending: false })
        .limit(10);

      const { data: prevPlans } = await supabaseAdmin
        .from('instance_plans')
        .select('id, title, status, steps')
        .eq('instance_id', instanceId)
        .order('created_at', { ascending: false })
        .limit(3);

      // Extract actionable blockers from the latest status
      const latestStatus = prevStatuses?.[0];
      let blockerContext = '';
      if (latestStatus && latestStatus.stage !== 'done') {
        const blockers: string[] = [];
        if (latestStatus.message?.includes('preview_url returns error/404')) {
          blockers.push('CRITICAL: The deployed preview URL returns 404. The app has no working root page. You MUST create a plan step to fix the root route (e.g. src/app/page.tsx).');
        }
        if (latestStatus.message?.includes('no push')) {
          blockers.push('WARNING: Last cycle produced no git push. The agent must write actual files, not just update metadata.');
        }
        if (latestStatus.message?.includes('plan not completed')) {
          blockers.push('WARNING: Last plan did not complete all steps. Review failed steps and address root causes.');
        }
        if (!latestStatus.preview_url) {
          blockers.push('No preview URL available yet. Ensure code changes are meaningful so the deployment works.');
        }
        if (blockers.length) {
          blockerContext = `\n⚠️ BLOCKERS FROM LAST CYCLE (MUST ADDRESS FIRST):\n${blockers.map(b => `- ${b}`).join('\n')}\n`;
        }
      }

      const previousWorkContext = [
        blockerContext,
        (prevStatuses?.length || prevPlans?.length)
          ? `\nPREVIOUS WORK:\n${prevStatuses?.length ? `- Latest stage: ${latestStatus?.stage} — ${latestStatus?.message || 'no message'}` : ''}\n${prevPlans?.length ? `- Recent plans: ${prevPlans.map((p: any) => `${p.title} (${p.status})`).join(', ')}` : ''}\n`
          : '',
      ].filter(Boolean).join('\n');

      // Start the MAIN workflow — durable execution with step-level retries
      console.log(`[Cron Apps] Starting main workflow for req ${reqId}, instance ${instanceId}`);
      try {
        const workflowRun = await start(runCronAppsWorkflow, [{
          reqId,
          title,
          instructions,
          type,
          site_id,
          user_id,
          instanceId,
          previousWorkContext,
          instance_type: type,
          cronLockRunId: runLock.runId,
        }]);

        results.push({ reqId, runId: workflowRun.runId, started: true, type: 'main' });
      } catch (err: any) {
        console.error(`[Cron Apps] Error starting main workflow for req ${reqId}:`, err);
        results.push({ reqId, error: err?.message || 'Failed to start main workflow' });
      }

      // ======================================================================
      // PARALLEL MAINTENANCE WORKFLOW TRIGGER
      // ======================================================================
      // We launch the maintenance workflow entirely in parallel, on the exact same cron tick.
      // It uses its own lock, its own remote_instance, and its own sandbox.
      
      let hasCompletedBacklog = requirement.metadata?.has_completed_backlog === true;
      
      if (!hasCompletedBacklog && requirement.backlog?.items) {
        hasCompletedBacklog = requirement.backlog.items.some((i: any) => i.status === 'done');
        if (hasCompletedBacklog) {
          // Save to metadata so we don't have to check the JSON array every time
          await supabaseAdmin.from('requirements').update({
            metadata: { ...requirement.metadata, has_completed_backlog: true }
          }).eq('id', reqId);
          requirement.metadata = { ...requirement.metadata, has_completed_backlog: true };
        }
      }

      if (!hasCompletedBacklog) {
        console.log(`[Cron Apps] Skipping PARALLEL maintenance for ${reqId} — no completed backlog items yet`);
      } else {
        // Verify QA execution limit
        const doneItemsCount = requirement.backlog?.items?.filter((i: any) => i.status === 'done').length || 0;
        const maxQaRuns = doneItemsCount * 3;
        const currentQaRuns = requirement.metadata?.qa_successful_runs || 0;
        
        if (currentQaRuns >= maxQaRuns && doneItemsCount > 0) {
          console.log(`[Cron Apps] Skipping PARALLEL maintenance for ${reqId} — reached limit of ${maxQaRuns} successful QA runs (${doneItemsCount} done items)`);
        } else {
          const maintenanceLockKey = `${reqId}-maint`;
          const maintRunLock = await acquireRunLock(maintenanceLockKey);
          
          if (maintRunLock) {
            console.log(`[Cron Apps] Starting PARALLEL maintenance workflow for req ${reqId}`);
            
            // Find or create remote_instance for MAINTENANCE
            let maintInstanceId: string | undefined;
            const maintInstanceName = `req-maint-${reqId}`;
            
            const { data: maintInstances } = await supabaseAdmin
              .from('remote_instances')
              .select('id')
              .eq('site_id', site_id)
              .eq('name', maintInstanceName)
              .limit(1);
  
            if (maintInstances && maintInstances.length > 0) {
              maintInstanceId = maintInstances[0].id;
            } else {
              const { data: newMaintInstance, error: maintInsertErr } = await supabaseAdmin
                .from('remote_instances')
                .insert(
                  cronRemoteInstancePayload({
                    site_id,
                    user_id,
                    name: maintInstanceName,
                    created_by: user_id,
                    instance_type: REMOTE_INSTANCE_TYPE_MAINTENANCE,
                  }),
                )
                .select('id')
                .single();
              if (maintInsertErr) console.error('[Cron Apps] Error inserting maintenance remote_instance:', maintInsertErr);
              maintInstanceId = newMaintInstance?.id;
            }
  
            if (maintInstanceId) {
              // Validate maintenance instance and plan are not paused, otherwise put them in play
              const { data: maintInstanceData } = await supabaseAdmin
                .from('remote_instances')
                .select('status')
                .eq('id', maintInstanceId)
                .single();
  
              const { data: maintActivePlan } = await supabaseAdmin
                .from('instance_plans')
                .select('id, status')
                .eq('instance_id', maintInstanceId)
                .in('status', ['pending', 'in_progress', 'paused'])
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
  
              if (maintInstanceData?.status === 'paused' || maintActivePlan?.status === 'paused') {
                console.log(`[Cron Apps] PARALLEL maintenance for ${reqId} — maintenance instance or plan was paused, resuming it.`);
                if (maintInstanceData?.status === 'paused') {
                  await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', maintInstanceId);
                }
                if (maintActivePlan?.status === 'paused') {
                  await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', maintActivePlan.id);
                }
              }
              
              {
                if (maintInstanceData && maintInstanceData.status !== 'running') {
                  await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', maintInstanceId);
                }
                if (maintActivePlan && maintActivePlan.status !== 'in_progress') {
                  await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', maintActivePlan.id);
                }
  
                try {
                  const maintWorkflowRun = await start(runMaintenanceWorkflow, [{
                    reqId,
                    title,
                    instructions,
                    type,
                    site_id,
                    user_id,
                    instanceId: maintInstanceId,
                    previousWorkContext: '', // Maintenance doesn't strictly need the main builder's blocker context
                    instance_type: type,
                    cronLockRunId: maintRunLock.runId,
                    maintenanceLockKey,
                  }]);
  
                  results.push({ reqId, runId: maintWorkflowRun.runId, started: true, type: 'maintenance' });
                } catch (err: any) {
                  console.error(`[Cron Apps] Error starting maintenance workflow for req ${reqId}:`, err);
                  await releaseRunLock(maintenanceLockKey, maintRunLock.runId);
                }
              }
            } else {
              await releaseRunLock(maintenanceLockKey, maintRunLock.runId);
            }
          } else {
            console.log(`[Cron Apps] Skipping parallel maintenance for ${reqId} — maintenance already running`);
          }
        }
      }
    }

    return NextResponse.json({
      message: `Processed ${results.length} requirements`,
      results,
    });

  } catch (e: any) {
    console.error(`[Cron Apps] Top-level error:`, e?.message || e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
