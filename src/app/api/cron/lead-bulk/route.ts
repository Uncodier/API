import { createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { withCronObservation } from '@/lib/status/cron-observation';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const queues = ['assistant_lead_job_tick', 'assistant_lead_job_select_tick'] as const;
const prune = 'assistant_lead_job_prune';
type LeadBulkRpc = typeof queues[number] | typeof prune;

function reportFailure(rpc: LeadBulkRpc, error: unknown, kind: 'rpc_error' | 'invalid_receipt' | 'exception') {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  const safeCode = typeof code === 'string' && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(code) ? code : undefined;
  console.error('[LeadBulkCron] Worker unavailable', {
    rpc,
    reason: safeCode === 'PGRST202' ? 'rpc_missing_from_schema_cache' : kind,
    ...(safeCode ? { code: safeCode } : {}),
  });
  return Response.json({ success: false, error: 'Lead bulk worker unavailable' }, { status: 503 });
}

async function runCron(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!secret || !timingSafeEqual(digest(request.headers.get('authorization') || ''), digest(`Bearer ${secret}`))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deadline = Date.now() + 40_000;
  let appliedBatches = 0, stagedPages = 0, retryingBatches = 0, failedJobs = 0;
  const empty = new Set<typeof queues[number]>();
  let rpc: LeadBulkRpc = queues[0];
  try {
    for (let i = 0, calls = 0; calls < 20 && empty.size < queues.length && Date.now() < deadline; i++) {
      const queue = queues[i % queues.length];
      if (empty.has(queue)) continue;
      calls++;
      rpc = queue;
      const { data, error } = await supabaseAdmin.rpc(queue).abortSignal(AbortSignal.timeout(8_000));
      if (error) return reportFailure(rpc, error, 'rpc_error');
      if (data?.success !== true) return reportFailure(rpc, null, 'invalid_receipt');
      if (data.processed === false) { empty.add(queue); continue; }
      if (data.outcome === 'applied') appliedBatches++;
      else if (data.outcome === 'staged') stagedPages++;
      else if (data.outcome === 'retry') retryingBatches++;
      else if (data.outcome === 'failed') failedJobs++;
      else return reportFailure(rpc, null, 'invalid_receipt');
    }
    rpc = prune;
    const { error } = await supabaseAdmin.rpc(prune).abortSignal(AbortSignal.timeout(5_000));
    if (error) return reportFailure(rpc, error, 'rpc_error');
    return Response.json({ success: true, appliedBatches, stagedPages, retryingBatches, failedJobs });
  } catch (error) {
    return reportFailure(rpc, error, 'exception');
  }
}

export const GET = withCronObservation('lead-bulk', runCron);