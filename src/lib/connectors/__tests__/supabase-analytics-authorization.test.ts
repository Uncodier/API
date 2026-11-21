import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { authorizeAnalyticsResult } from '../supabase-analytics-authorization';
import { SUPABASE_CATALOG_SLUG } from '../supabase-report-contract';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc:jest.fn() } }));
const rpc = supabaseAdmin.rpc as jest.Mock;
const binding = { p_site_id:randomUUID(),p_user_id:randomUUID(),p_instance_id:randomUUID(),p_agent_id:randomUUID(),p_connector_id:randomUUID(),
  p_tool:SUPABASE_CATALOG_SLUG,p_catalog:true,p_policy_revision:4,p_connector_revision:6,p_credential_revision:'revision' };
const ref='a'.repeat(20), epoch=randomUUID();
function reply(data:unknown,error:unknown=null) { rpc.mockReturnValue({ abortSignal:()=>Promise.resolve({data,error}) }); }
beforeEach(()=>rpc.mockReset());
test('authorization binds the whole private destination and distinguishes workspace, platform and storage failure',async()=>{
  reply({allowed:true,grant_id:epoch});
  await expect(authorizeAnalyticsResult(binding,ref,'platform','paid_sales')).resolves.toEqual({scope:'platform',projectRef:ref,source:'paid_sales',grantId:epoch});
  expect(rpc).toHaveBeenCalledWith('connector_analytics_result_ready',{...binding,p_data_scope:'platform',p_project_ref:ref,p_source:'paid_sales'});
  reply({allowed:false,grant_id:null});
  await expect(authorizeAnalyticsResult(binding,ref,'workspace','approved_orders')).rejects.toMatchObject({code:'ANALYTICS_WORKSPACE_DENIED'});
  await expect(authorizeAnalyticsResult(binding,ref,'platform','paid_sales')).rejects.toMatchObject({code:'ANALYTICS_SCOPE_DENIED'});
  reply({allowed:true,grant_id:null});
  await expect(authorizeAnalyticsResult(binding,ref,'workspace','paid_sales')).resolves.toMatchObject({scope:'workspace',grantId:null});
  await expect(authorizeAnalyticsResult(binding,ref,'platform','paid_sales')).rejects.toMatchObject({code:'ANALYTICS_SCOPE_DENIED'});
  reply(null,{code:'42501'});
  await expect(authorizeAnalyticsResult(binding,ref,'platform','paid_sales')).rejects.toMatchObject({code:'CATALOG_AUTHORIZATION_UNAVAILABLE'});
});
