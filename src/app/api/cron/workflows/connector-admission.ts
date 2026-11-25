import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { deadline } from './cron-control';

export const scheduledConnectorJob = z.object({ run_id: z.string().uuid(), job_id: z.string().uuid() }).strict();
export type ScheduledConnectorJob = z.infer<typeof scheduledConnectorJob>;
export const connectorReadsEnabled = () => process.env.WORKFLOW_CONNECTOR_READS_ENABLED === 'true';

export async function isConnectorWorkflow(instance: string, signal = AbortSignal.timeout(5000)): Promise<boolean> {
  signal.throwIfAborted();
  const route = await supabaseAdmin.rpc('workflow_connector_route', { p_instance: instance }).abortSignal(deadline(signal, 5000));
  if (route.error || typeof route.data !== 'boolean') throw new Error('Workflow connector admission is unavailable.');
  return route.data;
}

export async function prepareScheduledConnector(instance: string, trigger: string, occurrence: string, signal: AbortSignal) {
  if (!await isConnectorWorkflow(instance, signal)) return { kind: 'legacy' } as const;
  if (!connectorReadsEnabled()) return { kind: 'connector_disabled' } as const;
  signal.throwIfAborted();
  const bound = await supabaseAdmin.rpc('workflow_connector_bind', {
    p_instance: instance, p_trigger: trigger, p_occurrence: occurrence, p_run: randomUUID(), p_job: randomUUID(),
  }).abortSignal(deadline(signal, 6000));
  if (bound.error?.code === '23505') return { kind: 'duplicate' } as const;
  if (bound.error?.code === '42501') return { kind: 'blocked' } as const;
  if (bound.error || !bound.data) throw new Error('Workflow connector reservation is unavailable.');
  // The binding is private. Only a separate lease holder may enqueue this run.
  return { kind: 'reserved' } as const;
}
