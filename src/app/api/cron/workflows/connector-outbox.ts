import { z } from 'zod';
import { start } from 'workflow/api';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorReadsEnabled, scheduledConnectorJob } from './connector-admission';
import { executeScheduledConnectorWorkflow } from './connector-workflow';
import { deadline, waitFor } from './cron-control';

// Claim only as many leases as we can immediately service, well inside 2min.
const BATCH = 8;
const claim = scheduledConnectorJob.extend({ lease_id: z.string().uuid() });
const claims = z.array(claim).max(BATCH);

export function queueBudget() { return { batches: 8, queued: 0, failed: 0 }; }

export async function drainConnectorQueue(signal: AbortSignal, budget: ReturnType<typeof queueBudget>) {
  try {
    while (connectorReadsEnabled() && budget.batches > 0) {
      signal.throwIfAborted();
      budget.batches--;
      const page = await supabaseAdmin.rpc('workflow_connector_claim_queue', { p_limit: BATCH }).abortSignal(deadline(signal, 6000));
      if (page.error) throw new Error();
      const leases = claims.parse(page.data);
      await Promise.all(leases.map(async ({ run_id, job_id, lease_id }) => {
        try {
          if (!connectorReadsEnabled()) return;
          const enqueueSignal = deadline(signal, 10_000);
          try {
            await waitFor(enqueueSignal, () => start(executeScheduledConnectorWorkflow, [{ run_id, job_id }]));
          } finally {
            // start() cannot be cancelled. Do not accumulate further outstanding
            // submissions if one of this batch's starts may still be in flight.
            if (enqueueSignal.aborted) budget.batches = 0;
          }
          // A timeout, rejection or stale lease is ambiguous. Never retry inline.
          signal.throwIfAborted();
          const ack = await supabaseAdmin.rpc('workflow_connector_ack_queue', {
            p_run: run_id, p_job: job_id, p_lease: lease_id,
          }).abortSignal(deadline(signal, 6000));
          if (ack.error || ack.data !== true) throw new Error();
          budget.queued++;
        } catch { budget.failed++; }
      }));
      if (leases.length < BATCH) break;
    }
  } catch { budget.failed++; }
}
