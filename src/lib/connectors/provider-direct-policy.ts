import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { withDirectActorEvidence } from '@/lib/database/hosted-project-identity';
import { connectorDatabaseError, getVisibleConnector, loadConnectorCredential, requireConnectorSiteAccess } from './account-access';
import { directActionNameSafe } from './provider-direct-guards';
import { readTokenProviderBinding } from './provider-project-binding';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from './types';

/** Internal only. Neither discovery metadata nor an AuthorizedConnector from another policy is a direct grant. */
export type DirectAuthorizedConnector = AuthorizedConnector & { directProof: {
  attestationId: string; directRevision: number; expiresAt: string; siteId: string; connectorId: string; providerId: string;
  toolkitSlug: string; projectId: string; accountId: string; authConfigId: string; credentialRevision: string; resourceBoundary: string;
} };

const uuid = z.string().uuid();
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const ref = z.string().regex(/^[a-z]{20}$/);
const kit = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const slug = z.string().regex(/^[A-Z0-9][A-Z0-9_]{0,149}$/).refine(v => !v.startsWith('COMPOSIO_'));
const revision = z.number().int().positive(), instant = z.string().datetime({offset:true});
const row = z.object({
  connector: z.object({id:uuid,site_id:uuid,provider_id:uuid,provider_project_id:id,toolkit_slug:kit,provider_account_id:id,
    auth_config_id:id,display_name:z.string().min(1).max(200),supabase_project_ref:ref.nullable(),provider_status:z.literal('ACTIVE'),
    enabled:z.literal(true),access_mode:z.enum(['workspace','explicit']),revocation_pending:z.literal(false),revocation_dispatched:z.literal(false),
    granted_scopes:z.array(z.string().max(256)).max(200),created_by:uuid,revision,verified_at:instant}),
  provider: z.object({id:uuid,site_id:uuid,provider:z.literal('composio'),project_id:id,provider_user_id:uuid,
    credential_revision:z.string().regex(/^(platform:)?[a-f0-9]{64}$/),status:z.literal('active')}),
  policy: z.object({allowed_tools:z.array(z.string().max(200)).max(200),allowed_hosts:z.array(z.enum(['direct','assistant'])).max(2),
    revision,require_approval:z.boolean(),tool_access_mode:z.enum(['all','selected'])}),
  attestation_id:uuid,direct_revision:revision.max(2_147_483_647),expires_at:instant,resource_boundary:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),local_installation_ref:ref.nullable(),
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
  const actorEvidence = () => withDirectActorEvidence(async()=>{
    const {data,error} = await supabaseAdmin.rpc('connector_direct_actor',actor).abortSignal(deadline());
    if (error || typeof data!=='boolean') throw unavailable();
    return data;
  });
  const result = await supabaseAdmin.rpc('connector_direct_accounts',{...actor,p_connector_id:connectorId??null,p_slug:action??null}).abortSignal(deadline());
  if (result.error?.code==='P0D02') throw new ConnectorError('CATALOG_LIMIT','Select one account to list its actions.',422);
  if (result.error) connectorDatabaseError(result.error);
  const parsed = z.array(row).max(100).safeParse(result.data);
  if (!parsed.success) throw unavailable();
  if (!parsed.data.length) {
    // Admission already checked the site, member visibility/use and saved policy together.
    // Only a negative result needs a browse lookup to distinguish hidden from visible-but-disabled.
    if (connectorId===undefined) { await requireConnectorSiteAccess(ctx.siteId,ctx.userId); return []; }
    await getVisibleConnector(ctx.siteId,ctx.userId,connectorId);
    throw denied();
  }

  const credential = await loadConnectorCredential(ctx.siteId);
  const project = await readTokenProviderBinding(ctx.siteId,credential.revision);
  let localRef:string|null=null;
  if (parsed.data.some(r=>r.local_installation_ref!==null || r.connector.supabase_project_ref!==null)) {
    const evidence = await actorEvidence();
    if (!evidence.allowed) throw denied();
    localRef=evidence.localProjectRef;
  }
  const seen = new Set<string>(), targets:DirectAuthorizedConnector[]=[];
  for (const r of parsed.data) {
    const {connector:c,provider:p,policy:cp}=r;
    if (seen.has(c.id) || c.site_id!==ctx.siteId || p.site_id!==ctx.siteId || c.provider_id!==p.id || p.provider_user_id!==ctx.siteId ||
        c.provider_project_id!==p.project_id || (connectorId!==undefined && connectorId!==c.id) || c.provider_account_id==='instant_account' ||
        !cp.allowed_hosts.includes('assistant') || (cp.tool_access_mode==='selected' && (!cp.allowed_tools.length || (action && !cp.allowed_tools.includes(action))))) throw unavailable();
    seen.add(c.id);
    // Missing evidence or a different local installation invalidates a database attestation.
    // Never infer locality from a manager's URL or adopt another account on a mismatch.
    if (p.credential_revision!==credential.revision || p.project_id!==project.projectId || Date.parse(r.expires_at)<=Date.now() ||
        (r.local_installation_ref!==null && c.supabase_project_ref===null) ||
        (c.supabase_project_ref!==null && (r.resource_boundary!==c.supabase_project_ref || !r.local_installation_ref)) ||
        (r.local_installation_ref!==null && (!localRef || localRef!==r.local_installation_ref || localRef===r.resource_boundary))) {
      if (connectorId!==undefined) throw denied();
      continue;
    }
    // A foreign, unbound or otherwise invisible account never discloses tool/authority details.
    // On an admitted account, an unsupported capability is not missing OAuth or a manager grant.
    if (action && !directActionNameSafe(c.toolkit_slug,action)) throw new ConnectorError('DIRECT_ACTION_UNSUPPORTED',
      'This action is outside the direct business-data boundary.',409);
    targets.push({connector:c,provider:p,policy:cp,...(c.supabase_project_ref && localRef && {localProjectRef:localRef}),
      directProof:{attestationId:r.attestation_id,directRevision:r.direct_revision,expiresAt:r.expires_at,siteId:c.site_id,connectorId:c.id,providerId:p.id,toolkitSlug:c.toolkit_slug,
        projectId:p.project_id,accountId:c.provider_account_id,authConfigId:c.auth_config_id,credentialRevision:p.credential_revision,resourceBoundary:r.resource_boundary}});
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
