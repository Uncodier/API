import 'server-only';
import {z} from 'zod';
import {supabaseAdmin} from '@/lib/database/supabase-client';
import {getMemberGrant,getVisibleConnector} from './account-access';
import {effectiveMemberGrant} from './grant-resolution';
import {readAgentProviderTarget,providerMemberScreens} from './support-generic-authority';
import {ConnectorError} from './types';

const denied=()=>new ConnectorError('APPROVAL_UNAVAILABLE','This connector operation cannot be requested for review.',409);
export const reviewSlug=z.string().max(150).regex(/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/).refine(v=>!v.startsWith('COMPOSIO_'));
export async function uniqueAgentReviewAccount(siteId:string,agentId:string,slug:string){
  const {data,error}=await supabaseAdmin.rpc('connector_agent_review_candidates',{p_site_id:siteId,p_agent_id:agentId,p_slug:reviewSlug.parse(slug)}).abortSignal(AbortSignal.timeout(5000));
  const match=z.tuple([z.string().uuid()]).safeParse(data);
  if(error || !match.success)throw denied();
  return match.data[0];
}
export async function genericReviewTarget(siteId:string,agentId:string,id:string,slug:string,reviewerUserId?:string, role:'reviewer'|'requester'='reviewer'){
  const access=await readAgentProviderTarget(siteId,agentId,id,reviewSlug.parse(slug));
  if(!access || !access.target.policy.require_approval)throw denied();
  if(!reviewerUserId)return {target:access.target,screens:null};
  const visible=await getVisibleConnector(siteId,reviewerUserId,id);
  const member=effectiveMemberGrant(visible,await getMemberGrant(siteId,reviewerUserId,id));
  if(!(role==='requester'?member.can_view:member.can_use) || visible.id!==id || visible.site_id!==siteId || visible.revision!==access.target.connector.revision)throw denied();
  return {target:access.target,screens:await providerMemberScreens(siteId,reviewerUserId,access.requiredScreens)};
}
