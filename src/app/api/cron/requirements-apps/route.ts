import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runCronAppsWorkflow } from './workflow';
import { runMaintenanceWorkflow } from '../maintenance/workflow';
import { CronExpressionParser } from 'cron-parser';
import { acquireRunLock, getSupabaseUrlHostForLogs, releaseRunLock } from '../shared/cron-run-lock';
import { isBacklogComplete, hasOutstandingWork, gatingItems } from '@/lib/services/requirement-backlog';

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

export const maxDuration = 800; // 13 minutos aprox (Max for pro plan)
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET?.trim()}`) {
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
    
    // Auto-sanitization pass: detects and repairs requirements that were marked 'on-review' 
    // due to fake-done items or plumbing stalls.
    try {
      const { runOnReviewSanitization } = await import('@/lib/services/requirement-onreview-sanitizer');
      const sanResult = await runOnReviewSanitization();
      if (sanResult.requirementsSanitized > 0) {
        console.log(`[Cron Apps] Auto-sanitization recovered ${sanResult.requirementsSanitized} requirements (reopened ${sanResult.itemsReopened} items).`);
      }
    } catch (sanErr) {
      console.error(`[Cron Apps] Error during auto-sanitization pass:`, sanErr);
    }
    
    // Quick pass: find recently updated done/on-review/cancelled requirements to either clean up their instances or revert them to in-progress
    const { data: recentCompletedReqs } = await supabaseAdmin
      .from('requirements')
      .select('id, status, backlog, metadata, site_id')
      .in('status', ['done', 'on-review', 'cancelled'])
      .order('updated_at', { ascending: false })
      .limit(100);
      
    if (recentCompletedReqs && recentCompletedReqs.length > 0) {
      for (const req of recentCompletedReqs) {
        const isComplete = isBacklogComplete(req.backlog?.items || []);
        
        // Only revert to in-progress if new items were added AFTER the requirement was closed
        // We detect this by checking if there's any item updated more recently than the last 'terminal' status
        if (['on-review', 'done'].includes(req.status) && hasOutstandingWork(req.backlog?.items || [])) {
          const { data: lastStatus } = await supabaseAdmin
            .from('requirement_status')
            .select('created_at')
            .eq('requirement_id', req.id)
            .in('stage', ['on-review', 'done'])
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
            
          const lastTerminalTime = lastStatus ? new Date(lastStatus.created_at).getTime() : 0;
          const newestItemUpdate = Math.max(...(req.backlog?.items || []).map((i: any) => new Date(i.updated_at || i.created_at || 0).getTime()));
          
          if (newestItemUpdate > lastTerminalTime) {
            console.log(`[Cron Apps] Requirement ${req.id} is ${req.status} but has new items added after closure. Reverting to in-progress.`);
            await supabaseAdmin.from('requirements').update({ status: 'in-progress' }).eq('id', req.id);
          } else {
            console.log(`[Cron Apps] Requirement ${req.id} has incomplete items but they pre-date closure. Ignoring (might be ornamental/abandoned).`);
          }
        } else if (['on-review', 'done', 'cancelled'].includes(req.status) && (isComplete || req.status === 'cancelled')) {
          // Si el requerimiento está en review, done o cancelado y tiene todos los items completos (o está cancelado),
          // regresamos la instancia a pending (inicializando)
          await supabaseAdmin
            .from('remote_instances')
            .update({ status: 'pending' })
            .eq('site_id', req.site_id)
            .like('name', `%req-%${req.id.substring(0, 8)}%`)
            .in('status', ['running', 'starting', 'paused']);
        }
      }
    }

    // Flow-agnostic: the cron picks any requirement kind (app/site/doc/slides/
    // contract/automation/task/makinari). The orchestrator resolves the flow
    // from `requirement.type` via `requirement-flow-engine.ts` and drives the
    // correct phases/gates. Legacy `requirements-automations` cron remains for
    // back-compat and will be deprecated separately.
    const { data: requirements, error } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .or(`status.in.(backlog,in-progress),and(status.in.(on-review,done,cancelled),cron.not.is.null)`)
      .or(`created_at.gte.${oneMonthAgo},updated_at.gte.${oneMonthAgo}`)
      .order('updated_at', { ascending: false })
      .limit(10);

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

      // Re-fetch requirement status to ensure it hasn't been cancelled or done
      const { data: currentReq } = await supabaseAdmin
        .from('requirements')
        .select('status')
        .eq('id', reqId)
        .single();
      
      if (currentReq) {
        const isComplete = isBacklogComplete(requirement.backlog?.items || []);

        // Evaluate cron schedule if applicable for terminal states
        let reactivatedByCron = false;
        if (requirement.cron && ['on-review', 'done', 'cancelled', 'blocked'].includes(currentReq.status)) {
          try {
            const interval = CronExpressionParser.parse(requirement.cron);
            const prev = interval.prev().toDate();
            const lastTerminalTime = requirement.updated_at ? new Date(requirement.updated_at).getTime() : 0;
            const nowTime = Date.now();
            
            // If the schedule triggered since the requirement reached terminal status
            if (prev.getTime() > lastTerminalTime && nowTime - prev.getTime() < 120000) {
              console.log(`[Cron Apps] Requirement ${reqId} cron triggered. Reactivating from ${currentReq.status} to in-progress.`);
              
              const newBacklogItem = {
                id: crypto.randomUUID(),
                title: 'Cron Iteration: Analyze state, implement improvements and continue',
                kind: 'task',
                phase_id: 'default',
                status: 'pending',
                acceptance: ['Analyze the current state of the application based on previous execution and instructions', 'Implement any missing or requested features from instructions', 'Push the changes to the repository'],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              };

              const newBacklog = requirement.backlog || { items: [] };
              if (!newBacklog.items) newBacklog.items = [];
              
              // Reset any failed or blocked items to pending so the orchestrator can re-evaluate them
              newBacklog.items = newBacklog.items.map((i: any) => {
                if (i.status === 'failed' || i.status === 'blocked' || (i.status === 'in_progress' && nowTime - new Date(i.updated_at || 0).getTime() > 24 * 60 * 60 * 1000)) {
                   return { ...i, status: 'pending', updated_at: new Date().toISOString() };
                }
                return i;
              });

              newBacklog.items.push(newBacklogItem);
              
              const updatedMetadata = { ...requirement.metadata, cron_attempts: 0, all_done_cycles: 0, has_completed_backlog: false };

              await supabaseAdmin.from('requirements').update({ 
                status: 'in-progress',
                backlog: newBacklog,
                metadata: updatedMetadata,
                updated_at: new Date().toISOString()
              }).eq('id', reqId);
              
              currentReq.status = 'in-progress';
              requirement.status = 'in-progress';
              requirement.backlog = newBacklog;
              requirement.metadata = updatedMetadata;
              reactivatedByCron = true;
            }
          } catch (err) {
            console.error(`[Cron Apps] Invalid cron schedule for req ${reqId}: ${requirement.cron}`, err);
          }
        }

        if (isComplete && !reactivatedByCron) {
          const gating = gatingItems(requirement.backlog?.items || []);
          const lastCoreUpdate = Math.max(
            ...gating.map((i: any) => new Date(i.updated_at || 0).getTime())
          );
          const minutesSinceCoreDone = (Date.now() - lastCoreUpdate) / 60_000;

          const COOLDOWN_MIN = parseInt(process.env.CRON_BACKLOG_DONE_COOLDOWN_MIN || '15', 10);

          if (minutesSinceCoreDone < COOLDOWN_MIN) {
            console.log(`[Cron Apps] Skip ${reqId} — gating backlog done ${minutesSinceCoreDone.toFixed(1)} min ago (cooldown ${COOLDOWN_MIN} min)`);
            await releaseRunLock(reqId, runLock.runId);
            results.push({ reqId, skipped: true, reason: 'backlog_cooldown' });
            continue;
          }

          if (currentReq.status !== 'on-review' && currentReq.status !== 'done' && currentReq.status !== 'cancelled') {
            console.log(`[Cron Apps] Requirement ${reqId} cooldown expired. Auto-promoting to on-review.`);
            await supabaseAdmin
              .from('requirements')
              .update({ status: 'on-review', updated_at: new Date().toISOString() })
              .eq('id', reqId);
            currentReq.status = 'on-review';
            requirement.status = 'on-review';
          }
        }

        if (['cancelled', 'done'].includes(currentReq.status) || (currentReq.status === 'on-review' && isComplete)) {
          console.log(`[Cron Apps] Skipping ${reqId} — requirement is ${currentReq.status} and backlog is done`);
          
          console.log(`[Cron Apps] Cleaning up instances for ${currentReq.status} requirement ${reqId}`);
          
          // Pending any running/paused instances
          await supabaseAdmin
            .from('remote_instances')
            .update({ status: 'pending' })
            .eq('site_id', site_id)
            .like('name', `%req-%${reqId.substring(0, 8)}%`)
            .in('status', ['running', 'starting', 'paused']);
            
          // Cancel any active plans
          // Note: instance_plans don't have requirement_id directly, they belong to the instance
          const { data: instances } = await supabaseAdmin
            .from('remote_instances')
            .select('id')
            .eq('site_id', site_id)
            .like('name', `%req-%${reqId.substring(0, 8)}%`);
            
          if (instances && instances.length > 0) {
            const instanceIds = instances.map((i) => i.id);
            await supabaseAdmin
              .from('instance_plans')
              .update({ status: 'cancelled' })
              .in('instance_id', instanceIds)
              .in('status', ['pending', 'in_progress']);
          }
          
          await releaseRunLock(reqId, runLock.runId);
          results.push({ reqId, skipped: true, reason: currentReq.status });
          continue;
        }

        // Si estaba en on-review o done, pero agregaron un nuevo item que no está completo, debe regresar a in-progress
        // We now check if the item is actually NEW relative to the closure status.
        if (['on-review', 'done'].includes(currentReq.status) && hasOutstandingWork(requirement.backlog?.items || [])) {
          const { data: lastStatus } = await supabaseAdmin
            .from('requirement_status')
            .select('created_at')
            .eq('requirement_id', reqId)
            .in('stage', ['on-review', 'done'])
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
            
          const lastTerminalTime = lastStatus ? new Date(lastStatus.created_at).getTime() : 0;
          const newestItemUpdate = Math.max(...(requirement.backlog?.items || []).map((i: any) => new Date(i.updated_at || i.created_at || 0).getTime()));
          
          if (newestItemUpdate > lastTerminalTime) {
            console.log(`[Cron Apps] Requirement ${reqId} is ${currentReq.status} but has incomplete items added after closure. Reverting to in-progress.`);
            await supabaseAdmin.from('requirements').update({ status: 'in-progress' }).eq('id', reqId);
            requirement.status = 'in-progress';
            currentReq.status = 'in-progress';
          }
        }
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

      // Circuit-breaker budget scales with backlog size. A whole backlog cannot
      // be finished in a flat 10 cycles, and per-task "stuck" detection is now
      // handled by the needs_review mechanism — so this counter is only a coarse
      // runaway-cost guard. Allow ~100 cycles per backlog item (configurable).
      // `cron_attempts` still resets to 0 whenever a plan step actually completes
      // (see resetCronAttemptsStep in the workflow), so this cap is only reached
      // when there is genuinely no forward progress for a very long time.
      const PER_ITEM_CYCLE_BUDGET = parseInt(process.env.CRON_CYCLES_PER_BACKLOG_ITEM || '100', 10);
      const backlogItemCount = requirement.backlog?.items?.length || 0;
      const maxAttempts = PER_ITEM_CYCLE_BUDGET * Math.max(1, backlogItemCount);
      const currentAttempts = requirement.metadata?.cron_attempts || 0;
      if (currentAttempts >= maxAttempts) {
        console.log(`[Cron Apps] Skipping ${reqId} — blocked: ${currentAttempts} cycles without progress (budget ${maxAttempts} = ${PER_ITEM_CYCLE_BUDGET}/item × ${Math.max(1, backlogItemCount)} item(s)).`);
        
        // We need to get the latest error/status to send to QA
        const { data: latestStatus } = await supabaseAdmin
          .from('requirement_status')
          .select('message, stage')
          .eq('requirement_id', reqId)
          .order('created_at', { ascending: false })
          .limit(1);
          
        const errorMessage = latestStatus?.[0]?.message || `Unknown error after ${currentAttempts} attempts`;
        const errorSummary = `The main builder failed ${currentAttempts} consecutive times. Last error: ${errorMessage}. YOUR PRIORITY IS TO FIX THIS ERROR. Ignore the "only audit done items" rule for this run and focus on unblocking the main builder by fixing the build/runtime error.`;

        await supabaseAdmin.from('requirements').update({ 
          status: 'blocked',
          updated_at: new Date().toISOString()
        }).eq('id', reqId);

        // Visibility: QA is currently disabled, so without this the requirement
        // would flip to `blocked` with no trace in the status timeline or logs
        // (a silent death). Record an explicit blocked status + instance log so
        // operators can see WHY the builder stopped.
        const blockedMessage = `Auto-blocked: main builder hit ${currentAttempts} cycles without progress (budget ${maxAttempts} = ${PER_ITEM_CYCLE_BUDGET}/item × ${Math.max(1, backlogItemCount)} backlog item(s)). Last error: ${errorMessage}. Resolve the blocker (often two agents racing on the same git branch → rebase conflicts) and reset metadata.cron_attempts to re-open.`;
        try {
          await supabaseAdmin.from('requirement_status').insert({
            requirement_id: reqId,
            instance_id: instanceId || null,
            stage: 'blocked',
            message: blockedMessage,
          });
        } catch (statusErr) {
          console.error(`[Cron Apps] Failed to record blocked requirement_status for ${reqId}:`, statusErr);
        }
        if (instanceId) {
          await supabaseAdmin.from('instance_logs').insert({
            log_type: 'infrastructure',
            level: 'error',
            message: blockedMessage,
            details: { event: 'cron_circuit_breaker', cron_attempts: currentAttempts, max_attempts: maxAttempts, per_item_budget: PER_ITEM_CYCLE_BUDGET, backlog_item_count: backlogItemCount, requirement_id: reqId },
            instance_id: instanceId,
            site_id,
          }).then(undefined, (e) => console.error('[Cron Apps] Failed to insert circuit-breaker log:', e));
        }

        // Pause the main builder instance and plan so it doesn't consume resources
        if (instanceId) {
          await supabaseAdmin.from('remote_instances').update({ status: 'pending' }).eq('id', instanceId);
          await supabaseAdmin.from('instance_plans').update({ status: 'paused' }).eq('instance_id', instanceId).in('status', ['pending', 'in_progress']);
        }
        
        // We no longer limit QA runs. QA will continuously improve the app.
        // Trigger QA workflow before continuing
        // QA CRON PAUSED PER USER REQUEST
        /*
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

            // Permitir que QA corra incluso si estaba pausado (lo reanudamos)
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
          } else {
            await releaseRunLock(maintenanceLockKey, maintRunLock.runId);
          }
        }
        */

        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'blocked_circuit_breaker_qa_triggered' });
        continue;
      }

      if (!instanceId) {
        console.error(`[Cron Apps] Failed to create or find remote_instance for req ${reqId}`);
        results.push({ reqId, error: 'Failed to create or find remote_instance' });
        await releaseRunLock(reqId, runLock.runId);
        continue;
      }

      // Validate instance and plan are not paused
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
        console.log(`[Cron Apps] Skipping ${reqId} — instance or plan is paused.`);
        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'paused' });
        continue;
      }

      // Concurrency guard: a requirement can be worked by more than one agent at
      // once — e.g. a live assistant/chat session (its own remote_instance) that
      // created the requirement AND this cron builder. When both push to the same
      // `feature/req-<id>` branch they race on `git push` → repeated
      // `rebase_conflict` → each cycle does `reset --hard`, makes no real progress,
      // and `cron_attempts` climbs until the circuit breaker kills it. The cron
      // run-lock only serializes cron ticks, not the other subsystem. So if a
      // DIFFERENT instance reported activity on this requirement very recently,
      // defer this build cycle and let that agent finish first.
      const CONCURRENCY_WINDOW_MIN = parseInt(process.env.CRON_FOREIGN_AGENT_WINDOW_MIN || '5', 10);
      const concurrencyCutoff = new Date(Date.now() - CONCURRENCY_WINDOW_MIN * 60 * 1000).toISOString();
      const { data: foreignActivity } = await supabaseAdmin
        .from('requirement_status')
        .select('instance_id, created_at')
        .eq('requirement_id', reqId)
        .neq('instance_id', instanceId)
        .gte('created_at', concurrencyCutoff)
        .order('created_at', { ascending: false })
        .limit(1);

      if (foreignActivity && foreignActivity.length > 0) {
        console.log(`[Cron Apps] Skipping ${reqId} — another instance (${foreignActivity[0].instance_id?.substring(0, 8)}) is actively working this requirement (last activity ${foreignActivity[0].created_at}). Deferring to avoid git branch collision.`);
        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'foreign_agent_active' });
        continue;
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
      
      // Update in-memory requirement for subsequent parallel block checks
      requirement.metadata = updatedMetadata;

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
          blockers.push('WARNING: Last cycle failed because you did not call the `instance_plan` tool with action="create". You MUST use the `instance_plan` tool to create the execution plan for the current backlog item. Do not try to fix code; just create the plan.');
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
      
      // QA CRON PAUSED PER USER REQUEST
      if (true) {
        continue;
      }
      
      let hasCompletedBacklog = requirement.metadata?.has_completed_backlog === true;
      
      if (requirement.backlog?.items) {
        hasCompletedBacklog = requirement.backlog.items.some((i: any) => i.status === 'done');
        if (hasCompletedBacklog && !requirement.metadata?.has_completed_backlog) {
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
        const currentAttempt = requirement.metadata?.cron_attempts || 0;
        const lastQaAttempt = requirement.metadata?.qa_last_attempt_sync || -1;
        
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
        }
        
        let hasActivePlan = false;
        if (maintInstanceId) {
          const { data: activePlan } = await supabaseAdmin
            .from('instance_plans')
            .select('id')
            .eq('instance_id', maintInstanceId)
            .in('status', ['pending', 'in_progress'])
            .limit(1)
            .single();
          if (activePlan) {
            hasActivePlan = true;
          }
        }
        
        if (!hasActivePlan && lastQaAttempt === currentAttempt) {
          console.log(`[Cron Apps] Skipping PARALLEL maintenance for ${reqId} — QA already ran for main builder attempt ${currentAttempt} and has no active plan`);
          
          if (maintInstanceId) {
            await supabaseAdmin.from('remote_instances').update({ status: 'pending' }).eq('id', maintInstanceId);
          }
        } else {
          // Update the sync tracker
          const syncMetadata = { ...requirement.metadata, qa_last_attempt_sync: currentAttempt };
          await supabaseAdmin.from('requirements').update({ metadata: syncMetadata }).eq('id', reqId);
          requirement.metadata = syncMetadata;

          // We no longer limit QA runs. QA will continuously improve the app.
          const maintenanceLockKey = `${reqId}-maint`;
          const maintRunLock = await acquireRunLock(maintenanceLockKey);
          
          if (maintRunLock) {
            console.log(`[Cron Apps] Starting PARALLEL maintenance workflow for req ${reqId}`);
            
            // Create remote_instance for MAINTENANCE if it doesn't exist
            if (!maintInstanceId) {
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
                console.log(`[Cron Apps] PARALLEL maintenance for ${reqId} — maintenance instance or plan is paused, skipping.`);
                await releaseRunLock(maintenanceLockKey, maintRunLock.runId);
                continue; // Skip parallel maintenance
              }
              
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
