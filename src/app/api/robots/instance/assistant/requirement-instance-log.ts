import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createRedactor, redactData } from '@/lib/harness/security';
import type { RequirementRun } from '@/lib/harness/requirement-types';

export interface RequirementLogEvent {
  key: string;
  log_type: string;
  message: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_args?: any;
  tool_result?: any;
  is_error?: boolean;
  details?: Record<string, unknown>;
}

/** Stable IDs make receipt retries safe; never replay an effect for a log failure. */
export async function writeRequirementInstanceLog(run: RequirementRun, event: RequirementLogEvent,
  redact: (value: string) => string = createRedactor()): Promise<void> {
  const hex = createHash('sha256').update(`${run.siteId}:${run.instanceId}:${run.sessionId}:${event.key}`).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const { key, details, ...payload } = redactData(event, redact) as RequirementLogEvent;
  const { error } = await supabaseAdmin.from('instance_logs').upsert({
    ...payload, id, instance_id: run.instanceId, site_id: run.siteId, user_id: run.userId,
    level: event.is_error ? 'error' : 'info', trusted_user_action: false,
    details: { ...details, event_key: key, execution_mode: 'requirement',
      requirement_id: run.requirementId, session_id: run.sessionId, run_id: run.runId,
      execution_generation: run.executionGeneration },
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) {
    const failure = new Error('Instance execution audit persistence unavailable');
    failure.name = 'RecoveryError';
    throw failure;
  }
}