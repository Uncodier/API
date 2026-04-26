import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runCronAppsWorkflow } from './workflow';
import { acquireRunLock, getSupabaseUrlHostForLogs } from '../shared/cron-run-lock';

/** Must match DB check `remote_instances_instance_type_check` (ubuntu | browser | windows). */
const REMOTE_INSTANCE_TYPE_CRON_APPS = 'browser' as const;

/** Cron runners use Vercel Sandbox workflows — not Scrapybara; keep provider/CDP null. */
function cronRemoteInstancePayload(base: {
  site_id: string;
  user_id: string;
  name: string;
  created_by: string;
}) {
  return {
    ...base,
    status: 'pending' as const,
    instance_type: REMOTE_INSTANCE_TYPE_CRON_APPS,
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
      if (currentAttempts >= 3) {
        console.log(`[Cron Apps] Skipping ${reqId} — blocked due to 3 consecutive failures without progress.`);
        await supabaseAdmin.from('requirements').update({ 
          status: 'blocked',
          updated_at: new Date().toISOString()
        }).eq('id', reqId);
        await releaseRunLock(reqId, runLock.runId);
        results.push({ reqId, skipped: true, reason: 'blocked_circuit_breaker' });
        continue;
      }

      if (requirement.status === 'backlog') {
        await supabaseAdmin.from('requirements').update({ 
          status: 'in-progress',
          metadata: { ...requirement.metadata, cron_attempts: currentAttempts + 1 }
        }).eq('id', reqId);
      } else {
        await supabaseAdmin.from('requirements').update({ 
          metadata: { ...requirement.metadata, cron_attempts: currentAttempts + 1 }
        }).eq('id', reqId);
      }

      // Find or create remote_instance
      let instanceId: string | undefined;
      const { data: prevStatusForInstance } = await supabaseAdmin
        .from('requirement_status')
        .select('instance_id')
        .eq('requirement_id', reqId)
        .not('instance_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (prevStatusForInstance?.[0]?.instance_id) {
        instanceId = prevStatusForInstance[0].instance_id;
      } else {
        const { data: instances } = await supabaseAdmin
          .from('remote_instances')
          .select('id, instance_type') // Select instance_type as well
          .eq('site_id', site_id)
          .eq('name', `req-runner-${reqId}`)
          .limit(1);

        if (instances && instances.length > 0) {
          instanceId = instances[0].id;
          if (!instances[0].instance_type) {
            await supabaseAdmin.from('remote_instances').update({ instance_type: REMOTE_INSTANCE_TYPE_CRON_APPS }).eq('id', instanceId);
          }
        } else {
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

      if (!instanceId) {
        console.error(`[Cron Apps] Failed to create or find remote_instance for req ${reqId}`);
        results.push({ reqId, error: 'Failed to create or find remote_instance' });
        continue;
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

      // Start the workflow — durable execution with step-level retries
      console.log(`[Cron Apps] Starting workflow for req ${reqId}, instance ${instanceId}`);
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

        results.push({ reqId, runId: workflowRun.runId, started: true });
      } catch (err: any) {
        console.error(`[Cron Apps] Error starting workflow for req ${reqId}:`, err);
        results.push({ reqId, error: err?.message || 'Failed to start workflow' });
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
