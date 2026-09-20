import type { BacklogItem } from './requirement-backlog-types';

function gatingItems(items: BacklogItem[]): BacklogItem[] {
  const core = items.filter((item) => (item.tier ?? 'core') === 'core');
  return core.length > 0 ? core : items;
}

/**
 * True when a real user message was recorded after the gating backlog was
 * completed. That message is explicit permission to expand a closed backlog.
 */
export async function hasUserRequestedMoreWork(
  requirementId: string,
): Promise<boolean> {
  const { supabaseAdmin } = await import('@/lib/database/supabase-server');
  const { data: requirement } = await supabaseAdmin
    .from('requirements')
    .select('metadata, backlog')
    .eq('id', requirementId)
    .single();

  const instanceId = (
    requirement?.metadata as Record<string, unknown> | undefined
  )?.runner_instance_id;
  if (typeof instanceId !== 'string' || !instanceId) return false;

  const { data: actions } = await supabaseAdmin
    .from('instance_logs')
    .select('created_at')
    .eq('instance_id', instanceId)
    .eq('log_type', 'user_action')
    .order('created_at', { ascending: false })
    .limit(1);
  if (!actions?.length) return false;

  const lastUserActionTime = new Date(actions[0].created_at).getTime();
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

  return lastUserActionTime >= completedTime;
}
