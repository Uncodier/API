import {supabaseAdmin} from '@/lib/database/supabase-client';
import {getVisibleConnector,getConnectorPolicy,getConnectorProvider,getMemberGrant} from './account-access';
import {effectiveMemberGrant} from './grant-resolution';
import {readTokenProviderBinding} from './provider-project-binding';
import {ConnectorError,type AuthorizedConnector,type ConnectorContext} from './types';

// Inventory only. Deliberately lacks the proof required by provider dispatch and private receipts.
export type CatalogOnlyAccount = AuthorizedConnector & {catalogOnly:true};
const denied=()=>new ConnectorError('DIRECT_POLICY_REQUIRED','Catalog access has not been authorized for this account and member.',403);
export async function selectedCatalogAccount(ctx:ConnectorContext,id:string):Promise<CatalogOnlyAccount> {
  if(ctx.host!=='assistant'||ctx.catalogUserSession!==true||ctx.connectorIdHint!==id||!ctx.instanceId||!ctx.agentId)throw denied();
  const c=await getVisibleConnector(ctx.siteId,ctx.userId,id);
  if(!c||c.id!==id||c.site_id!==ctx.siteId||!c.enabled||!c.verified_at||c.provider_status!=='ACTIVE'||c.revocation_pending||c.revocation_dispatched!==false||c.provider_account_id==='instant_account')throw denied();
  const actor=await supabaseAdmin.rpc('connector_direct_actor',{p_site_id:ctx.siteId,p_user_id:ctx.userId,p_instance_id:ctx.instanceId,p_agent_id:ctx.agentId}).abortSignal(AbortSignal.timeout(5000));
  if(actor.error)throw new ConnectorError('DIRECT_POLICY_UNAVAILABLE','Could not verify catalog access.',503);
  if(actor.data!==true)throw denied();
  const [policy,member]=await Promise.all([getConnectorPolicy(ctx.siteId,id),getMemberGrant(ctx.siteId,ctx.userId,id)]);
  if(!effectiveMemberGrant(c,member).can_use||policy.catalog_reads!==true||!policy.allowed_hosts.includes('assistant')||
    (policy.tool_access_mode!=='all'&&(policy.tool_access_mode!=='selected'||!policy.allowed_tools.length)))throw denied();
  const p=await getConnectorProvider(ctx.siteId,c.provider_id);
  if(!p||p.site_id!==ctx.siteId||p.id!==c.provider_id||p.provider!=='composio'||p.status!=='active'||p.provider_user_id!==ctx.siteId||p.project_id!==c.provider_project_id)throw denied();
  if((await readTokenProviderBinding(ctx.siteId,p.credential_revision)).projectId!==p.project_id)throw denied();
  return {catalogOnly:true,connector:c,provider:p,policy};
}