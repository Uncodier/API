import {randomUUID} from 'node:crypto';
import {scopedReadResolver,scopedReadPage} from '../instance-scoped-binding';
import {connectorFixture,providerFixture} from './composio-fixtures';
import type {ConnectorContext} from '../types';

const mockVisible=jest.fn(), mockProvider=jest.fn(), mockRpc=jest.fn(), mockCapture=jest.fn();
jest.mock('../account-access',()=>({getVisibleConnector:(...a:unknown[])=>mockVisible(...a),getConnectorProvider:(...a:unknown[])=>mockProvider(...a)}));
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...a:unknown[])=>mockRpc(...a)}}));
jest.mock('@/lib/database/hosted-project-identity',()=>({withDirectActorEvidence:(...a:unknown[])=>mockCapture(...a)}));

const id=randomUUID(),siteId=randomUUID(),ref='a'.repeat(20);
const ctx:ConnectorContext={siteId,host:'assistant',userId:randomUUID(),instanceId:randomUUID(),requestId:randomUUID(),agentId:randomUUID(),catalogUserSession:true};
const c={...connectorFixture(),id,site_id:siteId,toolkit_slug:'supabase',supabase_project_ref:ref,revocation_dispatched:false};
const p={...providerFixture(),site_id:siteId,provider_user_id:siteId};
const stamp={connector_id:id,project_ref:ref,connector_revision:c.revision,policy_revision:3,direct_revision:1,credential_revision:p.credential_revision};
const reply=(data:unknown,error:unknown=null)=>({abortSignal:async()=>({data,error})});
const resolve=()=>scopedReadResolver(async()=>ctx,ctx,id)();
beforeEach(()=>{
  jest.resetAllMocks();mockVisible.mockResolvedValue(c);mockProvider.mockResolvedValue(p);
  mockCapture.mockImplementation(async verify=>({allowed:await verify(),localProjectRef:ref}));
  mockRpc.mockImplementation((name:string)=>reply(name==='connector_direct_actor'?true:stamp));
});

it('revalidates the exact member, turn, installation and read-policy epochs; discovery never returns private references',async()=>{
  const binding=await resolve(); expect(binding).toMatchObject({localProjectRef:ref,context:ctx,connector:c,provider:p,policyRevision:3,directRevision:1});
  expect(mockRpc).toHaveBeenCalledWith('connector_instance_scoped_read',{p_connector_id:id,p_site_id:siteId,p_user_id:ctx.userId,p_instance_id:ctx.instanceId,p_agent_id:ctx.agentId});
  const page=scopedReadPage(binding,{query:'ingresos del trimestre'}); expect(page.tools).toMatchObject([{name:`report:${id}:MAKINARI_METRICS`,tool_origin:'makinari_report',toolkit:'makinari',connector_id:id}]);
  for(const term of ['SUPABASE_RUN_READ_ONLY_QUERY',`connector:${id}:SUPABASE_RUN_READ_ONLY_QUERY`,`report:${randomUUID()}:MAKINARI_METRICS`]) expect(scopedReadPage(binding,{catalog_query:term}).tools).toEqual([]);
  expect(scopedReadPage(binding,{query:'SUPABASE_RUN_READ_ONLY_QUERY',catalog_query:'metrics'}).tools).toEqual([]);
  expect(scopedReadPage(binding,{query:'Summary: quarterly sales',catalog_query:'MAKINARI_METRICS'}).tools).toHaveLength(1);
  expect(JSON.stringify(page)).not.toContain(ref);expect(scopedReadPage(binding,{catalog_query:'SUPABASE_DELETE_PROJECT'}).tools).toEqual([]);
  expect(()=>scopedReadPage(binding,{cursor:'old'})).toThrow(expect.objectContaining({code:'STALE_CURSOR'}));
});

it('rejects a new host, user, selected account or action before looking up a connection',async()=>{
  for(const patch of [{host:'workflow'}, {userId:randomUUID()}, {connectorIdHint:randomUUID()}, {agentId:randomUUID()}, {requestId:randomUUID()}, {requestId:undefined}, {catalogUserSession:undefined}]) {
    const check=scopedReadResolver(async()=>({...ctx,...patch} as ConnectorContext),ctx,id);
    await expect(check()).rejects.toMatchObject({code:'ACCESS_CHANGED'});
  }
  expect(mockVisible).not.toHaveBeenCalled();expect(mockRpc).not.toHaveBeenCalled();
});

it('never turns a denied or unavailable credential/policy into a scoped read',async()=>{
  for(const evidence of [{allowed:false,localProjectRef:ref},{allowed:true,localProjectRef:null},{allowed:true,localProjectRef:'b'.repeat(20)}]) {
    mockCapture.mockResolvedValueOnce(evidence);await expect(resolve()).rejects.toMatchObject({code:'SCOPED_READ_NOT_ALLOWED'});
  }
  expect(mockProvider).not.toHaveBeenCalled();mockCapture.mockImplementation(async()=>({allowed:true,localProjectRef:ref}));
  for(const [result,code] of [[reply(null),'SCOPED_READ_NOT_ALLOWED'],[reply(null,{code:'PGRST202'}),'DIRECT_POLICY_UNAVAILABLE'],
    [reply({...stamp,project_ref:'b'.repeat(20)}),'ACCESS_CHANGED'],[reply({...stamp,connector_id:randomUUID()}),'ACCESS_CHANGED'],[reply({...stamp,direct_revision:0}),'DIRECT_POLICY_UNAVAILABLE']] as const){
    mockRpc.mockReturnValueOnce(result);await expect(resolve()).rejects.toMatchObject({code});
  }
  mockProvider.mockResolvedValueOnce({...p,credential_revision:'f'.repeat(64)});await expect(resolve()).rejects.toMatchObject({code:'ACCESS_CHANGED'});
});