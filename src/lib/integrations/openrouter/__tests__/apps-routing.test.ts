import { randomUUID } from 'node:crypto';
import { withAppsInference } from '@/lib/services/apps-platform/inference-routing';
import { withExecutionRouting,getExecutionRouting,getCustomerCapability } from '@/lib/services/ai/customer-routing';
import { resolveCustomerCredential } from '../store';
jest.mock('../store',()=>({resolveCustomerCredential:jest.fn()}));
const siteId=randomUUID();
beforeEach(()=>{jest.clearAllMocks();delete process.env.CUSTOMER_OPENROUTER_ENABLED;delete process.env.OPENROUTER_ROUTING_STORAGE_READY;});
afterEach(()=>{delete process.env.CUSTOMER_OPENROUTER_ENABLED;delete process.env.OPENROUTER_ROUTING_STORAGE_READY;});
test('pre-rollout global apps helpers keep existing inference behavior',async()=>{
  const run=jest.fn(async()=>true);
  await expect(withAppsInference(siteId,'review:1',run)).resolves.toBe(true);expect(run).toHaveBeenCalledTimes(1);
});
test('unscoped apps calls cannot accidentally fund customer jobs on the global account after rollout',async()=>{
  process.env.CUSTOMER_OPENROUTER_ENABLED='true';process.env.OPENROUTER_ROUTING_STORAGE_READY='true';
  const run=jest.fn(async()=>true);
  await expect(withAppsInference(siteId,'review:1',run)).rejects.toThrow('fallback is prohibited');expect(run).not.toHaveBeenCalled();
});
test('review inherits the pinned customer tenant and capability without changing SQL authorization',async()=>{
  jest.mocked(resolveCustomerCredential).mockResolvedValue({} as never);
  const routing={payer:'customer' as const,siteId,connectionId:randomUUID(),policyVersion:1,credentialVersion:1};
  await withExecutionRouting(routing,siteId,()=>withAppsInference(siteId,'review:1',async()=>{
    expect(getExecutionRouting()).toEqual(routing);expect(getCustomerCapability()).toBe('tools');
  }));
  expect(resolveCustomerCredential).toHaveBeenCalledWith(routing);
});