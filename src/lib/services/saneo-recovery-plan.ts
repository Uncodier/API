import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createInstancePlanCore } from '@/app/api/agents/tools/instance_plan/create/route';
import { getActivePlans, resumePlan } from '@/lib/helpers/plan-lifecycle';

/**
 * After auto-saneo, the instance must not stay pending with no executable plan.
 * Resume a paused/cancelled-but-reusable plan, or create a 1-step recovery plan
 * bound to the first reopened backlog item.
 */
export async function ensureActivePlanAfterSaneo(params: {
  requirementId: string;
  instanceId?: string | null;
  siteId?: string | null;
  reopenedItemIds: string[];
}): Promise<void> {
  const instanceId = String(params.instanceId || '').trim();
  const siteId = String(params.siteId || '').trim();
  if (!instanceId || !siteId) {
    console.warn('[AutoSaneo] Cannot ensure recovery plan — missing instance_id or site_id');
    return;
  }

  const active = await getActivePlans(instanceId);
  if (active.length > 0) return;

  const { data: recent } = await supabaseAdmin
    .from('instance_plans')
    .select('id, status, metadata, user_id')
    .eq('instance_id', instanceId)
    .order('updated_at', { ascending: false })
    .limit(8);

  const paused = (recent || []).find((p) => p.status === 'paused');
  if (paused?.id) {
    await resumePlan(paused.id);
    console.log(`[AutoSaneo] Resumed paused plan ${paused.id}`);
    return;
  }

  const saneoCancelled = (recent || []).find((p) => {
    if (!/^(cancelled|failed)$/.test(String(p.status || ''))) return false;
    const blob = JSON.stringify(p.metadata || {}).toLowerCase();
    return blob.includes('auto-saneo');
  });
  if (saneoCancelled?.id) {
    await resumePlan(saneoCancelled.id);
    console.log(`[AutoSaneo] Reactivated plan ${saneoCancelled.id} (was ${saneoCancelled.status})`);
    return;
  }

  const userId = await resolveInstanceUserId(instanceId, recent);
  if (!userId) {
    console.warn('[AutoSaneo] Cannot create recovery plan — no user_id on instance or prior plans');
    return;
  }

  const itemId = params.reopenedItemIds[0];
  await createInstancePlanCore({
    instance_id: instanceId,
    site_id: siteId,
    user_id: userId,
    title: 'Recovery after auto-saneo',
    description: 'Resume the reopened backlog item. Do not restart from scratch.',
    steps: [
      {
        title: 'Continue reopened item',
        order: 1,
        status: 'pending',
        instructions:
          'Continue the backlog item reopened by auto-saneo. Use existing docs/ and commits; do not cancel remaining work.',
        metadata: itemId ? { backlog_item_id: itemId } : {},
        backlog_item_id: itemId,
      },
    ],
  });
  console.log(`[AutoSaneo] Created 1-step recovery plan for instance ${instanceId}`);
}

async function resolveInstanceUserId(
  instanceId: string,
  recentPlans?: Array<{ user_id?: string | null } | null>,
): Promise<string | null> {
  const fromPlan = (recentPlans || []).map((p) => p?.user_id).find((id) => !!id);
  if (fromPlan) return fromPlan;
  for (const table of ['remote_instances', 'robot_instances'] as const) {
    const { data } = await supabaseAdmin
      .from(table)
      .select('user_id')
      .eq('id', instanceId)
      .maybeSingle();
    const uid = (data as { user_id?: string } | null)?.user_id;
    if (uid) return uid;
  }
  return null;
}
