import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WorkspaceError } from '@/lib/harness/workspace';

export type AssistantWorkspaceScope = { instanceId: string; siteId: string; userId: string };
export type AssistantWorkspaceSource = { kind: 'instance' } | {
  kind: 'requirement'; requirementId: string; sandboxName: string;
} | { kind: 'workflow'; planId: string; sandboxName: string };
const fail = (code: string, message: string): never => { throw new WorkspaceError(code, message, false); };

/** Resolve binding independently of runnable status, including completed work.
 * No user/model-selected sandbox IDs, no 'latest status wins' across requirements.
 */
export async function resolveAssistantWorkspaceSource(scope: AssistantWorkspaceScope): Promise<AssistantWorkspaceSource> {
  const { data: instance, error } = await supabaseAdmin.from('remote_instances')
    .select('id,site_id,is_archived').eq('id', scope.instanceId).eq('site_id', scope.siteId).maybeSingle();
  if (error) return fail('WORKSPACE_LOOKUP_UNAVAILABLE', 'Workspace ownership could not be checked.');
  if (!instance || instance.site_id !== scope.siteId || instance.is_archived) {
    return fail('WORKSPACE_SCOPE_MISMATCH', 'This instance is not available for workspace access.');
  }
  const [assigned, firstPage] = await Promise.all([
    supabaseAdmin.from('requirements').select('id,site_id').eq('site_id', scope.siteId)
      .eq('metadata->>runner_instance_id', scope.instanceId).limit(2),
    supabaseAdmin.from('requirement_status').select('requirement_id,active_sandbox_id')
      .eq('instance_id', scope.instanceId).eq('site_id', scope.siteId).order('created_at', { ascending: false })
      .order('id', { ascending: false }).range(0, 499),
  ]);
  if (assigned.error || firstPage.error) return fail('WORKSPACE_LOOKUP_UNAVAILABLE', 'Workspace binding lookup is unavailable.');
  const history = [...(firstPage.data ?? [])];
  let pageSize = firstPage.data?.length ?? 0;
  for (let offset = 500; pageSize === 500; offset += 500) {
    if (offset >= 10000) return fail('WORKSPACE_BINDING_UNAVAILABLE', 'Workspace history requires a scoped binding review; no empty workspace was substituted.');
    const page = await supabaseAdmin.from('requirement_status').select('requirement_id,active_sandbox_id')
      .eq('instance_id', scope.instanceId).eq('site_id', scope.siteId).order('created_at', { ascending: false })
      .order('id', { ascending: false }).range(offset, offset + 499);
    if (page.error) return fail('WORKSPACE_LOOKUP_UNAVAILABLE', 'Workspace binding lookup is unavailable.');
    history.push(...(page.data ?? []));
    pageSize = page.data?.length ?? 0;
  }
  const ids = new Set<string>([...(assigned.data ?? []).map(row => row.id),
    ...history.map(row => row.requirement_id).filter((id): id is string => typeof id === 'string')]);
  if (ids.size > 1) return fail('WORKSPACE_BINDING_AMBIGUOUS', 'This instance has conflicting requirement bindings; no workspace was selected.');
  if (!ids.size) {
    const plans = await supabaseAdmin.from('instance_plans').select('id,metadata->active_sandbox_id')
      .eq('site_id', scope.siteId).eq('instance_id', scope.instanceId)
      .not('metadata->active_sandbox_id', 'is', null).order('created_at', { ascending: false }).limit(1);
    if (plans.error) return fail('WORKSPACE_LOOKUP_UNAVAILABLE', 'The workflow workspace reference could not be checked.');
    const plan = plans.data?.[0];
    if (plan?.active_sandbox_id) {
      await assertSourceBilling(String(plan.active_sandbox_id), scope.siteId, 'workflow', plan.id);
      return { kind: 'workflow', planId: plan.id, sandboxName: String(plan.active_sandbox_id) };
    }
    return { kind: 'instance' };
  }
  const requirementId = [...ids][0];
  const requirement = await supabaseAdmin.from('requirements').select('id,site_id')
    .eq('id', requirementId).eq('site_id', scope.siteId).maybeSingle();
  if (requirement.error || !requirement.data || requirement.data.site_id !== scope.siteId) {
    return fail('WORKSPACE_SCOPE_MISMATCH', 'The linked requirement is not accessible in this site.');
  }
  const sessions = await supabaseAdmin.from('harness_sessions').select('id,site_id,snapshot->workspace')
    .eq('site_id', scope.siteId).eq('snapshot->request->>requirementId', requirementId)
    .not('snapshot->workspace', 'is', null).order('snapshot->>updatedAt', { ascending: false })
    .order('id', { ascending: false }).limit(1);
  if (sessions.error) return fail('WORKSPACE_LOOKUP_UNAVAILABLE', 'The saved workspace reference could not be read.');
  const saved = sessions.data?.[0];
  const workspace = saved?.workspace as { id?: string; provider?: string; root?: string } | undefined;
  if (workspace && (saved.site_id !== scope.siteId || workspace.id !== `h-${saved.id}` ||
      workspace.provider !== 'vercel' || workspace.root !== '/vercel/sandbox')) {
    return fail('WORKSPACE_SCOPE_MISMATCH', 'The saved workspace reference does not match its owner.');
  }
  const sandboxName = workspace?.id ?? history.find(row => row.requirement_id === requirementId && row.active_sandbox_id)?.active_sandbox_id;
  if (!sandboxName) return fail('WORKSPACE_NOT_CREATED', 'The requirement has no saved workspace yet. This does not prove that no other deliverables exist.');
  if (!workspace) await assertSourceBilling(sandboxName, scope.siteId, 'requirement', requirementId);
  return { kind: 'requirement', requirementId, sandboxName };
}

/** Legacy refs live in editable product rows; the service-owned billing ledger
 * must confirm their actual tenant/owner before the provider is queried.
 */
async function assertSourceBilling(name: string, siteId: string, kind: string, ownerId: string): Promise<void> {
  const { data, error } = await supabaseAdmin.from('sandbox_billing_resources').select('site_id,owner_kind,owner_id')
    .eq('sandbox_name', name).eq('site_id', siteId).maybeSingle();
  if (error || !data || data.site_id !== siteId || data.owner_kind !== kind || data.owner_id !== ownerId) {
    return fail('WORKSPACE_SCOPE_MISMATCH', 'The legacy workspace owner could not be confirmed; no provider resource was accessed.');
  }
}