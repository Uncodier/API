import { attestedProject, byokOrigin, byokRpc } from './byok-rpc-fixture';
import { randomUUID } from 'node:crypto';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { connectorGateway } from '../tool-resolver';
import { getConnectorProvider, getVisibleConnector, listVisibleConnectors, loadConnectorCredential } from '../account-access';
import { accountFixture, connectorFixture, providerFixture, toolkitFixture, toolFixture, secret, jsonResponse } from './composio-fixtures';

const mockRpc = jest.fn(), mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args:unknown[]) => mockRpc(...args), from: (table:string) => mockFrom(table) } }));
jest.mock('../account-access', () => ({ requireConnectorSiteAccess:jest.fn(), getVisibleConnector:jest.fn(), listVisibleConnectors:jest.fn(), getConnectorProvider:jest.fn(), loadConnectorCredential:jest.fn() }));
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

it.each([
  {pinned:true,kit:'supabase',projectRef:'a'.repeat(20),actions:['SUPABASE_GET_PROJECT','SUPABASE_RUN_READ_ONLY_QUERY']},
  {pinned:false,kit:'supabase',projectRef:null,actions:['SUPABASE_GET_PROJECT','SUPABASE_RUN_READ_ONLY_QUERY']},
  {pinned:false,kit:'new-toolkit',projectRef:null,actions:['NEW_TOOLKIT_LIST_ITEMS','NEW_TOOLKIT_UPDATE_ITEM']},
])('lists $kit metadata without granting describe or execution (pinned: $pinned)',async ({pinned,kit,projectRef,actions})=>{
  const siteId=randomUUID(), connectorId=randomUUID();
  const ctx={siteId,userId:randomUUID(),agentId:randomUUID(),requestId:randomUUID(),instanceId:randomUUID(),connectorIdHint:pinned?connectorId:undefined,catalogUserSession:true as const,host:'assistant' as const};
  const revision=secret(), apiKey=secret();
  const provider={...providerFixture(),id:randomUUID(),site_id:siteId,provider_user_id:siteId,credential_revision:revision};
  const account={...connectorFixture(),id:connectorId,site_id:siteId,provider_id:provider.id,toolkit_slug:kit,supabase_project_ref:projectRef,access_mode:'workspace' as const,revocation_dispatched:false};
  const entry=(slug:string)=>({...toolFixture(),slug,name:'Catalog entry',toolkit:{slug:kit}});
  const policy={connector_id:connectorId,revision:1,allowed_hosts:['assistant'],allowed_tools:[],tool_access_mode:'all',require_approval:false};
  const tables={connector_policies:[policy],connector_members:[]};
  process.env.CONNECTORS_WEB_ORIGIN=byokOrigin;
  jest.mocked(getVisibleConnector).mockResolvedValue(account);
  jest.mocked(listVisibleConnectors).mockResolvedValue([account]);
  jest.mocked(getConnectorProvider).mockResolvedValue(provider);
  jest.mocked(loadConnectorCredential).mockResolvedValue({source:'byok',apiKey,revision});
  mockFrom.mockImplementation((name:keyof typeof tables)=>{
    const builder={select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),in:jest.fn().mockReturnThis(),abortSignal:async()=>({data:tables[name],error:null})};
    return builder;
  });
  mockRpc.mockImplementation((name,args)=>{
    if(name===byokRpc) return attestedProject(provider)(name,args);
    if(name==='connector_direct_actor') {
      expect(paramsForActor(args)).toEqual([ctx.siteId,ctx.userId,ctx.instanceId,ctx.agentId]);
      return {abortSignal:async()=>({data:true,error:null})};
    }
    expect(name).toBe('connector_ask_connections');
    expect(args.p_connector_id).toBe(pinned || args.p_slug ? connectorId : null);
    return {abortSignal:async()=>({data:[],error:null})};
  });
  const native={name:'report',description:'Local report',parameters:{type:'object'},execute:jest.fn()};
  const http=jest.spyOn(globalThis,'fetch').mockImplementation(async (url,init)=>{
    const target=new URL(String(url));
    expect(target.origin).toBe('https://backend.composio.dev');
    expect(target.pathname).toBe('/api/v3.1/tools');
    expect(target.searchParams.get('toolkit_slug')).toBe(kit);
    expect(init?.method).toBe('GET');
    return jsonResponse({items:actions.map(entry),next_cursor:null,total_items:actions.length});
  });
  const router=toolsRouterTool([native,connectorGateway(async()=>ctx,pinned)],ctx);
  const inventory=await router.execute({action:'list',tool_origin:'provider'});
  expect(inventory).toMatchObject({success:true,connector_next_cursor:null,tools:actions.map(slug=>({
    name:`connector:${connectorId}:${slug}`,availability:'manual_only',unavailability_reason:'account_execution_not_authorized',
  }))});
  expect(inventory.hint).toContain('the saved policy already allows Ask');
  expect(inventory.hint).toContain('Do not tell the user to enable Ask or Legacy catalogue reads');
  expect(JSON.stringify(inventory)).not.toContain(apiKey);
  expect(http).toHaveBeenCalledTimes(1);
  for(const slug of actions) {
    const name=`connector:${connectorId}:${slug}`;
    expect(await router.execute({action:'describe',name})).toMatchObject({success:false,code:'DIRECT_POLICY_REQUIRED'});
    expect(await router.execute({action:'call',name,args:JSON.stringify({version:'20261116_00',schema_hash:'0'.repeat(64),arguments:{}})})).toMatchObject({success:false,code:'DIRECT_POLICY_REQUIRED',executed:false,effectStarted:false});
  }
  // Removing the host stops even the catalog projection without contacting Composio.
  policy.allowed_hosts=[];
  expect(await router.execute({action:'list',tool_origin:'provider'})).toMatchObject({tools:[]});
  expect(mockRpc).not.toHaveBeenCalledWith('connector_instance_scoped_read',expect.anything());
  mockRpc.mockClear();
  for(const connector_id of [connectorId,undefined]) {
    expect(await router.execute({action:'search',query:'investor KPIs',tool_origin:'makinari_report',connector_id})).toMatchObject({success:false,tools:[],executed:false});
  }
  expect(mockRpc).not.toHaveBeenCalled();
  expect(native.execute).not.toHaveBeenCalled(); expect(loadConnectorCredential).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
});

it.each(['all','selected'] as const)('dispatches a new %s-mode action on the chosen account and respects an app denial without probing',async mode=>{
  const siteId=randomUUID(),connectorId=randomUUID(),revision=secret(),apiKey=secret();
  const ctx={siteId,userId:randomUUID(),agentId:randomUUID(),requestId:randomUUID(),instanceId:randomUUID(),catalogUserSession: true as const, host:'assistant' as const};
  const toolkit='warehouse', slug='WAREHOUSE_LIST_PALLETS', scope='pallets.read';
  const provider={...providerFixture(),id:randomUUID(),site_id:siteId,provider_user_id:siteId,credential_revision:revision};
  const dbRow={connector:{...connectorFixture(),id:connectorId,site_id:siteId,toolkit_slug:toolkit,provider_id:provider.id,
      access_mode:'workspace',supabase_project_ref:null,revocation_dispatched:false,created_by:ctx.userId},provider,
    authority_kind:'verified_connection',connection_attempt_id:randomUUID(),direct_revision:3,
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
    if(name==='connector_ask_connections') {
      expect(paramsForActor(args)).toEqual([ctx.siteId,ctx.userId,ctx.instanceId,ctx.agentId]);
      return {abortSignal:async()=>({data:[dbRow],error:null})};
    }
    if(name==='claim_connector_account_dispatch' || name==='store_connector_account_result') {
      expect(args).toMatchObject({p_tool:slug,p_request_id:ctx.requestId,p_authorization_id:dbRow.connection_attempt_id});
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
  expect(mockRpc).toHaveBeenCalledWith('store_connector_account_result',expect.objectContaining({p_user_id:ctx.userId,
    p_report:expect.objectContaining({rows:[['$.items[0].id',String(privateRow)]]})}));
  expect(dispatches).toBe(2);
});
