import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, getVisibleConnector, loadConnectorCredential, requireConnectorSiteAccess } from './account-access';
import { readTokenProviderBinding } from './provider-project-binding';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from './types';

import { isOrdinaryBusinessGrant, ordinaryBusinessScreens, connectedAccountReady,
  verifiedConnectionReady, type DirectAuthority, type DirectProof } from './provider-direct-authority';
export { isOrdinaryBusinessGrant } from './provider-direct-authority';

export type DirectAuthorizedConnector = AuthorizedConnector & { directProof: DirectAuthority };

const uuid = z.string().uuid();
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const ref = z.string().regex(/^[a-z]{20}$/);
const kit = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,99}$/);
const slug = z.string().regex(/^[A-Z0-9][A-Z0-9_]{0,149}$/).refine(v => !v.startsWith('COMPOSIO_') && !/[^A-Z0-9_]/.test(v));
const revision = z.number().int().positive(), instant = z.string().datetime({offset:true});
const account = z.object({
  connector: z.object({id:uuid,site_id:uuid,provider_id:uuid,provider_project_id:id,toolkit_slug:kit,provider_account_id:id,
    auth_config_id:id,display_name:z.string().min(1).max(200),supabase_project_ref:ref.nullable(),provider_status:z.literal('ACTIVE'),
    enabled:z.literal(true),access_mode:z.enum(['workspace','explicit']),revocation_pending:z.literal(false),revocation_dispatched:z.literal(false),
    granted_scopes:z.array(z.string().max(256)).max(200),created_by:uuid,revision,verified_at:instant}),
  provider: z.object({id:uuid,site_id:uuid,provider:z.literal('composio'),project_id:id,provider_user_id:uuid,
    credential_revision:z.string().regex(/^(platform:)?[a-f0-9]{64}$/),status:z.literal('active')}),
  policy: z.object({allowed_tools:z.array(z.string().max(200)).max(200),allowed_hosts:z.array(z.enum(['direct','assistant'])).max(2),
    revision,require_approval:z.boolean(),tool_access_mode:z.enum(['all','selected'])}),
  direct_revision:revision.max(2_147_483_647),
});
const attested = account.extend({
  auth_scheme:z.never().optional(),bound_project_ref:z.never().optional(),authority_kind:z.never().optional(),authorization_id:z.never().optional(),
  attestation_id:uuid,expires_at:instant,resource_boundary:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),local_installation_ref:ref.nullable(),
});
const ordinary = account.extend({authority_kind:z.literal('connected_account'),authorization_id:uuid}).strict();
const delegated = ordinary.extend({auth_scheme:z.enum(['OAUTH2','API_KEY']),bound_project_ref:ref.nullable()});
const verifiedConnection = account.extend({authority_kind:z.literal('verified_connection'),connection_attempt_id:uuid}).strict();
export const authorizedProviderRow = z.union([attested,ordinary,delegated,verifiedConnection]);
const screens = {required_screens:z.array(z.string().min(1).max(100)).max(100)};
export const authorizedSupportProviderRow = z.union([attested.extend(screens),ordinary.extend(screens),delegated.extend(screens)]).refine(r => {
  if (r.authority_kind!=='connected_account') return true;
  const expected = ordinaryBusinessScreens(r.connector.toolkit_slug);
  if ('auth_scheme' in r && r.required_screens.includes('*')) return true;
  if (!expected.length || !isOrdinaryBusinessGrant(r.connector.toolkit_slug,r.connector.granted_scopes)) return false;
  return expected.every(s => r.required_screens.includes(s));
});
const unavailable = () => new ConnectorError('DIRECT_POLICY_UNAVAILABLE','The direct connector policy could not be verified.',503);
const denied = () => new ConnectorError('DIRECT_POLICY_REQUIRED','Direct use is not available for this account, action and interactive session.',403);
const missing = () => new ConnectorError('NOT_FOUND','Connector not found.',404);
const deadline = () => AbortSignal.timeout(5_000);

async function admit(ctx:ConnectorContext, connectorId?:string, action?:string):Promise<DirectAuthorizedConnector[]> {
  if (typeof window!=='undefined' || ctx.host!=='assistant' || ctx.catalogUserSession!==true ||
    ![ctx.siteId,ctx.userId,ctx.instanceId,ctx.agentId].every(v=>uuid.safeParse(v).success)) {
    throw new ConnectorError('ACCESS_DENIED','Direct use requires a verified interactive member and agent.',403);
  }
  if (connectorId!==undefined && (!uuid.safeParse(connectorId).success || (ctx.connectorIdHint!==undefined && connectorId!==ctx.connectorIdHint))) throw missing();
  if (action!==undefined && !slug.safeParse(action).success) throw denied();
  const actor = {p_site_id:ctx.siteId,p_user_id:ctx.userId,p_instance_id:ctx.instanceId!,p_agent_id:ctx.agentId!};
  const result = await supabaseAdmin.rpc('connector_ask_connections',{...actor,p_connector_id:connectorId??null,p_slug:action??null}).abortSignal(deadline());
  if (result.error?.code==='P0D02') throw new ConnectorError('CATALOG_LIMIT','Select one account to list its actions.',422);
  if (result.error) connectorDatabaseError(result.error);
  const parsed = z.array(verifiedConnection).max(100).safeParse(result.data);
  if (!parsed.success) throw unavailable();
  if (!parsed.data.length) {
    // Admission already checked the site, member visibility/use and saved policy together.
    // Only a negative result needs a browse lookup to distinguish hidden from visible-but-disabled.
    if (connectorId===undefined) { await requireConnectorSiteAccess(ctx.siteId,ctx.userId); return []; }
    await getVisibleConnector(ctx.siteId,ctx.userId,connectorId);
    throw denied();
  }

  return verifyProviderAccounts(ctx.siteId,parsed.data,null,connectorId,action);
}

// Both hosts validate the same credential, provider identity, resource and tool policy after their actor-specific RPC.
export async function verifyProviderAccounts(siteId:string, rows:z.infer<typeof authorizedProviderRow>[], localRef:string|null, connectorId?:string, action?:string) {
  const credential = await loadConnectorCredential(siteId);
  const project = await readTokenProviderBinding(siteId,credential.revision);
  const seen = new Set<string>(), targets:DirectAuthorizedConnector[]=[];
  for (const r of rows) {
    const {connector:c,provider:p,policy:cp}=r;
    if (seen.has(c.id) || c.site_id!==siteId || p.site_id!==siteId || c.provider_id!==p.id || p.provider_user_id!==siteId ||
        c.provider_project_id!==p.project_id || (connectorId!==undefined && connectorId!==c.id) || c.provider_account_id==='instant_account' ||
        !cp.allowed_hosts.includes('assistant') || (cp.tool_access_mode==='selected' && (!cp.allowed_tools.length || (action && !cp.allowed_tools.includes(action))))) throw unavailable();
    seen.add(c.id);
    // Missing evidence or a different local installation invalidates a database attestation.
    // Never infer locality from a manager's URL or adopt another account on a mismatch.
    const proof:DirectProof = r.authority_kind==='verified_connection'
      ? {kind:r.authority_kind,connectionAttemptId:r.connection_attempt_id}
      : r.authority_kind==='connected_account' ? 'auth_scheme' in r
        ? {kind:r.authority_kind,authorizationId:r.authorization_id,authScheme:r.auth_scheme,boundProjectRef:r.bound_project_ref}
        : {kind:r.authority_kind,authorizationId:r.authorization_id}
        : {attestationId:r.attestation_id,expiresAt:r.expires_at,resourceBoundary:r.resource_boundary};
    const invalidAuthority = proof.kind==='verified_connection' ? !verifiedConnectionReady(c)
      : proof.kind==='connected_account' ? !connectedAccountReady(proof,c)
      : r.authority_kind!==undefined || Date.parse(r.expires_at)<=Date.now() ||
        (r.local_installation_ref!==null && c.supabase_project_ref===null) ||
        (c.supabase_project_ref!==null && (r.resource_boundary!==c.supabase_project_ref || !r.local_installation_ref)) ||
        (r.local_installation_ref!==null && (!localRef || localRef!==r.local_installation_ref || localRef===r.resource_boundary));
    if (p.credential_revision!==credential.revision || p.project_id!==project.projectId || invalidAuthority) {
      if (connectorId!==undefined) throw denied();
      continue;
    }
    // A foreign, unbound or otherwise invisible account never discloses tool/authority details.
    if (action && !action.startsWith(`${c.toolkit_slug.toUpperCase().replace(/-/g,'_')}_`)) throw new ConnectorError('DIRECT_ACTION_UNSUPPORTED',
      'This action is outside the selected toolkit.',409);
    // Preserve the target shape for previously pinned approvals; locality only authorizes attestations.
    targets.push({connector:c,provider:p,policy:cp,...(c.supabase_project_ref && localRef && {localProjectRef:localRef}),
      directProof:{...proof,directRevision:r.direct_revision,siteId:c.site_id,connectorId:c.id,providerId:p.id,toolkitSlug:c.toolkit_slug,
        projectId:p.project_id,accountId:c.provider_account_id,authConfigId:c.auth_config_id,credentialRevision:p.credential_revision}});
  }
  return targets;
}

export function listDirectAccounts(ctx:ConnectorContext) { return admit(ctx,ctx.connectorIdHint); }
export async function authorizeDirectAction(ctx:ConnectorContext,connectorId:string,toolSlug:string):Promise<DirectAuthorizedConnector> {
  if (!uuid.safeParse(connectorId).success || !slug.safeParse(toolSlug).success) throw denied();
  const targets=await admit(ctx,connectorId,toolSlug);
  if (targets.length!==1) throw denied();
  return targets[0];
}
