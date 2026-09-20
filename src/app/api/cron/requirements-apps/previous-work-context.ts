import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function buildPreviousWorkContext(
  requirementId: string,
  instanceId: string,
): Promise<string> {
  const { data: statuses } = await supabaseAdmin
    .from('requirement_status')
    .select('stage, message, preview_url, repo_url, created_at')
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: plans } = await supabaseAdmin
    .from('instance_plans')
    .select('id, title, status, steps')
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(3);

  const latestStatus = statuses?.[0];
  const blockers: string[] = [];
  if (latestStatus && latestStatus.stage !== 'done') {
    if (latestStatus.message?.includes('preview_url returns error/404')) {
      blockers.push(
        'CRITICAL: The deployed preview URL returns 404. The app has no working root page. You MUST create a plan step to fix the root route (e.g. src/app/page.tsx).',
      );
    }
    if (latestStatus.message?.includes('no push')) {
      blockers.push(
        'WARNING: Last cycle produced no git push. The agent must write actual files, not just update metadata.',
      );
    }
    if (latestStatus.message?.includes('plan not completed')) {
      blockers.push(
        'WARNING: Last cycle failed because you did not call the `instance_plan` tool with action="create". You MUST use the `instance_plan` tool to create the execution plan for the current backlog item. Do not try to fix code; just create the plan.',
      );
    }
    if (!latestStatus.preview_url) {
      blockers.push(
        'DELIVERY CHECK PENDING: No preview URL is available. This blocks only deployment/browser validation; continue any source, test, or documentation work that does not require the preview.',
      );
    }
  }

  const blockerContext = blockers.length
    ? `\n⚠️ SCOPED ISSUES FROM LAST CYCLE:\n${blockers.map((blocker) => `- ${blocker}`).join('\n')}\n`
    : '';
  const historyContext = statuses?.length || plans?.length
    ? `\nPREVIOUS WORK:\n${statuses?.length ? `- Latest stage: ${latestStatus?.stage} — ${latestStatus?.message || 'no message'}` : ''}\n${plans?.length ? `- Recent plans: ${plans.map((plan: any) => `${plan.title} (${plan.status})`).join(', ')}` : ''}\n`
    : '';

  return [blockerContext, historyContext].filter(Boolean).join('\n');
}
