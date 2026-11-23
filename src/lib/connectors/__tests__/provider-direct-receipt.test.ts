import {randomUUID} from 'node:crypto';
import {claimDirectDispatch,storeDirectResult} from '../provider-direct-receipt';
import {supabaseAdmin} from '@/lib/database/supabase-client';
import {connectorFixture,providerFixture,secret} from './composio-fixtures';

jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:jest.fn()}}));
const site=randomUUID(),id=randomUUID(),attestation=randomUUID();
const ctx={siteId:site,userId:randomUUID(),agentId:randomUUID(),host:'assistant' as const,catalogUserSession:true as const,instanceId:randomUUID(),requestId:randomUUID()};
const target={connector:{...connectorFixture(),id,site_id:site},provider:providerFixture(),policy:{revision:1,allowed_tools:[],allowed_hosts:['assistant'],require_approval:false},
  directProof:{attestationId:attestation,directRevision:3,expiresAt:new Date(Date.now()+60000).toISOString(),siteId:site,connectorId:id,providerId:'provider_one',projectId:'project_one',
    accountId:'ca_one',authConfigId:'ac_one',resourceBoundary:'external',toolkitSlug:'crm',credentialRevision:providerFixture().credential_revision}};
const tool='CRM_PATCH_DEAL',v='20261120_00',hash=secret(),digest=secret(),claim=randomUUID(),receipt=randomUUID();
const rpc=supabaseAdmin.rpc as jest.Mock;
const reply=(data:unknown,error:unknown=null)=>rpc.mockReturnValueOnce({abortSignal:async()=>({data,error})});
beforeEach(()=>rpc.mockReset());
it('does not persist argument values in claims; binds both SQL calls to the exact turn, account, policy epoch and claim',async()=>{
  reply(claim);reply(receipt);
  const r=await claimDirectDispatch(ctx,target,tool,v,hash,digest);
  const report={title:'Connector result',note:'Sample',columns:['Field','Value'],rows:[['$.count','2']]};
  expect(await storeDirectResult(ctx,target,tool,v,hash,report,r)).toBe(receipt);
  const base={p_user_id:ctx.userId,p_site_id:ctx.siteId,p_agent_id:ctx.agentId,p_instance_id:ctx.instanceId,p_request_id:ctx.requestId,p_tool:tool,
    p_connector_id:id,p_connector_revision:1,p_policy_revision:1,p_direct_revision:3,p_attestation_id:attestation,p_version:v,p_schema_hash:hash,p_credential_revision:target.provider.credential_revision};
  expect(rpc.mock.calls).toEqual([['claim_connector_direct_dispatch',{...base,p_arguments_digest:digest}],['store_connector_direct_result',{...base,p_claim_id:claim,p_report:report}]]);
});
it('does not retry duplicate claims, ambiguous reservations, or a definite storage denial',async()=>{
  reply(null,{code:'P0D03'});reply(null,{code:'08000'});reply(null,{code:'42501'});
  await expect(claimDirectDispatch(ctx,target,tool,v,hash,digest)).rejects.toMatchObject({code:'DIRECT_DISPATCH_ALREADY_CLAIMED'});
  await expect(claimDirectDispatch(ctx,target,tool,v,hash,digest)).rejects.toMatchObject({code:'DIRECT_DISPATCH_UNCONFIRMED'});
  await expect(storeDirectResult(ctx,target,tool,v,hash,{title:'Private',note:'Sample',columns:['Field'],rows:[]},claim)).rejects.toMatchObject({code:'DIRECT_RESULT_UNCONFIRMED'});
  expect(rpc).toHaveBeenCalledTimes(3);
});
it.each(['throw',0,504])('repeats only the exact receipt store after transport uncertainty (%s)',async failure=>{
  const report={title:'Private',note:'Sample',columns:['Field'],rows:[]};
  rpc.mockReturnValueOnce({abortSignal:async()=>{ if(failure==='throw') throw new Error('interrupted');
    return {status:failure,error:{},data:null}; }});reply(receipt);
  expect(await storeDirectResult(ctx,target,tool,v,hash,report,claim)).toBe(receipt);
  expect(rpc).toHaveBeenCalledTimes(2);expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  expect(rpc.mock.calls[0][0]).toBe('store_connector_direct_result');
});
it('stops after two ambiguous storage acknowledgments',async()=>{
  rpc.mockReturnValue({abortSignal:async()=>{throw new Error('interrupted');}});
  await expect(storeDirectResult(ctx,target,tool,v,hash,{title:'Private',note:'Sample',columns:['Field'],rows:[]},claim))
    .rejects.toMatchObject({code:'DIRECT_RESULT_UNCONFIRMED'});
  expect(rpc).toHaveBeenCalledTimes(2);
});
