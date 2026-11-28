import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { runCronAppsWorkflow } from './workflow';
import { getMaxConcurrentRequirementRuns, getRequirementEvaluationLimit } from './scheduler-config';
import { claimRequirementRun, dueScheduledRequirements, finishRequirementCycle } from '@/lib/harness/requirement-scheduler';
import { withCronObservation } from '@/lib/status/cron-observation';
import { schedulerObservation } from '@/lib/status/requirement-scheduler-observation';
import { retryPendingCloudGit } from '@/lib/cloud-files/retry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** The existing minute cron admits work. Quality checks are tools, not admission gates. */
async function runCron(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const observation = schedulerObservation();
  const { measure, headers, complete } = observation;
  try {
    // Runs independently of model admission; a completed document can still have
    // pending Git evidence. Keep the existing cron and bound the retry workload.
    const evidence = measure('cloud_git', () => retryPendingCloudGit()).catch(() => ({ attempted: 0, committed: 0 }));
    const scheduledIds = await measure('scheduled', () => dueScheduledRequirements());
    const excluded: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    const maximum = getMaxConcurrentRequirementRuns();
    const limit = Math.min(getRequirementEvaluationLimit(), 100);
    let stop: 'empty' | 'capacity_full' | 'limit' | 'deadline' = 'deadline';
    const deadline = Date.now() + 45000;
    while (excluded.length < limit && Date.now() < deadline) {
      const claim = await measure('claim', () => claimRequirementRun(excluded, maximum, scheduledIds, observation));
      if (!claim) { stop = 'empty'; break; }
      if (claim.state === 'capacity_full') { stop = 'capacity_full'; break; }
      observation.claimed();
      excluded.push(claim.run.requirementId);
      try {
        const workflow = await measure('dispatch', () => start(runCronAppsWorkflow, [claim.run]));
        results.push({ reqId: claim.run.requirementId, sessionId: claim.run.sessionId, runId: workflow.runId, started: true });
      } catch {
        await measure('finish', () => finishRequirementCycle(claim.run, 'waiting', 'dispatch_unavailable', 'Execution could not be dispatched. A later cron tick will retry this same session.'));
        results.push({ reqId: claim.run.requirementId, sessionId: claim.run.sessionId, started: false });
      }
    }
    const cloudGit = await evidence;
    if (excluded.length >= limit) stop = 'limit';
    return complete(NextResponse.json({ results, capacityReached: stop === 'capacity_full', evaluatedRequirements: excluded.length, cloudGit }, { headers: headers() }), stop);
  } catch {
    return complete(NextResponse.json({ error: 'Requirement scheduler unavailable; no legacy executor fallback was started' }, { status: 503, headers: headers() }), 'error');
  }
}

export const GET = withCronObservation('requirements-apps', runCron);