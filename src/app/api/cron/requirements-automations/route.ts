import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { start } from 'workflow/api';
import { runCronAutoWorkflow } from './workflow';
import cronParser from 'cron-parser';
import { acquireRunLock, getSupabaseUrlHostForLogs } from '../shared/cron-run-lock';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('[Cron Auto] cron debug env', {
      supabaseHost: getSupabaseUrlHostForLogs(),
      supabaseServiceUrlFromEnv: Boolean(process.env.SUPABASE_URL),
      hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      keyStart: process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 15),
      keyEnd: process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(-10),
      vercelEnv: process.env.VERCEL_ENV ?? 'local',
      vercelUrl: process.env.VERCEL_URL ?? null,
      requestUrl: req.url,
    });

    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: requirements, error } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .eq('type', 'automation')
      .in('status', ['validated', 'in-progress'])
      .not('cron', 'is', null)
      .or(`created_at.gte.${oneMonthAgo},updated_at.gte.${oneMonthAgo}`);

    if (error) throw error;
    if (!requirements || requirements.length === 0) {
      return NextResponse.json({ message: 'No automation requirements to process' });
    }

    const now = new Date();
    const dueRequirements = [];

    for (const r of requirements) {
      try {
        if (!r.cron) continue;
        const interval = cronParser.parseExpression(r.cron);
        const prev = interval.prev().toDate();
        if (now.getTime() - prev.getTime() < 120000) {
          dueRequirements.push(r);
        }
      } catch {
        console.error(`[Cron Auto] Invalid cron for req ${r.id}: ${r.cron}`);
      }
    }

    if (dueRequirements.length === 0) {
      return NextResponse.json({ message: 'No automations due right now' });
    }

    const requirement = dueRequirements[0];
    const { id: reqId, title, instructions, type, site_id, user_id } = requirement;
    console.log('[Cron Auto] cron debug pick', {
      dueCount: dueRequirements.length,
      reqId,
      status: requirement.status,
      type,
    });

    // Per-requirement advisory lock (see cron-run-lock.ts). Cron-automations
    // fires every minute; many automation workflows take longer than that,
    // so without this lock overlapping runs race on the same feature branch.
    const runLock = await acquireRunLock(reqId);
    console.log('[Cron Auto] cron debug lock', {
      reqId,
      acquired: runLock != null,
      runId: runLock?.runId ?? null,
    });
    if (!runLock) {
      console.log(`[Cron Auto] Skipping ${reqId} — another workflow is already running (lock held)`);
      return NextResponse.json({
        message: `Requirement ${reqId} is locked by another workflow; skipping tick.`,
        reqId,
        skipped: true,
      });
    }

    console.log(`[Cron Auto] Processing automation ${reqId}: ${title} (lock runId=${runLock.runId})`);

    // Find or create remote_instance
    let instanceId: string | undefined;
    const { data: prevStatuses } = await supabaseAdmin
      .from('requirement_status')
      .select('instance_id, status, message, preview_url, repo_url, created_at')
      .eq('requirement_id', reqId)
      .not('instance_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10);

    if (prevStatuses?.[0]?.instance_id) {
      instanceId = prevStatuses[0].instance_id;
    } else {
      const { data: instances } = await supabaseAdmin
        .from('remote_instances')
        .select('id')
        .eq('site_id', site_id)
        .eq('name', `req-auto-${reqId}`)
        .limit(1);

      if (instances?.length) {
        instanceId = instances[0].id;
      } else {
        const { data: newInstance, error: insertErr } = await supabaseAdmin
          .from('remote_instances')
          .insert({
            name: `req-auto-${reqId}`,
            site_id,
            user_id,
            created_by: user_id,
            status: 'pending',
            instance_type: 'browser',
            provider_instance_id: null,
            cdp_url: null,
          })
          .select('id')
          .single();
        if (insertErr) console.error('[Cron Auto] Error inserting remote_instance:', insertErr);
        instanceId = newInstance?.id;
      }
    }

    if (!instanceId) throw new Error('Failed to create or find remote_instance');

    const { data: prevPlans } = await supabaseAdmin
      .from('instance_plans')
      .select('id, title, status, steps')
      .eq('instance_id', instanceId)
      .order('created_at', { ascending: false })
      .limit(3);

    const latestStatus = prevStatuses?.[0];
    let blockerContext = '';
    if (latestStatus && latestStatus.status !== 'done') {
      const blockers: string[] = [];
      if (latestStatus.message?.includes('preview_url returns error/404')) {
        blockers.push('CRITICAL: The deployed preview URL returns 404. The app has no working root page. Fix the root route first.');
      }
      if (latestStatus.message?.includes('no push')) {
        blockers.push('WARNING: Last cycle produced no git push. Write actual files.');
      }
      if (latestStatus.message?.includes('plan not completed')) {
        blockers.push('WARNING: Last plan did not complete all steps.');
      }
      if (blockers.length) {
        blockerContext = `\n⚠️ BLOCKERS FROM LAST CYCLE (MUST ADDRESS FIRST):\n${blockers.map(b => `- ${b}`).join('\n')}\n`;
      }
    }

    const previousWorkContext = [
      blockerContext,
      (prevStatuses?.length || prevPlans?.length)
        ? `\nPREVIOUS WORK:\n${latestStatus ? `- Latest status: ${latestStatus.status} — ${latestStatus.message || 'no message'}` : ''}\n${prevPlans?.length ? `- Recent plans: ${prevPlans.map((p: any) => `${p.title} (${p.status})`).join(', ')}` : ''}\n`
        : '',
    ].filter(Boolean).join('\n');

    console.log(`[Cron Auto] Starting workflow for req ${reqId}, instance ${instanceId}`);
    const workflowRun = await start(runCronAutoWorkflow, [{
      reqId, title, instructions, type, site_id, user_id, instanceId, previousWorkContext,
      cronLockRunId: runLock.runId,
    }]);

    return new Response(workflowRun.readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'X-Workflow-Run-Id': workflowRun.runId },
    });

  } catch (e: any) {
    console.error(`[Cron Auto] Error:`, e?.message || e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
