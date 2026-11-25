import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { getConnectorPolicy, getConnectorProvider, getMemberGrant, getVisibleConnector,
  loadConnectorCredential, requireConnectorSiteAccess } from './account-access';
import { providerId, toolkitSlug, toolSlug } from './composio-validation';
import { readProviderBinding } from './provider-project-binding';
import { ConnectorError, isGrantCurrent } from './types';

const uuid = z.string().uuid();
export const release = z.string().length(11).regex(/^20\d{6}_\d{2}$/);
export const workflowActor = z.object({site_id:uuid, principal_id:uuid, connector_id:uuid, tool_slug:toolSlug});
const accountPin = workflowActor.extend({
  provider_id:uuid, connector_revision:z.number().int().positive().safe(), provider_project_id:providerId,
  provider_user_id:uuid, provider_account_id:providerId, auth_config_id:providerId,
  credential_revision:z.string().regex(/^(?:platform:)?[a-f0-9]{64}$/), toolkit_slug:toolkitSlug,
});
export const workflowBinding = accountPin.extend({toolkit_version:release,
  schema_hash:z.string().length(64).regex(/^[a-f0-9]+$/), arguments:z.record(z.unknown()),
}).strict();
export type WorkflowConnectorReadBinding = z.infer<typeof workflowBinding>;
export type WorkflowActor = z.infer<typeof workflowActor>;
export type WorkflowAccountPin = z.infer<typeof accountPin>;

export function denied(): never {
  throw new ConnectorError('WORKFLOW_READ_DENIED', 'The delegated connector read was not authorized.', 403);
}

/** For an author or scheduled principal. Does not establish a delegation: only the
 * workflow RPC can bind/claim the isolated downstream resource and immutable publication. */
export async function workflowAccount(actor: WorkflowActor, expected?: WorkflowAccountPin) {
  const {site_id:site,principal_id:user,connector_id:id,tool_slug:slug} = actor;
  await requireConnectorSiteAccess(site,user,true);
  const [c, policy, member, screens] = await Promise.all([
    getVisibleConnector(site,user,id), getConnectorPolicy(site,id), getMemberGrant(site,user,id),
    loadToolScreenAccess({siteId:site,userId:user}),
  ]);
  if (!member || member.user_id !== user || !isGrantCurrent(member) || member.can_use !== true || member.can_view !== true ||
      !screens || (!screens.isAdmin && screens.blockedScreens.length !== 0) || !policy.allowed_hosts.includes('direct') ||
      !(policy.tool_access_mode === 'all' || (policy.tool_access_mode === 'selected' && policy.allowed_tools.includes(slug)))) denied();
  if (c.id !== id || c.site_id !== site || c.provider_account_id === 'instant_account' || c.supabase_project_ref !== null ||
      c.enabled !== true || c.provider_status !== 'ACTIVE' || !c.verified_at || c.revocation_pending !== false || c.revocation_dispatched !== false ||
      !slug.startsWith(c.toolkit_slug.toUpperCase().replaceAll('-','_')+'_')) denied();
  const p = await getConnectorProvider(site,c.provider_id);
  if (!p || p.site_id !== site || p.id !== c.provider_id || p.provider !== 'composio' || p.status !== 'active' ||
      p.project_id !== c.provider_project_id || p.provider_user_id !== site) denied();
  const pin = accountPin.parse({...actor, provider_id:p.id, connector_revision:c.revision, provider_project_id:p.project_id,
    provider_user_id:p.provider_user_id, provider_account_id:c.provider_account_id, auth_config_id:c.auth_config_id,
    credential_revision:p.credential_revision, toolkit_slug:c.toolkit_slug});
  if (expected && (Object.keys(pin) as Array<keyof WorkflowAccountPin>).some(k => pin[k] !== expected[k])) denied();
  const credential = await loadConnectorCredential(site);
  if (credential.revision !== pin.credential_revision || (credential.source === 'platform') !== credential.revision.startsWith('platform:') ||
      (credential.source === 'platform' && credential.revision !== `platform:${createHash('sha256').update(credential.apiKey).digest('hex')}`)) denied();
  const project = await readProviderBinding(site,credential.revision);
  if (project.projectId !== pin.provider_project_id) denied();
  return {pin,credential,scopes:c.granted_scopes};
}
