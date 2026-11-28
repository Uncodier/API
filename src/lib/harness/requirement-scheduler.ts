import { CronExpressionParser } from 'cron-parser';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { ClaimFailure } from '@/lib/status/requirement-scheduler-observation';
import type { RequirementClaim, RequirementRun } from './requirement-types';

export async function dueScheduledRequirements(now = new Date()): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from('requirements').select('id,cron,updated_at,execution_hold:metadata->execution_hold')
    .not('cron', 'is', null).in('status', ['done', 'on-review'])
    .or('created_at.gte.2026-09-01T00:00:00Z,updated_at.gte.2026-09-01T00:00:00Z')
    .order('updated_at', { ascending: true }).limit(100);
  if (error) throw new Error('Scheduled requirements unavailable');
  return (data || []).filter(row => {
    if (row.execution_hold) return false;
    try {
      const previous = CronExpressionParser.parse(row.cron, { currentDate: now }).prev().toDate();
      return previous.getTime() > Date.parse(row.updated_at);
    } catch { return false; }
  }).map(row => row.id);
}

export async function claimRequirementRun(excluded: string[], maxConcurrent: number, scheduledIds: string[],
  observation?: { claimStages(raw: unknown): void; claimFailure(category: ClaimFailure): void },
): Promise<RequirementClaim | { state: 'capacity_full' } | null> {
  const query = supabaseAdmin.rpc('claim_agent_requirement_run', {
    p_excluded_ids: excluded, p_max_concurrent: maxConcurrent, p_ttl_seconds: 300, p_scheduled_ids: scheduledIds,
  });
  const { data, error } = await (observation ? query.setHeader('x-claim-timings', '1') : query);
  if (error) {
    // RPC installation is not inferred from unrelated database/transport failures.
    // Never include database error bodies: they can contain tenant data or SQL.
    if (error.code === 'PGRST202' || error.code === '42883') {
      observation?.claimFailure('rpc_unavailable');
      throw new Error('Agent cron admission RPC unavailable; verify installed functions and schema cache');
    }
    const category: ClaimFailure = error.code === '57014' ? 'timeout'
      : ['55P03', '40P01'].includes(error.code) ? 'contention' : 'request_failed';
    observation?.claimFailure(category);
    throw new Error(`Agent cron admission unavailable (database ${category === 'request_failed' ? 'request failed' : category})`);
  }
  // An older database ignores the opt-in header. Never retry a mutating RPC.
  if (observation && data && Object.prototype.hasOwnProperty.call(data, 'claim')) {
    observation.claimStages(data.stage_ms);
    return data.claim;
  }
  return data;
}

export async function assertRequirementRun(run: RequirementRun, allowTerminal = false): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('assert_agent_requirement_run', {
    p_requirement_id: run.requirementId, p_run_id: run.runId, p_generation: run.executionGeneration,
    p_session_id: run.sessionId, p_allow_terminal: allowTerminal, p_renew_seconds: 300,
  });
  if (error || data !== true) throw new Error('Requirement execution ownership changed');
}

export async function finishRequirementCycle(run: RequirementRun, status: string, reason: string, summary: string, repoUrl?: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('finish_agent_requirement_cycle', {
    p_requirement_id: run.requirementId, p_run_id: run.runId, p_generation: run.executionGeneration,
    p_session_id: run.sessionId, p_session_status: status, p_reason: reason,
    p_summary: summary, p_repo_url: repoUrl || null,
  });
  if (error) throw new Error('Requirement cycle outcome persistence unavailable');
  if (data !== true) throw new Error('Requirement cycle ownership changed; outcome was not applied');
}