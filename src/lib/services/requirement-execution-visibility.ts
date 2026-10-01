import { supabaseAdmin } from '@/lib/database/supabase-client';

export type RequirementMigrationHold = {
  file: string;
  state: 'platform_review' | 'reviewing';
  reason: string;
  attempts: number;
  updated_at: string;
};

/** Read operational facts, not SQL, review prompts, credentials or model history. */
export async function loadRequirementMigrationHolds(requirementId: string): Promise<RequirementMigrationHold[]> {
  const { data, error } = await supabaseAdmin.from('requirement_migration_lifecycle')
    .select('file,state,reason,attempts,updated_at')
    .eq('requirement_id', requirementId)
    .in('state', ['platform_review', 'reviewing']);
  if (error || !Array.isArray(data)) throw new Error('Migration execution state is unavailable.');
  return data;
}

export function migrationHoldContext(holds: RequirementMigrationHold[]): string {
  if (!holds.length) return '';
  return '\n\nAUTHORITATIVE EXECUTION HOLD (overrides historical progress messages):\n' +
    JSON.stringify(holds, null, 2) +
    '\nExecution is blocked. Updating a plan step is NOT a resume or a worker assignment. ' +
    'Do not claim execution started or that a reviewer is assigned. Technical reconciliation is required; ' +
    'generic user approval cannot release this hold. Attempts count assignments/reviews, not proven executed repairs. ' +
    'Exhaustion is not proof that repair is impossible.';
}

/** A status-reporting tool must not pretend to resume a non-runnable requirement. */
export async function requirementStepExecutionBlock(requirementId: string, siteId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from('requirements')
    .select('status').eq('id', requirementId).eq('site_id', siteId).maybeSingle();
  if (error || !data) throw new Error('Requirement execution state is unavailable.');
  const holds = await loadRequirementMigrationHolds(requirementId);
  if (holds.length) return holds.map(hold => `${hold.file}: ${hold.reason}`).join('\n');
  if (!['backlog', 'in-progress'].includes(data.status)) {
    return `Requirement is ${data.status}. Updating a step cannot resume its executor.`;
  }
  return null;
}