import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadConnectorCredential} from '../account-access';
import {failureForAgent} from '../agent-recovery';
import {hashConnectorSchema} from '../composio-tool-json';
import {createInstanceScopedRead,type ScopedReadBinding} from '../instance-scoped-read';
import {createProviderDirectRuntime} from '../provider-direct-runtime';
import {getConnectorProvider,getVisibleConnector} from '../account-access';
import {SUPABASE_CATALOG_SLUG as slug} from '../provider-report-action';
import {accountFixture,connectorFixture,providerFixture,toolkitFixture,toolFixture,secret,jsonResponse} from './composio-fixtures';
import published from './fixtures/supabase-report-20261116_00.json';
import {attestedProject,byokOrigin,byokRpc} from './byok-rpc-fixture';

const mockRpc = jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...args:unknown[])=>mockRpc(...args)}}));
jest.mock('../account-access',()=>({loadConnectorCredential:jest.fn(),getConnectorProvider:jest.fn(),getVisibleConnector:jest.fn()}));
jest.mock('@/lib/database/hosted-project-identity',()=>({withDirectActorEvidence:async(check:()=>Promise<boolean>)=>({allowed:await check(),localProjectRef:'a'.repeat(20)})}));
const oldOrigin = process.env.CONNECTORS_WEB_ORIGIN;
const claimRpc = 'claim_connector_instance_scoped_read', storeRpc = 'store_connector_instance_scoped_read';
const version = '20261116_00';
const sourcesRpc = 'connector_instance_report_sources';
const allSources = ['paid_sales','tender_awards','approved_orders'];
const query = "SELECT currency, COUNT(DISTINCT site_id) AS sites, SUM(amount) AS total FROM analytics.paid_sales WHERE sale_date < $1 GROUP BY currency ORDER BY total DESC LIMIT 1";
const workspace = {query,scope:'workspace',parameters:['2026-10-01']};
const platform = {...workspace,scope:'platform'};
const amount = '90071992547409930.010';
afterEach(()=>{jest.restoreAllMocks();jest.resetAllMocks();if(oldOrigin===undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN=oldOrigin;});

type CallBody = {user_id:string;connected_account_id:string;version:string;arguments:{ref:string;query:string;parameters:string[]}};
function setup() {
  const id=randomUUID(), site=randomUUID(), claimId=randomUUID(), receiptId=randomUUID(), key=secret();
  const provider = {...providerFixture(),id:randomUUID(),site_id:site,provider_user_id:site,credential_revision:secret()};
  const ref = 'a'.repeat(20);
  const connector = {...connectorFixture(),id,site_id:site,provider_id:provider.id,revocation_dispatched:false,supabase_project_ref:ref,toolkit_slug:'supabase',granted_scopes:[]};
  const binding:ScopedReadBinding = {connector,provider,localProjectRef:ref,policyRevision:7,directRevision:2,
    context:{host:'assistant',catalogUserSession:true,requestId:randomUUID(),userId:randomUUID(),agentId:randomUUID(),instanceId:randomUUID(),
      siteId:site,connectorIdHint:id,sourceDigest:secret()}};
  const resolve=jest.fn(async()=>binding);
  process.env.CONNECTORS_WEB_ORIGIN=byokOrigin;
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:key,revision:provider.credential_revision,source:'byok'});
  const api = {...toolkitFixture(),slug:'supabase',auth_schemes:['API_KEY']};
  const tool = {...toolFixture(),...published,slug,version,description:'Provider-only documentation',toolkit:{slug:'supabase'},
    scopes:['database_read'],tags:['important','readOnlyHint','openWorldHint','Database']};
  const account = {...accountFixture(),toolkit:tool.toolkit,user_id:site,data:{base_url:'https://api.supabase.com'},
    state:{authScheme:'API_KEY',val:{full:'http...'}},auth_config:{id:connector.auth_config_id,is_disabled:false}};
  const bodies:CallBody[]=[],claims:Record<string,unknown>[]=[],stores:Record<string,unknown>[]=[];
  const events:string[]=[], entitlement = {allowed:true,id:randomUUID()};
  let reserved = false, grantAtClaim:string|undefined;
  const ok=(data:unknown)=>({data,error:null}), fail=(code:string)=>({data:null,error:{code},status:403});
  const state = {tool:tool as unknown,account:account as unknown,kit:api as unknown,
    onAccount:()=>{}, onPost:()=>{}, onStored:()=>{}, afterStore:(result:unknown)=>result,
    claimReply:undefined as unknown, sourcesReply:ok({workspace:allSources,platform:allSources}) as unknown,
    response:(body:CallBody)=>jsonResponse({successful:true,error:null,log_id:secret(),logs:[key],data:{rows_returned:1,result:[{
      analytics_scope:body.arguments.parameters.at(-1),analytics_rows:[{currency:'USD',sites:'2',total:amount},{currency:'MXN',sites:'1',total:'100.00'}],
    }]}})};
  mockRpc.mockImplementation((name:string,params:Record<string,unknown>)=>{
    if(name===byokRpc) return attestedProject(provider)(name,params);
    return {abortSignal:async()=>{
      if(name===sourcesRpc)return state.sourcesReply;
      if(name===claimRpc){ events.push('claim'); claims.push(params);
        if(state.claimReply!==undefined)return state.claimReply;
        if(!entitlement.allowed)return fail('42501'); if(reserved)return fail('P0D03');
        reserved=true;grantAtClaim=entitlement.id;return ok(claimId);
      }
      if(name===storeRpc){events.push('store');stores.push(params);
        if(!entitlement.allowed || entitlement.id!==grantAtClaim)return fail('42501');
        state.onStored();return state.afterStore(ok(receiptId));
      }
      throw new Error('Unexpected database call');
    }};
  });
  const http=jest.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
    const u=new URL(String(url));
    if(u.origin!=='https://backend.composio.dev'||(options?.headers as Record<string,string>)['x-api-key']!==key) throw new Error('Unexpected credential/target');
    const path=u.pathname.replace('/api/v3.1','')+u.search;
    if(options?.method==='GET'){
      if(path===`/tools/${slug}?version=${version}`)return jsonResponse(state.tool);
      if(path==='/toolkits/supabase')return jsonResponse(state.kit);
      if(path===`/connected_accounts/${account.id}`){state.onAccount();return jsonResponse(state.account);}
      if(path===`/connected_accounts?user_ids=${site}&connected_account_ids=${account.id}&limit=1`)return jsonResponse({items:[account],next_cursor:null});
    }
    if(options?.method==='POST' && path===`/tools/execute/${slug}`){
      const body:CallBody=JSON.parse(String(options.body));events.push('post');bodies.push(body);state.onPost();return state.response(body);
    }
    throw new Error('Unexpected provider route');
  });
  const run=createInstanceScopedRead(resolve),name=`report:${id}:MAKINARI_METRICS`;
  async function describe(){const d=await run.describe(name);return {...d,call:(args:unknown)=>run.call(name,{version:d.version,schema_hash:d.schema_hash,arguments:args})};}
  return {run,resolve,describe,name,id,site,ref,key,tool,api,account,binding,provider,claimId,receiptId,events,claims,stores,bodies,state,http,entitlement};
}

it.each(['workspace','platform'] as const)('a masked, exact hosted PAT produces only the claimed %s private result',async scope=>{
  const f=setup();expect(f.http).not.toHaveBeenCalled();const d=await f.describe();
  expect(d.effect).toBe('read');expect(f.events).toEqual([]);
  expect(d.parameters.properties.arguments.required).toEqual(['query','scope']);
  expect(Object.keys(d.parameters.properties.arguments.properties).sort()).toEqual(['parameters','query','scope']);
  expect(JSON.stringify(d.parameters)).toContain('paid_sales');
  const args={...workspace,scope};const out=await d.call(args);
  expect(out).toEqual({success:true,receipt:{status:'private_result_ready',url:`/connectors/results/${f.receiptId}`},guidance:expect.stringContaining('cannot inspect or summarize')});
  expect(f.events).toEqual(['claim','post','store']);expect(f.bodies).toHaveLength(1);
  const body=f.bodies[0];expect(body).toEqual({user_id:f.site,connected_account_id:f.account.id,version,arguments:{ref:f.ref,query:expect.any(String),parameters:expect.any(Array)}});
  expect(body.arguments.query).toContain(`'supabase_read_only_user'`);expect(body.arguments.query).toContain('FROM ONLY "public"."sales"');
  expect(body.arguments.query).not.toContain(query);expect(body.arguments.query).not.toContain(args.parameters[0]);expect(body.arguments.parameters).toContain(args.parameters[0]);
  if(scope==='workspace'){expect(body.arguments.parameters[0]).toBe(f.site);expect(body.arguments.query).toContain('s.site_id = $1::pg_catalog.uuid');}
  else{expect(body.arguments.parameters).not.toContain(f.site);expect(body.arguments.query).toContain('s.site_id IS NOT NULL');}
  const ctx=f.binding.context;const base={p_site_id:f.site,p_user_id:ctx.userId,p_instance_id:ctx.instanceId,p_agent_id:ctx.agentId,p_connector_id:f.id,
    p_request_id:ctx.requestId,p_connector_revision:1,p_policy_revision:7,p_direct_revision:2,p_credential_revision:f.provider.credential_revision,
    p_version:version,p_project_ref:f.ref,p_schema_hash:d.schema_hash,p_source:'paid_sales',p_data_scope:scope};
  expect(f.claims).toEqual([{...base,p_arguments_digest:hashConnectorSchema(args)}]);
  expect(f.stores).toEqual([{...base,p_claim_id:f.claimId,p_report:{title:scope==='workspace'?'Workspace analytics query':'All-account analytics query',
    columns:['currency','sites','total'],rows:[['USD','2',amount]],note:expect.stringContaining('not a complete breakdown')}}]);
  for(const s of [f.key,f.ref,f.account.id,f.provider.project_id,f.claimId,ctx.userId,query,amount,'"USD"','Provider-only documentation'])
    expect(JSON.stringify([out,d])).not.toContain(s);
  expect(JSON.stringify(f.stores)).not.toContain(f.key);
});

it('routes the same qualified tool from a real selected-account search through describe, scoped claim, exact provider call and private delivery',async()=>{
  const f=setup();const {context,connector,provider,policyRevision,directRevision}=f.binding;
  const scopedRpc=mockRpc.getMockImplementation()!;
  jest.mocked(getVisibleConnector).mockResolvedValue(connector);
  jest.mocked(getConnectorProvider).mockResolvedValue(provider);
  mockRpc.mockImplementation((name,params)=>{
    if(name==='connector_direct_actor'||name==='connector_direct_accounts'||name==='connector_instance_scoped_read') {
      const data=name==='connector_direct_actor'?true:name==='connector_direct_accounts'?[]:{connector_id:f.id,project_ref:f.ref,
        connector_revision:connector.revision,policy_revision:policyRevision,direct_revision:directRevision,credential_revision:provider.credential_revision};
      return {abortSignal:async()=>({data,error:null})};
    }
    return scopedRpc(name,params);
  });
  const run=createProviderDirectRuntime(async()=>context);
  const page=await run.search({connector_id:f.id,query:'indicadores de ventas',tool_origin:'makinari_report'});
  expect(page.tools.map(row=>row.name)).toEqual([f.name]);expect(f.http).not.toHaveBeenCalled();
  const descriptor=await run.describe(page.tools[0].name);
  expect(descriptor).toMatchObject({tool_origin:'makinari_report',toolkit:'makinari',connector_id:f.id});
  expect(f.events).toEqual([]);
  const result=await run.call(descriptor.name,{version:descriptor.version,schema_hash:descriptor.schema_hash,arguments:workspace});
  expect(result).toMatchObject({success:true,receipt:{url:`/connectors/results/${f.receiptId}`}});
  expect(f.events).toEqual(['claim','post','store']);expect(f.bodies[0].connected_account_id).toBe(connector.provider_account_id);
  expect(f.claims[0]).toMatchObject({p_user_id:context.userId,p_request_id:context.requestId,p_connector_id:f.id,p_data_scope:'workspace'});
  expect(JSON.stringify(result)).not.toContain(amount);
});

it('describes only admitted logical sources and scope, never infers grants from a hosted token or selects another scope',async()=>{
  const f=setup(); f.state.sourcesReply={data:{workspace:['paid_sales']},error:null};
  const d=await f.describe(), schema=d.parameters.properties.arguments.properties;
  expect(d.available_sources).toEqual({workspace:['paid_sales']}); expect(schema.scope.enum).toEqual(['workspace']);
  expect(schema.query.description).toMatch(/analytics\.paid_sales.*amount:numeric/);
  expect(JSON.stringify(d)).not.toMatch(/platform|tender_awards|approved_orders|net_amount_minor|grant_id/i);
  const {context:c,connector,policyRevision,directRevision,provider}=f.binding;
  expect(mockRpc).toHaveBeenCalledWith(sourcesRpc,{p_site_id:f.site,p_user_id:c.userId,p_instance_id:c.instanceId,p_agent_id:c.agentId,p_request_id:c.requestId,
    p_connector_id:f.id,p_project_ref:f.ref,p_connector_revision:connector.revision,p_policy_revision:policyRevision,p_direct_revision:directRevision,p_credential_revision:provider.credential_revision});
  await expect(d.call(platform)).rejects.toMatchObject({code:'ANALYTICS_SCOPE_DENIED',executed:false});
  await expect(d.call({scope:'workspace',query:'SELECT count(*) FROM analytics.tender_awards'})).rejects.toMatchObject({code:'ANALYTICS_WORKSPACE_DENIED',executed:false});
  expect(f.events).toEqual([]); await d.call(workspace); expect(f.events).toEqual(['claim','post','store']);
  expect(f.claims[0].p_data_scope).toBe('workspace'); expect(f.bodies[0].arguments.parameters[0]).toBe(f.site);
});

it('compiles only the requested pair and invalidates an old descriptor on authority drift',async()=>{
  const f=setup(); f.state.sourcesReply={data:{workspace:allSources,platform:['paid_sales']},error:null};
  const d=await f.describe(); expect(d.available_sources).toEqual({workspace:allSources,platform:['paid_sales']});
  expect(d.parameters.properties.arguments.properties.scope.enum).toEqual(['workspace','platform']);
  const help=d.parameters.properties.arguments.properties.query.description;
  expect(help).toMatch(/analytics\.paid_sales\([^)]*\) \[workspace, platform\]/);
  expect(help).toMatch(/analytics\.approved_orders\([^)]*\) \[workspace\]/);
  await expect(d.call({scope:'platform',query:'SELECT count(*) FROM analytics.approved_orders'})).rejects.toMatchObject({code:'ANALYTICS_SCOPE_DENIED',executed:false});
  f.state.sourcesReply={data:{workspace:allSources},error:null};
  await expect(d.call(platform)).rejects.toMatchObject({code:'ANALYTICS_SCOPE_DENIED',executed:false});
  await expect(d.call(workspace)).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',executed:false});
  expect((await f.describe()).schema_hash).not.toBe(d.schema_hash); expect(f.events).toEqual([]);
});

it.each([
  [null,'SCOPED_READ_NOT_ALLOWED'],[{},'SCOPED_READ_NOT_ALLOWED'],[{workspace:[]},'DIRECT_POLICY_UNAVAILABLE'],
  [{workspace:['published_views']},'DIRECT_POLICY_UNAVAILABLE'],[{platform:['paid_sales']},'DIRECT_POLICY_UNAVAILABLE'],
  [{workspace:['paid_sales','paid_sales']},'DIRECT_POLICY_UNAVAILABLE'],[{workspace:['paid_sales'],platform:['tender_awards']},'DIRECT_POLICY_UNAVAILABLE'],
  [{workspace:['paid_sales'],grant_id:randomUUID()},'DIRECT_POLICY_UNAVAILABLE'],
])('fails closed on empty or incompatible authority: %p',async (data,code)=>{
  const f=setup(); f.state.sourcesReply={data,error:null};
  await expect(f.describe()).rejects.toMatchObject({code}); expect(f.events).toEqual([]);
});

it('does not treat an unavailable report-source RPC as workspace permission',async()=>{
  const f=setup(); f.state.sourcesReply={data:null,error:{code:'PGRST202',message:f.key}};
  await expect(f.describe()).rejects.toMatchObject({code:'DIRECT_POLICY_UNAVAILABLE'}); expect(f.events).toEqual([]);
});

it('rejects a missing or disallowed scope or source, raw SQL/selectors, inventory, identifiers, and platform row samples before claim or POST',async()=>{
  const f=setup(),d=await f.describe();
  for(const args of [{},{scope:'workspace'},{query},{...workspace,scope:'all'},{...workspace,scope:null},{...workspace,ref:f.ref},
    {...workspace,view:'summary'},{after:'summary'},{limit:10},{...workspace,query:'select count(*) from public.sales'},
    {...workspace,query:'select count(*) from analytics.bookings'},{...workspace,query:'select site_id from analytics.paid_sales'},
    {...workspace,query:'update analytics.paid_sales set amount=1'}, {...platform,parameters:[],query:'select currency from analytics.paid_sales'}]){
    await expect(d.call(args)).rejects.toMatchObject({executed:false,effectStarted:false});
  }
  expect(f.events).toEqual([]);
});

it.each([['paid_sales','platform','ANALYTICS_SCOPE_DENIED'],['tender_awards','workspace','ANALYTICS_WORKSPACE_DENIED'],
  ['approved_orders','platform','ANALYTICS_SCOPE_DENIED']])('denial of %s in %s never posts, downgrades scope or falls back',async(source,scope,code)=>{
  const f=setup(),d=await f.describe();f.entitlement.allowed=false;
  const e=await d.call({scope,query:`SELECT count(*) FROM analytics.${source}`}).catch(err=>err);
  expect(failureForAgent(e)).toMatchObject({code,executed:false,automatic_retry:false});
  expect(f.events).toEqual(['claim']);expect(f.claims[0]).toMatchObject({p_data_scope:scope,p_source:source});
});

it.each(['structured','transport'] as const)('keeps a real upstream 403 (%s) distinct from a local or OAuth denial without replaying',async mode=>{
  const f=setup(),d=await f.describe();
  f.state.response=()=>mode==='structured' ? jsonResponse({successful:false,error:f.key,data:{status_code:403,detail:f.key},logs:[f.key]}) : jsonResponse({error:f.key},403);
  const err=await d.call(platform).catch(e=>e);
  const failure=failureForAgent(err);expect(failure).toMatchObject({code:mode==='structured'?'APP_RESOURCE_DENIED':'PROVIDER_FORBIDDEN',automatic_retry:false,recovery:{action:'ask_user'}});
  expect(failure).not.toHaveProperty('executed');expect(JSON.stringify(failure)).not.toContain(f.key);expect(err.message).not.toContain(f.key);
  expect(f.events).toEqual(['claim','post']);expect(f.bodies[0].connected_account_id).toBe(f.account.id);
  expect(f.bodies[0].arguments.parameters).not.toContain(f.site);
});

it('requires the exact qualified read reference, independently proven same project and private human turn even before metadata/keys',async()=>{
  const f=setup();
  for(const name of [slug,`report:${randomUUID()}:MAKINARI_METRICS`,`connector:${f.id}:${slug}`,`connector:${f.id}:SUPABASE_GET_PROJECT`,f.name+'\n']) await expect(f.run.describe(name)).rejects.toThrow();
  for(const change of [{localProjectRef:'b'.repeat(20)},{localProjectRef:undefined},{context:{...f.binding.context,requestId:undefined}},
    {context:{...f.binding.context,host:'workflow'}},{context:{...f.binding.context,catalogUserSession:undefined}},{context:{...f.binding.context,connectorIdHint:randomUUID()}},
    {connector:{...f.binding.connector,provider_account_id:'instant_account'}},{connector:{...f.binding.connector,revocation_dispatched:true}},
    {provider:{...f.provider,provider_user_id:randomUUID()}},{directRevision:0}]) {
    f.resolve.mockResolvedValueOnce({...f.binding,...change} as ScopedReadBinding);
    await expect(f.run.describe(f.name)).rejects.toThrow();
  }
  expect(f.http).not.toHaveBeenCalled();expect(loadConnectorCredential).not.toHaveBeenCalled();expect(f.events).toEqual([]);
});

it('verifies credential/project and exact live tool, PRIVATE owner, auth config and hosted origin',async()=>{
  const f=setup(),d=await f.describe(), call=()=>d.call(workspace);
  jest.mocked(loadConnectorCredential).mockResolvedValueOnce({apiKey:f.key,revision:secret(),source:'byok'});
  f.http.mockClear();await expect(call()).rejects.toMatchObject({executed:false,code:'ACCESS_CHANGED'});expect(f.http).not.toHaveBeenCalled();
  mockRpc.mockReturnValueOnce({abortSignal:async()=>({data:'other_project',error:null})});
  await expect(call()).rejects.toMatchObject({executed:false,code:'ACCESS_CHANGED'});expect(f.http).not.toHaveBeenCalled();
  for(const patch of [{slug:'SUPABASE_RUN_QUERY'},{toolkit:{slug:'different'}},
    {no_auth:true},{version:'latest'},{input_parameters:{}},{output_parameters:{}},{is_deprecated:true}]){
    f.state.tool={...f.tool,...patch};await expect(call()).rejects.toMatchObject({executed:false});
  }
  f.state.tool=f.tool;
  for(const patch of [{id:'foreign_account'},{user_id:randomUUID()},{auth_config:{...f.account.auth_config,id:'other_config'}},{is_disabled:true},
    {experimental:{account_type:'SHARED'}},{status:'INACTIVE'},{experimental:{}},{state:{authScheme:'OAUTH2',val:{scope:'database_read'}}},
    {data:{}},{data:{base_url:'https://other.example.test'}},{state:{authScheme:'API_KEY',val:{full:'https://other.example.test'}}}]){
    f.state.account={...f.account,...patch};await expect(call()).rejects.toMatchObject({executed:false});
  }
  f.state.account=f.account;f.state.kit={...f.api,toolkit_type:'mcp'};
  await expect(call()).rejects.toMatchObject({executed:false,code:'TOOL_UNREVIEWED'});
  expect(f.events).toEqual([]);
});

it('an exact filtered owner lookup may confirm ownership but cannot supply the PAT or private scheme',async()=>{
  const f=setup();const {user_id:_,...detail}=f.account;
  f.state.account={...detail,experimental:undefined};await expect(f.run.describe(f.name)).rejects.toMatchObject({code:'CONNECTOR_ACCOUNT_MISMATCH'});
  f.state.account=detail;const d=await f.describe();await d.call(workspace);expect(f.events).toEqual(['claim','post','store']);
  expect(f.http.mock.calls.filter(([u])=>String(u).includes('connected_accounts?')).map(([u])=>String(u))).toEqual(
    Array(3).fill(`https://backend.composio.dev/api/v3.1/connected_accounts?user_ids=${f.site}&connected_account_ids=${f.account.id}&limit=1`));
});

it('a descriptor is not reusable for a different member, turn, prompt agent, instance, policy epoch, credential, or provider contract',async()=>{
  const f=setup(),d=await f.describe(),b=f.binding;
  for(const patch of [{policyRevision:b.policyRevision+1},{directRevision:b.directRevision+1},{connector:{...b.connector,revision:2}},
    ...['requestId','userId','agentId','instanceId','sourceDigest'].map(k=>({context:{...b.context,[k]:k==='sourceDigest'?secret():randomUUID()}}))]){
    f.resolve.mockResolvedValueOnce({...b,...patch});await expect(d.call(workspace)).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',executed:false});
  }
  f.state.tool={...f.tool,input_parameters:{...f.tool.input_parameters,additionalProperties:false}};
  await expect(d.call(workspace)).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',executed:false});expect(f.events).toEqual([]);
});

it('does not POST or reserve if member identity or credential changes while live proof is in flight',async()=>{
  const f=setup(),d=await f.describe(),member=f.binding.context.userId;
  f.state.onAccount=()=>{f.binding.context.userId=randomUUID();};
  await expect(d.call(workspace)).rejects.toMatchObject({code:'ACCESS_CHANGED',executed:false});
  f.binding.context.userId=member;f.state.onAccount=()=>{jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:secret(),revision:f.provider.credential_revision,source:'byok'});};
  await expect(d.call(workspace)).rejects.toMatchObject({code:'ACCESS_CHANGED',executed:false});expect(f.events).toEqual([]);
});

it('takes a bounded immutable call snapshot before resolving anything',async()=>{
  const f=setup(),d=await f.describe();
  const input={...workspace,parameters:[...workspace.parameters]}; const pending=d.call(input);
  input.scope='platform';input.parameters[0]='2027-01-01';input.query='SELECT count(*) FROM analytics.tender_awards';
  await pending;expect(f.claims[0]).toMatchObject({p_data_scope:'workspace',p_source:'paid_sales',p_arguments_digest:hashConnectorSchema(workspace)});
  expect(f.bodies[0].arguments.parameters).toContain(workspace.parameters[0]);
});

it.each(['actor after dispatch','platform grant rotated','unattested role/source','unexpected column','unrecognized native text','stale marker','unusable receipt','actor after store'] as const)('does not release private data after %s',async phase=>{
  const f=setup(),d=await f.describe();let code:string;
  switch(phase){
    case 'actor after dispatch': f.state.onPost=()=>{f.binding.context.requestId=randomUUID();};code='ACCESS_CHANGED';break;
    case 'platform grant rotated': f.state.onPost=()=>{f.entitlement.id=randomUUID();};code='ANALYTICS_SCOPE_DENIED';break;
    case 'unattested role/source': f.state.response=()=>jsonResponse({successful:true,error:null,data:{result:[{analytics_rows:null,analytics_scope:null}]}});code='ANALYTICS_SOURCE_UNVERIFIED';break;
    case 'unexpected column': f.state.response=b=>jsonResponse({successful:true,error:null,data:{result:[{analytics_scope:b.arguments.parameters.at(-1),analytics_rows:[{currency:'USD',sites:'1',total:'2',raw:f.key}]}]}});code='CONNECTOR_RESULT_UNSUPPORTED';break;
    case 'unrecognized native text': f.state.response=b=>jsonResponse({successful:true,error:null,data:{result:[{analytics_scope:b.arguments.parameters.at(-1),analytics_rows:[{currency:'Diagnostic',sites:'2',total:'3'}]}]}});code='CONNECTOR_RESULT_UNSUPPORTED';break;
    case 'stale marker': f.state.response=()=>jsonResponse({successful:true,error:null,data:{result:[{analytics_scope:randomUUID(),analytics_rows:[]}]}});code='CONNECTOR_RESULT_UNSUPPORTED';break;
    case 'unusable receipt': f.state.afterStore=()=>({error:null,data:{receipt:f.key}});code='DIRECT_RESULT_UNCONFIRMED';break;
    case 'actor after store':f.state.onStored=()=>{f.binding.context.userId=randomUUID();};code='ACCESS_CHANGED';break;
  }
  const err=await d.call(platform).catch(e=>e);expect(err).toMatchObject({code});
  expect(err).not.toHaveProperty('executed');expect(err).not.toHaveProperty('receipt');expect(JSON.stringify(failureForAgent(err))).not.toContain(f.key);
  expect(f.bodies).toHaveLength(1);expect(f.stores).toHaveLength(['actor after store','platform grant rotated','unusable receipt'].includes(phase)?1:0);
});

it('two simultaneous submissions of the same pin and arguments post exactly once, even if the claim has been consumed',async()=>{
  const f=setup(),d=await f.describe();const pair=await Promise.allSettled([d.call(workspace),d.call(workspace)]);
  expect(pair.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const failure=pair.find(r=>r.status==='rejected') as PromiseRejectedResult;
  expect(failureForAgent(failure.reason)).toMatchObject({code:'DIRECT_DISPATCH_ALREADY_CLAIMED',recovery:{action:'reconcile'},automatic_retry:false});
  expect(failure.reason).not.toHaveProperty('executed');
  const replay=await d.call(workspace).catch(e=>e);expect(replay.code).toBe('DIRECT_DISPATCH_ALREADY_CLAIMED');
  expect(f.claims).toHaveLength(3);expect(f.bodies).toHaveLength(1);expect(f.stores).toHaveLength(1);
});

it.each(['lost ack','unknown claim','mismatched store','revoked before retry','transport interrupted twice'] as const)('recovers only a same-claim storage acknowledgment, not the provider read: %s',async mode=>{
  const f=setup(),d=await f.describe();
  if(mode==='unknown claim') f.state.claimReply={error:null,data:'not a UUID'};
  f.state.afterStore=ok=>{
    if(mode==='mismatched store') return {error:{code:'P0D04'},data:null,status:409};
    if(mode==='revoked before retry')f.binding.policyRevision++;
    if(mode==='transport interrupted twice')throw new Error(f.key);
    if(f.stores.length===1)return {status:0,data:null,error:{message:f.key}};
    return ok;
  };
  const result=await d.call(workspace).catch(e=>e);
  if(mode==='lost ack')expect(result.receipt.url).toBe(`/connectors/results/${f.receiptId}`);
  else {
    expect(result).toMatchObject({code:mode==='unknown claim'?'DIRECT_DISPATCH_UNCONFIRMED':mode==='revoked before retry'?'ACCESS_CHANGED':'DIRECT_RESULT_UNCONFIRMED'});
    expect(result).not.toHaveProperty('executed');expect(result).not.toHaveProperty('receipt');expect(result.message).not.toContain(f.key);
  }
  expect(f.claims).toHaveLength(1);expect(f.bodies).toHaveLength(mode==='unknown claim'?0:1);
  expect(f.stores).toHaveLength(mode==='unknown claim'?0:mode==='lost ack'||mode==='transport interrupted twice'?2:1);
  if(f.stores.length===2) expect(f.stores[1]).toEqual(f.stores[0]);
});

it('executes the actual dispatched SQL on a synthetic two-site PostgreSQL fixture; only the scoped DTO reaches private storage',async()=>{
  // Local WASM PostgreSQL, no socket or cloud credentials. The provider boundary executes only
  // the emitted statement with its actual bind list, under the reporting role used by the guard.
  for(const scope of ['workspace','platform'] as const){
    const f=setup(),d=await f.describe();
    const setupSql=`CREATE ROLE supabase_read_only_user BYPASSRLS; GRANT pg_read_all_data TO supabase_read_only_user;
      CREATE TABLE sales(site_id uuid,sale_date date,status text,amount numeric,amount_due numeric,currency text);
      INSERT INTO sales VALUES ('${f.site}','2026-09-24','completed',100.25,0,'USD'),
        ('${randomUUID()}','2026-09-25','completed',50.25,0,'usd'),('${f.site}','2026-09-26','completed',90,4,'USD'),
        ('${f.site}','2026-10-02','completed',75,0,'USD'); ALTER TABLE sales ENABLE ROW LEVEL SECURITY; SET ROLE supabase_read_only_user;`;
    f.state.response=body=>{
      const sql=body.arguments;
      const script=`import {PGlite} from '@electric-sql/pglite'; const db=new PGlite(); try {
        await db.exec(${JSON.stringify(setupSql)}); const r=await db.query(${JSON.stringify(sql.query)},${JSON.stringify(sql.parameters)});
        console.log(JSON.stringify(r.rows)); } finally {await db.close();}`;
      const r=spawnSync(process.execPath,['--input-type=module','-'],{input:script,encoding:'utf8',timeout:15000});
      if(r.status!==0)throw new Error('Isolated reporting fixture failed');
      return jsonResponse({successful:true,error:null,data:{rows_returned:1,result:JSON.parse(r.stdout)}});
    };
    const answer=await d.call({...workspace,scope});
    const total=scope==='workspace'?'100.25':'150.50';
    expect(f.stores[0]).toMatchObject({p_data_scope:scope,p_report:{columns:['currency','sites','total'],rows:[['USD',scope==='workspace'?'1':'2',total]]}});
    expect(answer.receipt.url).toBe(`/connectors/results/${f.receiptId}`);expect(JSON.stringify(answer)).not.toContain(total);
  }
},35000);


it('does not bind plans to cosmetic metadata or optional provider scope inventories and catalogue tags',async()=>{
  const f=setup(),d=await f.describe();
  f.state.tool={...f.tool,description:f.key,tags:undefined,scopes:undefined,scope_requirements:{all:['provider_defined']},input_parameters:{...f.tool.input_parameters,title:f.key}};
  f.state.account={...f.account,auth_config:{...f.account.auth_config,is_composio_managed:true},state:{authScheme:'API_KEY',val:{full:'http...',scope:'projects:read'}}};
  const current=await f.describe();expect(current.schema_hash).toBe(d.schema_hash);expect(JSON.stringify(current)).not.toContain(f.key);
  await expect(d.call(workspace)).resolves.toMatchObject({success:true});expect(f.bodies).toHaveLength(1);
});
