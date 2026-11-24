import { createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { withCronObservation } from '@/lib/status/cron-observation';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function runCron(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!secret || !timingSafeEqual(digest(request.headers.get('authorization') || ''), digest(`Bearer ${secret}`))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deadline = Date.now() + 40_000;
  let appliedBatches = 0, stagedPages = 0, retryingBatches = 0, failedJobs = 0;
  const queues = ['assistant_lead_job_tick', 'assistant_lead_job_select_tick'] as const;
  const empty = new Set<typeof queues[number]>();
  try {
    for (let i = 0, calls = 0; calls < 20 && empty.size < queues.length && Date.now() < deadline; i++) {
      const queue = queues[i % queues.length];
      if (empty.has(queue)) continue;
      calls++;
      const { data, error } = await supabaseAdmin.rpc(queue).abortSignal(AbortSignal.timeout(8_000));
      if (error || data?.success !== true) throw new Error('Lead bulk tick unavailable');
      if (data.processed === false) { empty.add(queue); continue; }
      if (data.outcome === 'applied') appliedBatches++;
      else if (data.outcome === 'staged') stagedPages++;
      else if (data.outcome === 'retry') retryingBatches++;
      else if (data.outcome === 'failed') failedJobs++;
      else throw new Error('Invalid lead bulk tick receipt');
    }
    const { error } = await supabaseAdmin.rpc('assistant_lead_job_prune').abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('Lead bulk pruning unavailable');
    return Response.json({ success: true, appliedBatches, stagedPages, retryingBatches, failedJobs });
  } catch {
    return Response.json({ success: false, error: 'Lead bulk worker unavailable' }, { status: 503 });
  }
}

export const GET = withCronObservation('lead-bulk', runCron);