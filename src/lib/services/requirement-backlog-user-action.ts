import type { BacklogItem } from './requirement-backlog-types';

function gatingItems(items: BacklogItem[]): BacklogItem[] {
  const core = items.filter((item) => (item.tier ?? 'core') === 'core');
  return core.length > 0 ? core : items;
}

/**
 * Requirement-scoped permission to expand a completed backlog. Command-backed
 * user messages count only after safe-boundary application; legacy recovery
 * receipts retain their completion watermark check.
 */
export async function hasUserRequestedMoreWork(
  requirementId: string,
): Promise<boolean> {
  const { supabaseAdmin } = await import('@/lib/database/supabase-server');
  const { data: requirement, error: requirementError } = await supabaseAdmin
    .from('requirements')
    .select('backlog')
    .eq('id', requirementId)
    .single();

  if (requirementError || !requirement) return false;

  const backlogData = requirement?.backlog as
    | Record<string, unknown>
    | undefined;
  const items = (
    Array.isArray(backlogData?.items) ? backlogData.items : []
  ) as BacklogItem[];
  const gating = gatingItems(items);
  const completedTime = gating.length
    ? Math.max(
        ...gating.map((item) =>
          new Date(item.updated_at || 0).getTime(),
        ),
      )
    : 0;

  if (!Number.isFinite(completedTime)) return false;
  // One database read distinguishes legacy recovery from command receipts.
  // Even a newer receipt cannot authorize work until its queued patch is applied.
  const { data, error } = await supabaseAdmin.rpc('has_requirement_scope_authorization', {
    p_requirement_id: requirementId,
    p_completed_at: new Date(completedTime).toISOString(),
  });
  return !error && data === true;
}
