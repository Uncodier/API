import { supabaseAdmin } from '@/lib/database/supabase-client';
import { routingStorageEnabled } from '@/lib/integrations/openrouter/types';
import { CustomerRoutingError, getExecutionRouting, withExecutionRouting, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';

/** Call after authorized plan creation and before dispatch. Never read a public metadata payer. */
export async function pinPlanRouting(planId: string, siteId: string, routing: ExecutionRoutingReference) {
  if (!planId || routing.siteId !== siteId) throw new CustomerRoutingError('PLAN_ROUTING_SITE_MISMATCH');
  if (!routingStorageEnabled() && routing.payer === 'platform') return;
  await withExecutionRouting(routing,siteId,async()=>{
    const { error }=await supabaseAdmin.rpc('openrouter_plan_routing_pin',{p_plan_id:planId,p_site_id:siteId,p_routing:routing});
    if(error)throw new CustomerRoutingError('PLAN_ROUTING_PUBLICATION_FAILED');
  });
}

/** Background resumes read immutable private pins; a missing pin during rollout is an error. */
export async function getPlanRouting(planId: string,siteId: string):Promise<ExecutionRoutingReference>{
  const inherited=getExecutionRouting(siteId);
  if(!routingStorageEnabled() && inherited?.payer!=='customer') return {payer:'platform',siteId};
  const {data,error}=await supabaseAdmin.from('openrouter_plan_routing').select('routing').eq('plan_id',planId).eq('site_id',siteId).maybeSingle();
  if(error||!data?.routing)throw new CustomerRoutingError('PLAN_ROUTING_UNAVAILABLE');
  return withExecutionRouting(data.routing,siteId,async()=>getExecutionRouting(siteId)!);
}