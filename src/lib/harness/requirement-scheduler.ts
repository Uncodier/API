import { CronExpressionParser } from 'cron-parser';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { RequirementClaim, RequirementRun } from './requirement-types';

export async function dueScheduledRequirements(now = new Date()): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from('requirements').select('id,cron,updated_at,metadata')
    .not('cron', 'is', null).in('status', ['done', 'on-review']).gte('created_at', '2026-09-01T00:00:00Z')
    .order('updated_at', { ascending: true }).limit(100);
  if (error) throw new Error('Scheduled requirements unavailable');
  return (data || []).filter(row => {
    if (row.metadata?.execution_hold) return false;
    try {
      const previous = CronExpressionParser.parse(row.cron, { currentDate: now }).prev().toDate();
      return previous.getTime() > Date.parse(row.updated_at);
    } catch { return false; }
  }).map(row => row.id);
}

export async function claimRequirementRun(excluded: string[], maxConcurrent: number, scheduledIds: string[]): Promise<RequirementClaim | { state: 'capacity_full' } | null> {
  const { data, error } = await supabaseAdmin.rpc('claim_agent_requirement_run', {
    p_excluded_ids: excluded, p_max_concurrent: maxConcurrent, p_ttl_seconds: 300, p_scheduled_ids: scheduledIds,
  });
  if (error) throw new Error('Agent cron admission unavailable; deploy its forward migration before the API');
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