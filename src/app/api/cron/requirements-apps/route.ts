import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { runCronAppsWorkflow } from './workflow';
import { getMaxConcurrentRequirementRuns, getRequirementEvaluationLimit } from './scheduler-config';
import { claimRequirementRun, dueScheduledRequirements, finishRequirementCycle } from '@/lib/harness/requirement-scheduler';
import { withCronObservation } from '@/lib/status/cron-observation';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** The existing minute cron admits work. Quality checks are tools, not admission gates. */
async function runCron(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scheduledIds = await dueScheduledRequirements();
    const excluded: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    const maximum = getMaxConcurrentRequirementRuns();
    const limit = Math.min(getRequirementEvaluationLimit(), 100);
    let capacityReached = false;
    const deadline = Date.now() + 45000;
    while (excluded.length < limit && Date.now() < deadline) {
      const claim = await claimRequirementRun(excluded, maximum, scheduledIds);
      if (!claim) break;
      if (claim.state === 'capacity_full') { capacityReached = true; break; }
      excluded.push(claim.run.requirementId);
      try {
        const workflow = await start(runCronAppsWorkflow, [claim.run]);
        results.push({ reqId: claim.run.requirementId, sessionId: claim.run.sessionId, runId: workflow.runId, started: true });
      } catch {
        await finishRequirementCycle(claim.run, 'waiting', 'dispatch_unavailable', 'Execution could not be dispatched. A later cron tick will retry this same session.');
        results.push({ reqId: claim.run.requirementId, sessionId: claim.run.sessionId, started: false });
      }
    }
    return NextResponse.json({ results, capacityReached, evaluatedRequirements: excluded.length });
  } catch {
    return NextResponse.json({ error: 'Requirement scheduler unavailable; no legacy executor fallback was started' }, { status: 503 });
  }
}

export const GET = withCronObservation('requirements-apps', runCron);