import {supabaseAdmin} from '@/lib/database/supabase-client';
import {getVisibleConnector,getConnectorPolicy,getConnectorProvider,getMemberGrant} from './account-access';
import {effectiveMemberGrant} from './grant-resolution';
import {readTokenProviderBinding} from './provider-project-binding';
import {ConnectorError,type AuthorizedConnector,type ConnectorContext} from './types';

// No generic dispatch authority. A site-bound query contract may independently authorize a bounded operation.
export type CatalogOnlyAccount = AuthorizedConnector & {catalogOnly:true};
const denied=()=>new ConnectorError('DIRECT_POLICY_REQUIRED','Catalog access has not been authorized for this account and member.',403);
export async function selectedCatalogAccount(ctx:ConnectorContext,id:string,memberSelection=false):Promise<CatalogOnlyAccount> {
  if(ctx.host!=='assistant'||ctx.catalogUserSession!==true||ctx.connectorIdHint!==id||!ctx.instanceId||!ctx.agentId)throw denied();
  const c=await getVisibleConnector(ctx.siteId,ctx.userId,id);
  if(!c||c.id!==id||c.site_id!==ctx.siteId||!c.enabled||!c.verified_at||c.provider_status!=='ACTIVE'||c.revocation_pending||c.revocation_dispatched!==false||c.provider_account_id==='instant_account')throw denied();
  const actorArgs={p_site_id:ctx.siteId,p_user_id:ctx.userId,p_instance_id:ctx.instanceId,p_agent_id:ctx.agentId};
  const actor=await supabaseAdmin.rpc('connector_direct_actor',actorArgs).abortSignal(AbortSignal.timeout(5000));
  if(actor.error)throw new ConnectorError('DIRECT_POLICY_UNAVAILABLE','Could not verify connector access.',503);
  if(actor.data!==true)throw denied();
  if(memberSelection){
    const veto=await supabaseAdmin.rpc('connector_instance_explicitly_disabled',{p_site_id:ctx.siteId,p_actor_id:ctx.userId,p_instance_id:ctx.instanceId,p_agent_id:ctx.agentId,p_connector_id:id}).abortSignal(AbortSignal.timeout(5000));
    if(veto.error || typeof veto.data!=='boolean')throw new ConnectorError('DIRECT_POLICY_UNAVAILABLE','Could not verify the account policy.',503);
    if(veto.data)throw denied();
  }
  const [policy,member]=await Promise.all([getConnectorPolicy(ctx.siteId,id),getMemberGrant(ctx.siteId,ctx.userId,id)]);
  if(!effectiveMemberGrant(c,member).can_use||(!memberSelection && policy.catalog_reads!==true)||!policy.allowed_hosts.includes('assistant')||
    (policy.tool_access_mode!=='all'&&(policy.tool_access_mode!=='selected'||!policy.allowed_tools.length)))throw denied();
  const p=await getConnectorProvider(ctx.siteId,c.provider_id);
  if(!p||p.site_id!==ctx.siteId||p.id!==c.provider_id||p.provider!=='composio'||p.status!=='active'||p.provider_user_id!==ctx.siteId||p.project_id!==c.provider_project_id)throw denied();
  if((await readTokenProviderBinding(ctx.siteId,p.credential_revision)).projectId!==p.project_id)throw denied();
  return {catalogOnly:true,connector:c,provider:p,policy};
}