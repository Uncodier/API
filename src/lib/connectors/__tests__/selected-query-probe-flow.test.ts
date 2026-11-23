import {randomUUID} from 'node:crypto';
import {getRedisClient} from '@/lib/utils/redis-client';
import {getConnectorPolicy,getConnectorProvider,getMemberGrant,getVisibleConnector,loadConnectorCredential} from '../account-access';
import {readTokenProviderBinding} from '../provider-project-binding';
import {createProviderDirectRuntime} from '../provider-direct-runtime';
import {PROBE_PROVIDER_ACTION as slug} from '../selected-query-probe-policy';
import {accountFixture,connectorFixture,jsonResponse,providerFixture,secret,toolFixture,toolkitFixture} from './composio-fixtures';
import published from './fixtures/supabase-report-20261116_00.json';

const mockRpc=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...a:unknown[])=>mockRpc(...a)}}));
jest.mock('@/lib/utils/redis-client',()=>({getRedisClient:jest.fn()}));
jest.mock('../account-access',()=>({getConnectorPolicy:jest.fn(),getConnectorProvider:jest.fn(),getMemberGrant:jest.fn(),getVisibleConnector:jest.fn(),loadConnectorCredential:jest.fn()}));
jest.mock('../provider-project-binding',()=>({readTokenProviderBinding:jest.fn()}));
afterEach(()=>{jest.restoreAllMocks();jest.resetAllMocks();});

it.each([200,403])('search → describe → call on a non-enrolled account: exactly one provider POST (HTTP %i)',async status=>{
  const site=randomUUID(),id=randomUUID(),user=randomUUID(),rev=secret(),apiKey=secret(),version='20261116_00';
  const ctx={host:'assistant' as const,catalogUserSession:true as const,siteId:site,userId:user,agentId:randomUUID(),instanceId:randomUUID(),requestId:randomUUID(),connectorIdHint:id};
  const connector={...connectorFixture(),id,site_id:site,access_mode:'explicit' as const,toolkit_slug:'supabase',supabase_project_ref:'a'.repeat(20),revocation_dispatched:false};
  const provider={...providerFixture(),site_id:site,provider_user_id:site,credential_revision:rev};
  mockRpc.mockImplementation((name:string)=>{if(!['connector_direct_accounts','connector_direct_actor','connector_instance_explicitly_disabled'].includes(name))throw Error('Unexpected RPC');return {abortSignal:async()=>({data:name==='connector_direct_accounts'?[]:name==='connector_direct_actor',error:null})};});
  jest.mocked(getVisibleConnector).mockResolvedValue(connector);
  jest.mocked(getMemberGrant).mockResolvedValue({user_id:user,can_use:true,can_view:true,revoked_at:null,expires_at:null});
  jest.mocked(getConnectorPolicy).mockResolvedValue({allowed_hosts:['assistant'],allowed_tools:[slug],tool_access_mode:'selected',require_approval:true,catalog_reads:false,revision:1});
  jest.mocked(getConnectorProvider).mockResolvedValue(provider);
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey,revision:rev,source:'byok'});
  jest.mocked(readTokenProviderBinding).mockResolvedValue({projectId:provider.project_id});
  const reserve=jest.fn().mockResolvedValueOnce('OK').mockResolvedValue(null);
  jest.mocked(getRedisClient).mockReturnValue({set:reserve} as unknown as ReturnType<typeof getRedisClient>);
  const posts:unknown[]=[];
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url,opts)=>{
    const path=String(url).replace('https://backend.composio.dev/api/v3.1','');
    expect(new Headers(opts?.headers).get('x-api-key')).toBe(apiKey);
    if(path.startsWith('/tools?'))return jsonResponse({items:[{slug,name:'Read-only query',description:'SQL',is_deprecated:false,toolkit:{slug:'supabase'}}],total_items:1});
    if(path===`/tools/${slug}?version=${version}`)return jsonResponse({...toolFixture(),...published,slug,version,toolkit:{slug:'supabase'},scopes:['database_read'],tags:['important','readOnlyHint','openWorldHint','Database']});
    if(path==='/toolkits/supabase')return jsonResponse({...toolkitFixture(),slug:'supabase'});
    if(path===`/connected_accounts/${connector.provider_account_id}`)return jsonResponse({...accountFixture(),user_id:site,toolkit:{slug:'supabase'},state:{authScheme:'API_KEY',val:{full:'https://api.supabase.com'}}});
    if(path===`/tools/execute/${slug}` && opts?.method==='POST'){posts.push(JSON.parse(String(opts.body)));return jsonResponse(status===403?{}:{successful:true,error:null,data:{result:[{'?column?':1}]}},status);}
    throw Error('Unexpected provider request');
  });
  const runtime=createProviderDirectRuntime(async()=>ctx);
  const {tools}=await runtime.search({catalog_query:slug});
  expect(tools).toMatchObject([{name:`connector:${id}:${slug}`,availability:'describe_required'}]);
  const d=await runtime.describe(tools[0].name);
  const envelope={version:d.version,schema_hash:d.schema_hash,arguments:{query:'SELECT 1'}};
  expect(posts).toEqual([]);
  if(status===403)await expect(runtime.call(d.name,envelope)).rejects.toMatchObject({code:'PROVIDER_FORBIDDEN'});
  else await expect(runtime.call(d.name,envelope)).resolves.toMatchObject({success:true,connection_test:'verified'});
  await expect(runtime.call(d.name,envelope)).rejects.toMatchObject({code:'PROBE_ALREADY_ATTEMPTED'});
  expect(posts).toEqual([{connected_account_id:connector.provider_account_id,user_id:site,version,arguments:{ref:connector.supabase_project_ref,query:'SELECT 1'}}]);
  // An explicit veto must stop both fresh discovery and replay before any provider read.
  jest.mocked(globalThis.fetch).mockClear();
  mockRpc.mockImplementation((name:string)=>({abortSignal:async()=>({data:name==='connector_direct_accounts'?[]:true,error:null})}));
  await expect(runtime.search({catalog_query:slug})).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  await expect(runtime.call(d.name,envelope)).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED',executed:false});
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
