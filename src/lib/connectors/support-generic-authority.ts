import 'server-only';
import {z} from 'zod';
import {supabaseAdmin} from '@/lib/database/supabase-client';
import {withSupportAccountEvidence} from '@/lib/database/hosted-project-identity';
import {canUseToolScreen,loadToolScreenAccess} from '@/app/api/agents/tools/router/screen-access';
import {getMemberGrant,getVisibleConnector} from './account-access';
import {effectiveMemberGrant} from './grant-resolution';
import {authorizedSupportProviderRow as row,verifyProviderAccounts} from './provider-direct-policy';
import {memberSupportScope, type SupportConnectorScope} from './support-runtime-contract';
import {ConnectorError} from './types';

type MemberScope=Extract<SupportConnectorScope,{audience:'member'}>;
const denied=()=>new ConnectorError('SUPPORT_UNAVAILABLE','This connector is not available to the assigned support agent.',403);
const unavailable=()=>new ConnectorError('DIRECT_POLICY_UNAVAILABLE','Connector authority could not be verified.',503);

export async function readAgentProviderTarget(siteId:string,agentId:string,id:string,slug?:string){
  if (![siteId,agentId,id].every(v=>z.string().uuid().safeParse(v).success))throw denied();
  let rows:z.infer<typeof row>[]=[];
  const evidence=await withSupportAccountEvidence(async()=>{
    const {data,error}=await supabaseAdmin.rpc('connector_support_agent_account_v2',{p_site_id:siteId,p_agent_id:agentId,p_connector_id:id,p_slug:slug??null}).abortSignal(AbortSignal.timeout(5000));
    if(error)throw unavailable();
    const result=z.array(row).max(1).safeParse(data);
    if(!result.success)throw unavailable();
    rows=result.data;
    return rows.length===1;
  });
  if(!evidence.allowed)return null;
  const [target]=await verifyProviderAccounts(siteId,rows,evidence.localProjectRef,id,slug);
  if(!target)throw denied();
  return {target,requiredScreens:rows[0].required_screens};
}

export async function providerMemberScreens(siteId:string,userId:string,requiredScreens:string[]){
  const screens=await loadToolScreenAccess({siteId,userId});
  if(!screens||!canUseToolScreen('connector_gateway',screens)||(!screens.isAdmin&&requiredScreens.some(s=>s==='*' ? screens.blockedScreens.length>0 : screens.blockedScreens.includes(s))))throw denied();
  return screens;
}

async function resolve(scope:MemberScope, id:string, slug?:string){
  scope=memberSupportScope.parse(scope);
  if(!z.string().uuid().safeParse(id).success)throw denied();
  const visible=await getVisibleConnector(scope.siteId,scope.userId,id);
  if(visible.id!==id||visible.site_id!==scope.siteId)throw denied();
  const member=await getMemberGrant(scope.siteId,scope.userId,id);
  const grant=effectiveMemberGrant(visible,member);
  if(!grant.can_view || (slug!==undefined && !grant.can_use))throw denied();
  const admitted=await readAgentProviderTarget(scope.siteId,scope.agentId,id,slug);
  if(!admitted)return null;
  await providerMemberScreens(scope.siteId,scope.userId,admitted.requiredScreens);
  const {target}=admitted;
  if(!target || target.connector.revision!==visible.revision)throw denied();
  return {target,releaseMemberResult:grant.can_use};
}

export const optionalGenericSupport=(scope:MemberScope,id:string)=>resolve(scope,id);
export async function authorizeGenericSupport(scope:MemberScope,id:string,slug:string){
  if(!/^[A-Z0-9][A-Z0-9_]{0,149}$/.test(slug)||slug.startsWith('COMPOSIO_'))throw denied();
  const access=await resolve(scope,id,slug);
  if(!access)throw denied();
  return access;
}
