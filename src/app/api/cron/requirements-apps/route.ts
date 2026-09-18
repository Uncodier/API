import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runCronAppsWorkflow } from './workflow';
import { runForcedCycleWrapUpWorkflow } from '../shared/forced-cycle-wrapup-workflow';
import {
  CRON_RUN_LOCK_TTL_MS,
  releaseRunLock,
} from '../shared/cron-run-lock';
import { recordTelemetry } from '@/lib/status/telemetry';
import {
  blockRequirementForProductAttemptBudget,
  patchRequirementMetadataKeys,
} from '@/lib/services/requirement-metadata-patch';
import {
  activateRequirementCronRun,
  cleanupRecentlyCompletedRequirements,
  claimRequirementsForCronRun,
  prepareRequirementForCronRun,
  runRequirementRecoveryPrepass,
} from './route-state';
import { resolveRequirementGitRepoKind } from '@/lib/services/requirement-git-binding';
import {
  cronRemoteInstancePayload,
  getMaxConcurrentRequirementRuns,
  getRequirementEvaluationLimit,
  readExecutionGeneration,
  REMOTE_INSTANCE_TYPE_CRON_APPS,
} from './scheduler-config';
import { buildPreviousWorkContext } from './previous-work-context';

export const maxDuration = 800; // Approximately 13 minutes (Pro plan maximum).
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const maxConcurrentRuns = getMaxConcurrentRequirementRuns();
    const evaluationLimit = getRequirementEvaluationLimit();

    await runRequirementRecoveryPrepass();
    await cleanupRecentlyCompletedRequirements();

    const results = [];
    const evaluatedRequirementIds: string[] = [];
    let capacityReached = false;
    let activeRuns: number | undefined;

    // Claim and evaluate one candidate at a time. A skipped/frozen requirement
    // releases its lease, then the next candidate is considered without using
    // one of the eight real workflow slots.
    while (evaluatedRequirementIds.length < evaluationLimit) {
      const claims = await claimRequirementsForCronRun(
        maxConcurrentRuns,
        CRON_RUN_LOCK_TTL_MS,
        evaluatedRequirementIds,
      );
      const claimResult = claims[0];
      if (!claimResult) break;
      if (claimResult.state === 'capacity_full') {
        capacityReached = true;
        activeRuns = claimResult.active_runs;
        break;
      }
      const claim = claimResult;

      const requirement = claim.requirement;
      const reqId = requirement.id;
      evaluatedRequirementIds.push(reqId);
      const runLock = {
        runId: claim.run_id,
        expiresAt: claim.expires_at,
      };

      // Re-fetch the entire mutable row under the run lock. Backlog and
      // metadata from candidate discovery may already be stale.
      const { data: currentReq, error: currentReqError } = await supabaseAdmin
        .from('requirements')
        .select('*')
        .eq('id', reqId)
        .single();
      if (currentReqError || !currentReq) {
        await releaseRunLock(reqId, runLock.runId);
        results.push({
          reqId,
          skipped: true,
          reason: 'requirement_state_unavailable',
        });
        continue;
      }
      Object.assign(requirement, currentReq);
      const { title, instructions, type, site_id, user_id } = requirement;
      let instanceId: string | undefined =
        requirement.metadata?.runner_instance_id;
      let executionGeneration = readExecutionGeneration(
        requirement.metadata?.requirement_execution_generation,
      );
      console.log(
        `[Cron Apps] Processing requirement ${reqId}: ${title} (lock runId=${runLock.runId})`,
      );
      const prepared = await prepareRequirementForCronRun({
        requirement,
        currentStatus: requirement.status,
        instanceId,
      });
      requirement.status = prepared.status;
      requirement.backlog = prepared.backlog;
      requirement.metadata = prepared.metadata;
      executionGeneration = readExecutionGeneration(
        prepared.metadata?.requirement_execution_generation,
      );
      const gitRepoKind = resolveRequirementGitRepoKind(
        prepared.metadata,
        type,
      );
      if (prepared.skipReason) {
        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: prepared.skipReason });
        continue;
      }

      // Find or create remote_instance for MAIN BUILDER
      if (!instanceId) {
        // 1. Look up the main builder instance by its canonical name
        const { data: instances, error: instanceLookupError } =
          await supabaseAdmin
          .from('remote_instances')
          .select('id, instance_type')
          .eq('site_id', site_id)
          .eq('name', `req-runner-${reqId}`)
          .limit(1);
        if (instanceLookupError) {
          await releaseRunLock(reqId, runLock.runId);
          results.push({
            reqId,
            skipped: true,
            reason: 'instance_lookup_unavailable',
          });
          continue;
        }

        if (instances && instances.length > 0) {
          instanceId = instances[0].id;
          if (!instances[0].instance_type) {
            await supabaseAdmin.from('remote_instances').update({ instance_type: REMOTE_INSTANCE_TYPE_CRON_APPS }).eq('id', instanceId);
          }
        } else {
          // 2. Fallback for legacy instances (before req-runner- naming convention)
          // We must ensure we don't accidentally pick up a maintenance instance.
          const {
            data: prevStatusForInstance,
            error: previousStatusError,
          } = await supabaseAdmin
            .from('requirement_status')
            .select('instance_id')
            .eq('requirement_id', reqId)
            .not('instance_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(10);
          if (previousStatusError) {
            await releaseRunLock(reqId, runLock.runId);
            results.push({
              reqId,
              skipped: true,
              reason: 'instance_history_unavailable',
            });
            continue;
          }

          if (prevStatusForInstance && prevStatusForInstance.length > 0) {
            // Fetch the names of these instances to filter out maintenance ones
            const instanceIds = prevStatusForInstance.map(s => s.instance_id);
            const { data: legacyInstances, error: legacyInstanceError } =
              await supabaseAdmin
              .from('remote_instances')
              .select('id, name')
              .in('id', instanceIds)
              .not('name', 'like', 'req-maint-%');
            if (legacyInstanceError) {
              await releaseRunLock(reqId, runLock.runId);
              results.push({
                reqId,
                skipped: true,
                reason: 'legacy_instance_lookup_unavailable',
              });
              continue;
            }
              
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

      // Scale the coarse runaway-cost guard with backlog size.
      const configuredCycleBudget = Number.parseInt(
        process.env.CRON_CYCLES_PER_BACKLOG_ITEM || '100',
        10,
      );
      const PER_ITEM_CYCLE_BUDGET =
        Number.isFinite(configuredCycleBudget) && configuredCycleBudget > 0
          ? configuredCycleBudget
          : 100;
      const backlogItemCount = requirement.backlog?.items?.length || 0;
      const maxAttempts = PER_ITEM_CYCLE_BUDGET * Math.max(1, backlogItemCount);
      const currentAttempts = requirement.metadata?.cron_attempts || 0;
      const lastAccountedCycleId =
        typeof requirement.metadata?.cron_last_cycle_id === 'string'
          ? requirement.metadata.cron_last_cycle_id
          : null;
      if (currentAttempts >= maxAttempts && lastAccountedCycleId) {
        console.log(`[Cron Apps] Skipping ${reqId} — blocked: ${currentAttempts} cycles without progress (budget ${maxAttempts} = ${PER_ITEM_CYCLE_BUDGET}/item × ${Math.max(1, backlogItemCount)} item(s)).`);
        
        // We need to get the latest error/status to send to QA
        const { data: latestStatus } = await supabaseAdmin
          .from('requirement_status')
          .select('message, stage')
          .eq('requirement_id', reqId)
          .order('created_at', { ascending: false })
          .limit(1);
          
        const errorMessage = latestStatus?.[0]?.message || `Unknown error after ${currentAttempts} attempts`;
        const blockedMessage = `Auto-blocked: main builder hit ${currentAttempts} cycles without progress (budget ${maxAttempts} = ${PER_ITEM_CYCLE_BUDGET}/item × ${Math.max(1, backlogItemCount)} backlog item(s)). Last error: ${errorMessage}. Resolve the blocker (often two agents racing on the same git branch → rebase conflicts) and reset metadata.cron_attempts to re-open.`;
        const blockResult = await blockRequirementForProductAttemptBudget({
          requirementId: reqId,
          siteId: site_id,
          instanceId,
          cycleId: lastAccountedCycleId,
          maxAttempts,
          message: blockedMessage,
          expectedExecutionGeneration: executionGeneration,
        });
        if (!blockResult.blocked) {
          await releaseRunLock(reqId, runLock.runId);
          results.push({
            reqId,
            skipped: true,
            reason: 'stale_product_attempt_budget',
          });
          continue;
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
        
        // A step function cannot be invoked directly from this route. Start a
        // small durable workflow so the blocked reason reaches the client.
        if (instanceId) {
          try {
            const wrapUpRun = await start(runForcedCycleWrapUpWorkflow, [{
              siteId: site_id,
              instanceId,
              userId: user_id,
              requirementId: reqId,
              title,
              instructions,
              planCompleted: false,
              wrapUpReason: blockedMessage,
              requiresUserFeedback: true,
            }]);
            results.push({
              reqId,
              runId: wrapUpRun.runId,
              started: true,
              type: 'blocked_wrap_up',
            });
          } catch (wrapUpError: unknown) {
            console.error(
              `[Cron Apps] Failed to start blocked wrap-up for ${reqId}:`,
              wrapUpError instanceof Error ? wrapUpError.message : wrapUpError,
            );
          }
        }
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
      const { data: instanceData, error: instanceStateError } =
        await supabaseAdmin
        .from('remote_instances')
        .select('status')
        .eq('id', instanceId)
        .single();

      const { data: activePlan, error: activePlanError } = await supabaseAdmin
        .from('instance_plans')
        .select('id, status')
        .eq('instance_id', instanceId)
        .in('status', ['pending', 'in_progress', 'active', 'paused'])
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (instanceStateError || activePlanError) {
        await releaseRunLock(reqId, runLock.runId);
        results.push({
          reqId,
          skipped: true,
          reason: 'execution_state_unavailable',
        });
        continue;
      }

      if (instanceData?.status === 'paused' || activePlan?.status === 'paused') {
        console.log(`[Cron Apps] Skipping ${reqId} — instance or plan is paused.`);
        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'paused' });
        continue;
      }

      // Defer when a different instance recently worked on the same branch.
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

      const activation = await activateRequirementCronRun({
        requirementId: reqId,
        runId: runLock.runId,
        maxConcurrentRuns,
        lockTtlMs: CRON_RUN_LOCK_TTL_MS,
      }).catch(async (activationError: unknown) => {
        await releaseRunLock(reqId, runLock.runId);
        throw activationError;
      });
      if (activation.state === 'capacity_full') {
        capacityReached = true;
        activeRuns = activation.active_runs;
        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'capacity_full' });
        break;
      }
      if (activation.state !== 'active') {
        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'stale_claim' });
        continue;
      }

      if (requirement.status === 'backlog') {
        await supabaseAdmin.from('requirements').update({ 
          status: 'in-progress',
        }).eq('id', reqId);
      }
      const updatedMetadata = await patchRequirementMetadataKeys({
        requirementId: reqId,
        patch: { runner_instance_id: instanceId },
      });
      requirement.metadata = updatedMetadata;

      if (instanceData && instanceData.status !== 'running') {
        await supabaseAdmin.from('remote_instances').update({ status: 'running' }).eq('id', instanceId);
      }
      if (activePlan && activePlan.status !== 'in_progress') {
        await supabaseAdmin.from('instance_plans').update({ status: 'in_progress' }).eq('id', activePlan.id);
      }

      const previousWorkContext = await buildPreviousWorkContext(
        reqId,
        instanceId,
      );

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
          instance_type: gitRepoKind,
          cronLockRunId: runLock.runId,
          cycleStartedAt: new Date().toISOString(),
          executionGeneration,
          gitRepoKind,
        }]);

        results.push({ reqId, runId: workflowRun.runId, started: true, type: 'main' });
      } catch (err: any) {
        console.error(`[Cron Apps] Error starting main workflow for req ${reqId}:`, err);
        results.push({ reqId, error: err?.message || 'Failed to start main workflow' });
        await releaseRunLock(reqId, runLock.runId);
      }

    }

    if (results.length === 0) {
      return NextResponse.json({
        message: capacityReached
          ? 'Requirement cron capacity is full'
          : 'No runnable app requirements to process',
        evaluatedRequirements: evaluatedRequirementIds.length,
        ...(activeRuns === undefined ? {} : { activeRuns, maxConcurrentRuns }),
      });
    }

    recordTelemetry('cron', 'up', `Processed apps cron with ${results.length} results`, 100).catch(console.error);

    return NextResponse.json({
      message: `Processed ${results.length} requirements`,
      evaluatedRequirements: evaluatedRequirementIds.length,
      capacityReached,
      ...(activeRuns === undefined ? {} : { activeRuns, maxConcurrentRuns }),
      results,
    });

  } catch (e: any) {
    console.error(`[Cron Apps] Top-level error:`, e?.message || e);
    recordTelemetry('cron', 'down', `Cron failed: ${e?.message || 'Unknown error'}`, 0).catch(console.error);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
