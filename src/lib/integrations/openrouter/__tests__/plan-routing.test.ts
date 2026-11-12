import { randomUUID } from 'node:crypto';
import { getPlanRouting,pinPlanRouting } from '@/lib/services/workflow-robot/plan-routing';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveCustomerCredential } from '../store';
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:jest.fn(),rpc:jest.fn()}}));
jest.mock('../store',()=>({resolveCustomerCredential:jest.fn()}));
const siteId=randomUUID(),planId=randomUUID();
const routing={payer:'customer' as const,siteId,connectionId:randomUUID(),policyVersion:1,credentialVersion:1};
beforeEach(()=>{jest.clearAllMocks();delete process.env.OPENROUTER_ROUTING_STORAGE_READY;});
afterEach(()=>{delete process.env.OPENROUTER_ROUTING_STORAGE_READY;});
test('pre-migration global jobs perform no new schema access',async()=>{
  await expect(getPlanRouting(planId,siteId)).resolves.toEqual({payer:'platform',siteId});
  await pinPlanRouting(planId,siteId,{payer:'platform',siteId});
  expect(supabaseAdmin.from).not.toHaveBeenCalled();expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});
test('storage-ready rollback restores immutable customer payer and revalidates credentials',async()=>{
  process.env.OPENROUTER_ROUTING_STORAGE_READY='true';
  const query:any={select:jest.fn(()=>query),eq:jest.fn(()=>query),maybeSingle:jest.fn(async()=>({data:{routing},error:null}))};
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);
  jest.mocked(resolveCustomerCredential).mockResolvedValue({} as never);
  await expect(getPlanRouting(planId,siteId)).resolves.toEqual(routing);
  expect(resolveCustomerCredential).toHaveBeenCalledWith(routing);
  expect(query.eq).toHaveBeenCalledWith('site_id',siteId);
  jest.mocked(resolveCustomerCredential).mockRejectedValueOnce(new Error('revoked'));
  await expect(getPlanRouting(planId,siteId)).rejects.toThrow('revoked');
});
test('missing pin or storage failure never reclassifies a job as globally funded',async()=>{
  process.env.OPENROUTER_ROUTING_STORAGE_READY='true';
  const query:any={select:jest.fn(()=>query),eq:jest.fn(()=>query),maybeSingle:jest.fn(async()=>({data:null,error:null}))};
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);
  await expect(getPlanRouting(planId,siteId)).rejects.toThrow('fallback is prohibited');
});