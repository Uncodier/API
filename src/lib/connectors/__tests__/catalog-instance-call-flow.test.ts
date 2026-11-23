import { attestedProject, byokOrigin, byokRpc } from './byok-rpc-fixture';
import { randomUUID } from 'node:crypto';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { connectorGateway } from '../tool-resolver';
import { getConnectorPolicy, getMemberGrant, getConnectorProvider, getVisibleConnector, loadConnectorCredential } from '../account-access';
import {withDirectActorEvidence} from '@/lib/database/hosted-project-identity';
import { accountFixture, connectorFixture, providerFixture, toolkitFixture, toolFixture, secret, jsonResponse } from './composio-fixtures';

const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args:unknown[]) => mockRpc(...args) } }));
jest.mock('../account-access', () => ({ requireConnectorSiteAccess:jest.fn(), getVisibleConnector:jest.fn(), getConnectorPolicy:jest.fn(),getMemberGrant:jest.fn(), getConnectorProvider:jest.fn(), loadConnectorCredential:jest.fn() }));
jest.mock('@/lib/database/hosted-project-identity',()=>({withDirectActorEvidence:jest.fn()}));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ ...jest.requireActual('@/app/api/agents/tools/router/screen-access'),
  assertToolScreenAccess: jest.fn(), loadToolScreenAccess: jest.fn(async () => ({isAdmin:true,blockedScreens:[]})) }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService:{generateEmbeddings:jest.fn(async () => {throw new Error('offline');})} }));
jest.mock('@/app/api/agents/tools/catalog_commerce/batch-admin-tool', () => ({bindCatalogBatchActor: (tool:unknown)=>tool}));

const paramsForActor=(p:Record<string,unknown>)=>[p.p_site_id,p.p_user_id,p.p_instance_id,p.p_agent_id];
const old = {origin:process.env.CONNECTORS_WEB_ORIGIN};
afterEach(()=>{
  jest.restoreAllMocks(); jest.clearAllMocks();
  if (old.origin===undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN=old.origin;
});

// Network boundary only: real catalog parser, gateway, resolver, descriptor, adapter and failure recovery.
it.each([true,false])('keeps shared-account connector discovery metadata-only without a report fallback (catalog reads: %s)',async allowed=>{
  const siteId=randomUUID(), connectorId=randomUUID(), project='a'.repeat(20);
  const ctx={siteId,userId:randomUUID(),agentId:randomUUID(),requestId:randomUUID(),instanceId:randomUUID(),catalogUserSession:true as const,host:'assistant' as const};
  const c={...connectorFixture(),id:connectorId,site_id:siteId,access_mode:'workspace' as const,toolkit_slug:'supabase',supabase_project_ref:project,revocation_dispatched:false};
  const p={...providerFixture(),site_id:siteId,provider_user_id:siteId};
  jest.mocked(getVisibleConnector).mockResolvedValue(c);jest.mocked(getConnectorProvider).mockResolvedValue(p);
  jest.mocked(withDirectActorEvidence).mockImplementation(async check=>({allowed:await check(),localProjectRef:project}));
  process.env.CONNECTORS_WEB_ORIGIN=byokOrigin;
  jest.mocked(getMemberGrant).mockResolvedValue(null);
  jest.mocked(getConnectorPolicy).mockResolvedValue({allowed_hosts:['assistant'],allowed_tools:[],tool_access_mode:'all',catalog_reads:allowed,require_approval:false});
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:secret(),revision:p.credential_revision,source:'byok'});
  mockRpc.mockImplementation((name,args)=>name===byokRpc?attestedProject(p)(name,args):({abortSignal:async()=>({data:name==='connector_direct_accounts'?[]:name==='connector_direct_actor',error:null})}));
  const native={name:'report',description:'Local report',parameters:{type:'object'},execute:jest.fn()};
  const http=jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    expect(init?.method).toBe('GET');expect(new URL(String(url)).pathname).toBe('/api/v3.1/tools');
    return jsonResponse({items:[{...toolFixture(),name:'Read',slug:'SUPABASE_RUN_READ_ONLY_QUERY',toolkit:{slug:'supabase'}}],next_cursor:null,total_items:1});
  });
  const router=toolsRouterTool([native,connectorGateway(async()=>ctx)],ctx);
  const search={action:'search' as const,query:'investor KPIs',connector_id:connectorId};
  const inventory=await router.execute({...search,action:'list'});
  if(allowed) expect(inventory).toMatchObject({success:true,count:1,tools:[{name:`connector:${connectorId}:SUPABASE_RUN_READ_ONLY_QUERY`,availability:'manual_only',tool_origin:'provider'}]});
  else expect(inventory).toMatchObject({success:false,tools:[],connector_error:'DIRECT_POLICY_REQUIRED'});
  expect(http).toHaveBeenCalledTimes(allowed?1:0);http.mockClear();jest.mocked(loadConnectorCredential).mockClear();
  const providerRef=`connector:${connectorId}:SUPABASE_RUN_READ_ONLY_QUERY`;
  expect(await router.execute({action:'describe',name:providerRef})).toMatchObject({success:false,code:'DIRECT_POLICY_REQUIRED'});
  expect(await router.execute({action:'call',name:providerRef,args:JSON.stringify({version:'20261116_00',schema_hash:'0'.repeat(64),arguments:{scope:'workspace',query:'select count(*) from analytics.paid_sales'}})})).toMatchObject({success:false,code:'DIRECT_POLICY_REQUIRED',executed:false});
  expect(mockRpc).not.toHaveBeenCalledWith('connector_instance_scoped_read',expect.anything());
  mockRpc.mockClear();
  for(const connector_id of [connectorId,undefined]) {
    expect(await router.execute({...search,tool_origin:'makinari_report',connector_id})).toMatchObject({success:false,tools:[],executed:false});
  }
  expect(mockRpc).not.toHaveBeenCalled();
  expect(native.execute).not.toHaveBeenCalled(); expect(loadConnectorCredential).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled();
});

it.each(['all','selected'] as const)('dispatches a new %s-mode action on the chosen account and respects an app denial without probing',async mode=>{
  const siteId=randomUUID(),connectorId=randomUUID(),revision=secret(),apiKey=secret();
  const ctx={siteId,userId:randomUUID(),agentId:randomUUID(),requestId:randomUUID(),instanceId:randomUUID(),catalogUserSession: true as const, host:'assistant' as const};
  const toolkit='warehouse', slug='WAREHOUSE_LIST_PALLETS', scope='pallets.read';
  const provider={...providerFixture(),id:randomUUID(),site_id:siteId,provider_user_id:siteId,credential_revision:revision};
  const dbRow={connector:{...connectorFixture(),id:connectorId,site_id:siteId,toolkit_slug:toolkit,provider_id:provider.id,
      access_mode:'workspace',supabase_project_ref:null,revocation_dispatched:false,created_by:ctx.userId},provider,
    attestation_id:randomUUID(),direct_revision:3,expires_at:new Date(Date.now()+3600000).toISOString(),resource_boundary:'isolated-warehouse',local_installation_ref:null,
    policy:{revision:1,tool_access_mode:mode,allowed_tools:mode==='selected'?[slug]:[],allowed_hosts:['assistant'],require_approval:true}};
  process.env.CONNECTORS_WEB_ORIGIN='https://app.example.test';
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey,revision,source:'byok'});
  const tool={...toolFixture(),slug,name:'List pallets',toolkit:{slug:toolkit},description:'Lists pallets.',scopes:[scope],tags:['readOnlyHint'],
    input_parameters:{type:'object',properties:{limit:{type:'integer',maximum:100}}},
    output_parameters:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{id:{type:'integer'}}}}}}};
  const api={...toolkitFixture(),slug:toolkit,enabled:true};
  const account={...accountFixture(),user_id:siteId,toolkit:{slug:toolkit},state:mode==='all'
    ? {authScheme:'API_KEY',val:{}} : {authScheme:'OAUTH2',val:{scope:`${scope} offline_access tasks.write`}}};
  const native={name:'leads',description:'Native leads',parameters:{type:'object'},execute:jest.fn()};
  const router=toolsRouterTool([native,connectorGateway(async()=>ctx)],ctx);
  let dispatches=0; const receiptId=randomUUID(); const privateRow=73605391;
  mockRpc.mockImplementation((name,args)=>{
    if(name===byokRpc) return attestedProject(provider)(name,args);
    if(name==='connector_direct_accounts') {
      expect(paramsForActor(args)).toEqual([ctx.siteId,ctx.userId,ctx.instanceId,ctx.agentId]);
      return {abortSignal:async()=>({data:[dbRow],error:null})};
    }
    if(name==='claim_connector_direct_dispatch' || name==='store_connector_direct_result') {
      expect(args).toMatchObject({p_tool:slug,p_request_id:ctx.requestId,p_attestation_id:dbRow.attestation_id});
      return {abortSignal:async()=>({data:receiptId,error:null})};
    }
    throw new Error('Unexpected reporting or storage operation');
  });
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const u=new URL(String(url)); if(u.origin!=='https://backend.composio.dev') throw new Error('Unexpected network target');
    const route=u.pathname.replace('/api/v3.1','');
    if(route==='/tools') { expect(u.searchParams.has('query')).toBe(false); expect(u.searchParams.get('tool_slugs')).toBe(mode==='selected'?slug:null); return jsonResponse({items:[tool],next_cursor:null,total_items:1}); }
    if(route===`/tools/${slug}`) return jsonResponse(tool);
    if(route===`/toolkits/${toolkit}`) return jsonResponse(api);
    if(route===`/connected_accounts/${account.id}`) return jsonResponse(account);
    if(route===`/tools/execute/${slug}` && init?.method==='POST') {
      const payload=JSON.parse(String(init.body));
      expect(payload).toMatchObject({user_id:siteId,connected_account_id:account.id,version:tool.version,arguments:{limit:2}});
      dispatches++;
      return jsonResponse(dispatches===1?{successful:false,error:apiKey,data:{status_code:403}}:{successful:true,error:null,data:{items:[{id:privateRow}]}});
    }
    throw new Error('Unexpected offline request');
  });
  const found=await router.execute({action:'search',query:'list pallets',catalog_query:'pallets'});
  const name=`connector:${connectorId}:${slug}`;
  expect(found.tools.map((t:{name:string})=>t.name)).toContain(name);
  const desc=await router.execute({action:'describe',name}); expect(desc.success).toBe(true); expect(dispatches).toBe(0);
  const invalid=await router.execute({action:'call',name,args:JSON.stringify({version:desc.version,schema_hash:desc.schema_hash,arguments:{limit:101}})});
  expect(invalid).toMatchObject({executed:false,automatic_retry:false,argument_issue:{path:'arguments.limit',rule:'maximum',bound:100},recovery:{action:'fix_arguments'}});
  expect(dispatches).toBe(0);
  const args=JSON.stringify({version:desc.version,schema_hash:desc.schema_hash,arguments:{limit:2}});
  const denied=await router.execute({action:'call',name,args});
  expect(denied).toMatchObject({code:'APP_RESOURCE_DENIED',automatic_retry:false,recovery:{action:'ask_user'}});
  expect(denied).not.toHaveProperty('executed'); expect(JSON.stringify(denied)).not.toContain(apiKey); expect(dispatches).toBe(1);
  // Separate explicit user operation, not automatic retry after a denial.
  ctx.requestId=randomUUID();
  const ok=await router.execute({action:'call',name,args});
  expect(ok).toEqual({success:true,receipt:{status:'private_result_ready',url:`/connectors/results/${receiptId}`},guidance:expect.stringContaining('cannot inspect or summarize')});
  expect(JSON.stringify(ok)).not.toContain(String(privateRow)); expect(JSON.stringify(ok)).not.toContain(apiKey);
  expect(mockRpc).toHaveBeenCalledWith('store_connector_direct_result',expect.objectContaining({p_user_id:ctx.userId,
    p_report:expect.objectContaining({rows:[['$.items[0].id',String(privateRow)]]})}));
  expect(dispatches).toBe(2);
});
