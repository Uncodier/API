import { randomUUID } from 'node:crypto';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { connectorGateway } from '../tool-resolver';
import { listUsableConnectors, resolveConnectorAction, loadConnectorCredential } from '../access';
import type { AuthorizedConnector } from '../types';
import { accountFixture, connectorFixture, providerFixture, toolkitFixture, toolFixture, secret, jsonResponse } from './composio-fixtures';

const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args:unknown[]) => mockRpc(...args) } }));
jest.mock('../access', () => ({ listUsableConnectors:jest.fn(), resolveConnectorAction:jest.fn(),loadConnectorCredential:jest.fn() }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ ...jest.requireActual('@/app/api/agents/tools/router/screen-access'),
  assertToolScreenAccess: jest.fn(), loadToolScreenAccess: jest.fn(async () => ({isAdmin:true,blockedScreens:[]})) }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService:{generateEmbeddings:jest.fn(async () => {throw new Error('offline');})} }));
jest.mock('@/app/api/agents/tools/catalog_commerce/batch-admin-tool', () => ({bindCatalogBatchActor: (tool:unknown)=>tool}));

const old = {binding:process.env.CONNECTOR_PROVIDER_BINDINGS, origin:process.env.CONNECTORS_WEB_ORIGIN};
afterEach(()=>{
  jest.restoreAllMocks(); jest.clearAllMocks();
  for (const [setting,value] of [['CONNECTOR_PROVIDER_BINDINGS',old.binding],['CONNECTORS_WEB_ORIGIN',old.origin]] as const) {
    if (value===undefined) delete process.env[setting]; else process.env[setting]=value;
  }
});

// Network boundary only: real catalog parser, gateway, resolver, descriptor, adapter and failure recovery.
it('finds a new action, handles an app resource denial and can still satisfy a separately requested read without probing',async()=>{
  const siteId=randomUUID(),connectorId=randomUUID(),revision=secret(),apiKey=secret();
  const ctx={siteId,userId:randomUUID(),agentId:randomUUID(),instanceId:randomUUID(),catalogUserSession: true as const, host:'assistant' as const};
  const toolkit='warehouse', slug='WAREHOUSE_LIST_PALLETS', scope='pallets.read';
  const provider={...providerFixture(),site_id:siteId,provider_user_id:siteId,credential_revision:revision};
  const bound: AuthorizedConnector={connector:{...connectorFixture(),id:connectorId,site_id:siteId,toolkit_slug:toolkit},provider,
    policy:{catalog_reads:true,tool_access_mode:'selected',allowed_tools:[slug],allowed_hosts:['assistant'],require_approval:false}};
  process.env.CONNECTORS_WEB_ORIGIN='https://app.example.test';
  process.env.CONNECTOR_PROVIDER_BINDINGS=JSON.stringify([{site_id:siteId,credential_revision:revision,project_id:provider.project_id,oauth_verifier_url:'https://app.example.test/connectors/callback'}]);
  jest.mocked(listUsableConnectors).mockResolvedValue([bound]); jest.mocked(resolveConnectorAction).mockResolvedValue(bound);
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey,revision,source:'byok'});
  const tool={...toolFixture(),slug,name:'List pallets',toolkit:{slug:toolkit},description:'Lists pallets.',scopes:[scope],tags:['readOnlyHint'],
    input_parameters:{type:'object',properties:{limit:{type:'integer',maximum:100}}},
    output_parameters:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{id:{type:'integer'}}}}}}};
  const api={...toolkitFixture(),slug:toolkit,enabled:true};
  const account={...accountFixture(),user_id:siteId,toolkit:{slug:toolkit},state:{authScheme:'OAUTH2',val:{scope}}};
  const native={name:'leads',description:'Native leads',parameters:{type:'object'},execute:jest.fn()};
  const router=toolsRouterTool([native,connectorGateway(async()=>ctx)],ctx);
  let dispatches=0; const receiptId=randomUUID(); const privateRow=73605391;
  mockRpc.mockImplementation(name=>({abortSignal:async()=>({ data: name==='connector_private_result_ready'?true:receiptId })}));
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const u=new URL(String(url)); if(u.origin!=='https://backend.composio.dev') throw new Error('Unexpected network target');
    const route=u.pathname.replace('/api/v3.1','');
    if(route==='/tools') { expect(u.searchParams.has('query')).toBe(false); return jsonResponse({items:[tool],next_cursor:null,total_items:1}); }
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
  const args=JSON.stringify({version:desc.version,schema_hash:desc.schema_hash,arguments:{limit:2}});
  const denied=await router.execute({action:'call',name,args});
  expect(denied).toMatchObject({code:'APP_RESOURCE_DENIED',automatic_retry:false,recovery:{action:'ask_user'}});
  expect(denied).not.toHaveProperty('executed'); expect(JSON.stringify(denied)).not.toContain(apiKey); expect(dispatches).toBe(1);
  // Separate explicit user operation, not automatic retry after a denial.
  const ok=await router.execute({action:'call',name,args});
  expect(ok).toEqual({success:true,receipt:{status:'private_result_ready',url:`/connectors/results/${receiptId}`},guidance:expect.stringContaining('cannot inspect or summarize')});
  expect(JSON.stringify(ok)).not.toContain(String(privateRow)); expect(JSON.stringify(ok)).not.toContain(apiKey);
  expect(mockRpc).toHaveBeenCalledWith('store_connector_private_result',expect.objectContaining({p_user_id:ctx.userId,
    p_report:expect.objectContaining({rows:[[String(privateRow),'','']]})}));
  expect(dispatches).toBe(2);
});
