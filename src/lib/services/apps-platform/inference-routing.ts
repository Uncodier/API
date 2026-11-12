import { rolloutEnabled } from '@/lib/integrations/openrouter/types';
import { CustomerRoutingError, getExecutionRouting, withCustomerCapability, withCustomerOperation } from '@/lib/services/ai/customer-routing';

/** SQL diagnosis/review inherits the authorized workflow payer; requirement metadata is not authority. */
export async function withAppsInference<T>(siteId:string,operationId:string,operation:()=>Promise<T>):Promise<T>{
  const routing=getExecutionRouting(siteId);
  if(!routing && rolloutEnabled())throw new CustomerRoutingError('APPS_WORKFLOW_ROUTING_REQUIRED');
  return withCustomerOperation(operationId,()=>withCustomerCapability('tools',operation));
}