import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveAssistantPlanOwnership } from './plan-ownership';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reject(): never {
  throw new Error('Submit requirement changes with requirements action="update". Requirement plans belong to the sole runner.');
}

/** Standalone is established from the stored plan and host session, not absent model fields. */
export async function assertStandaloneCommandPlan(
  args: Record<string, any>, siteId: string, instanceId: string, requirementId?: string,
): Promise<void> {
  if (args?.action === 'list') return;
  if (requirementId || args?.requirement_id || (args?.instance_id != null && args.instance_id !== instanceId)) reject();
  let storedRequirement: string | undefined;
  if (args?.action !== 'create') {
    if (typeof args?.plan_id !== 'string' || !UUID.test(args.plan_id)) reject();
    const { data: plan, error } = await supabaseAdmin.from('instance_plans')
      .select('id,instance_id,metadata').eq('id', args.plan_id).eq('site_id', siteId).maybeSingle();
    if (error || !plan || plan.instance_id !== instanceId) reject();
    storedRequirement = plan.metadata?.requirement_id;
    if (storedRequirement) reject();
  }
  const ownership = await resolveAssistantPlanOwnership({ instanceId, siteId, planRequirementId: storedRequirement });
  if (ownership.state !== 'standalone') reject();
}