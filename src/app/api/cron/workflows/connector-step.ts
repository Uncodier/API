import { isDeepStrictEqual } from 'node:util';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { runWorkflowConnectorRead } from '@/lib/connectors/workflow-read';
import { connectorReadsEnabled, scheduledConnectorJob, type ScheduledConnectorJob } from './connector-admission';

export async function executeScheduledConnectorStep(job: ScheduledConnectorJob): Promise<'completed' | 'blocked'> {
  'use step';
  if (!connectorReadsEnabled()) return 'blocked';
  const scope = scheduledConnectorJob.safeParse(job);
  if (!scope.success) return 'blocked';
  const keys = { p_run: scope.data.run_id, p_job: scope.data.job_id };
  const rpc = (name: string, params: Record<string, unknown>) => supabaseAdmin.rpc(name, params).abortSignal(AbortSignal.timeout(6000));
  try {
    const bound = await rpc('workflow_connector_prepare', keys);
    if (bound.error?.code === '42501') return 'blocked';
    if (bound.error || !bound.data) throw new Error();
    const result = await runWorkflowConnectorRead(bound.data, async () => {
      if (!connectorReadsEnabled()) throw new Error();
      const dispatched = await rpc('workflow_connector_dispatch', keys);
      if (!connectorReadsEnabled() || dispatched.error || !isDeepStrictEqual(bound.data, dispatched.data)) throw new Error();
    });
    const finished = await rpc('workflow_connector_finish', { ...keys, p_result: result });
    if (finished.error || finished.data !== true) throw new Error();
    return 'completed';
  } catch {
    // Never persist raw provider errors, private outputs or authorization bindings in workflow history.
    throw new Error('Scheduled connector outcome could not be confirmed. Do not replay this occurrence.');
  }
}
executeScheduledConnectorStep.maxRetries = 0;
