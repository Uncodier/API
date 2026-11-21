import { attestedProject, byokRpc } from './byok-rpc-fixture';
import { randomUUID,randomBytes } from 'node:crypto';
import { createConnectorRuntime } from '../runtime';
import { listUsableConnectors,resolveConnectorAction,loadConnectorCredential } from '../access';
import { connectorFixture,providerFixture,accountFixture,toolFixture,toolkitFixture,jsonResponse } from './composio-fixtures';
import publishedSchema from './fixtures/supabase-report-20261116_00.json';
import type { AuthorizedConnector,ConnectorContext } from '../types';
import { failureForAgent } from '../agent-recovery';

const mockRpc=jest.fn(), mockProofRpc=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(name:string,...a:unknown[])=>name===byokRpc?mockProofRpc(name,...a):mockRpc(name,...a)},getSupabaseServiceRoleUrl:()=>process.env.SUPABASE_URL}));
jest.mock('../access',()=>({listUsableConnectors:jest.fn(),resolveConnectorAction:jest.fn(),loadConnectorCredential:jest.fn()}));
jest.mock('@/app/api/agents/tools/router/screen-access',()=>({...jest.requireActual('@/app/api/agents/tools/router/screen-access'),loadToolScreenAccess:async()=>({isAdmin:true,blockedScreens:[]})}));
const original={SUPABASE_URL:process.env.SUPABASE_URL, CONNECTORS_WEB_ORIGIN:process.env.CONNECTORS_WEB_ORIGIN};
afterEach(()=>{jest.restoreAllMocks();jest.clearAllMocks();for(const [k,v] of Object.entries(original)) { if(v===undefined)delete process.env[k];else process.env[k]=v; }});
function setup(allowed=true) {
  const ref='a'.repeat(20), site=randomUUID(), user=randomUUID(), agent=randomUUID(), id=randomUUID(), key=randomBytes(32).toString('hex'),revision=randomBytes(32).toString('hex');
  process.env.SUPABASE_URL=`https://${ref}.supabase.co`;process.env.CONNECTORS_WEB_ORIGIN='https://app.example.test';
  const ctx: ConnectorContext={siteId:site,userId:user,agentId:agent,instanceId:randomUUID(),host:'assistant',catalogUserSession:true,connectorIdHint:id};
  const provider={...providerFixture(),site_id:site,provider_user_id:site,credential_revision:revision};
  const bound:AuthorizedConnector={localProjectRef:ref,connector:{...connectorFixture(),id,site_id:site,toolkit_slug:'supabase',supabase_project_ref:ref,granted_scopes:[]},provider,
    policy:{revision:3,catalog_reads:true,tool_access_mode:'all',allowed_hosts:['assistant'],allowed_tools:[],require_approval:false}};
  mockProofRpc.mockImplementation(attestedProject(provider));
  jest.mocked(listUsableConnectors).mockResolvedValue([bound]);jest.mocked(resolveConnectorAction).mockResolvedValue(bound);
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:key,revision,source:'byok'});
  const slug='SUPABASE_RUN_READ_ONLY_QUERY'; const tool={...toolFixture(),...publishedSchema,slug,toolkit:{slug:'supabase'},version:'20261116_00',scopes:['database_read'],tags:['important','readOnlyHint','openWorldHint','Database']};
  const account={...accountFixture(),toolkit:tool.toolkit,user_id:site,state:{authScheme:'API_KEY',val:{full:'https://api.supabase.com'}}};
  const receipt=randomUUID(), uid=randomUUID();let grant=uid, dispatches=0, responseMarkerValid=true, lastScope:unknown;
  const stores:Record<string,unknown>[]=[]; const bodies:Record<string,unknown>[]=[];
  mockRpc.mockImplementation((name:string,params:Record<string,unknown>)=>({abortSignal:async()=>{
    if(name==='connector_analytics_result_ready') {lastScope=params.p_data_scope;return {data:{allowed,grant_id:allowed && lastScope==='platform'?grant:null},error:null};}
    if(name==='store_connector_analytics_result') {stores.push(params);return {data:receipt,error:null};}
    throw new Error('Unexpected storage operation');
  }}));
  let onPost=()=>{};
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url,opts)=>{
    const path=new URL(String(url)).pathname;
    if(path===`/api/v3.1/tools/${slug}`)return jsonResponse(tool);
    if(path==='/api/v3.1/toolkits/supabase')return jsonResponse({...toolkitFixture(),slug:'supabase',enabled:true});
    if(path===`/api/v3.1/connected_accounts/${account.id}`)return jsonResponse(account);
    if(path===`/api/v3.1/tools/execute/${slug}` && opts?.method==='POST'){
      dispatches++;const body=JSON.parse(String(opts.body));bodies.push(body);onPost();
      return jsonResponse({successful:true,error:null,data:{result:[{analytics_scope:responseMarkerValid?body.arguments.parameters.at(-1):'wrong',analytics_rows:[{currency:'USD',accounts:lastScope==='platform'?'2':'1',total:'9007199254740993.01'}]}],rows_returned:1}});
    }
    throw new Error('Unexpected upstream operation');
  });
  const runtime=createConnectorRuntime(async()=>ctx), name=`connector:${id}:${slug}`;
  const query='SELECT currency, COUNT(DISTINCT site_id) AS accounts, SUM(amount) AS total FROM analytics.paid_sales WHERE sale_date < $1 GROUP BY currency ORDER BY total DESC LIMIT 5';
  return {runtime,name,site,query,ref,key,stores,bodies,receipt,uid,bound,dispatches:()=>dispatches,rotate:()=>{onPost=()=>{grant=randomUUID();};},tamper:()=>{responseMarkerValid=false;},
    async call(args:Record<string,unknown>){const d=await runtime.describe(name);return runtime.call(name,{version:d.version,schema_hash:d.schema_hash,arguments:args});}};
}

it.each(['workspace','platform'] as const)('runs the requested %s SELECT, not the published-view listing, with fresh proof and receipt-only delivery',async scope=>{
  const f=setup();const d=await f.runtime.describe(f.name);expect(d.description).toContain('directly');expect(JSON.stringify(d.parameters)).toContain('paid_sales');
  const result=await f.call({query:f.query,parameters:['2026-10-01'],...(scope==='platform'?{scope}:{})});
  expect(result).toMatchObject({receipt:{status:'private_result_ready',url:`/connectors/results/${f.receipt}`}});expect(f.dispatches()).toBe(1);
  const post=f.bodies[0] as {arguments:{ref:string,query:string,parameters:string[]}};expect(post.arguments.ref).toBe(f.ref);
  expect(post.arguments.query).toContain('sales');expect(post.arguments.query).not.toContain('2026-10-01');
  expect(post.arguments.parameters).toContain('2026-10-01');
  if(scope==='workspace')expect(post.arguments.parameters[0]).toBe(f.site);else expect(post.arguments.parameters).not.toContain(f.site);
  expect(f.stores).toHaveLength(1);expect(f.stores[0]).toMatchObject({p_data_scope:scope,p_project_ref:f.ref,p_source:'paid_sales',p_grant_id:scope==='platform'?f.uid:null,
    p_report:{columns:['currency','accounts','total'],rows:[['USD',scope==='platform'?'2':'1','9007199254740993.01']],note:expect.stringContaining('not a cash receipt date')}});
  expect(mockRpc.mock.calls.filter(([n])=>n==='connector_analytics_result_ready').length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(result)).not.toMatch(/9007199254740993|USD|paid_sales/i);expect(JSON.stringify([result,f.stores])).not.toContain(f.key);
});

it('does not request or dispatch SQL for an ungranted platform scope, and does not downgrade it to workspace',async()=>{
  const f=setup(false);const e=await f.call({query:f.query,scope:'platform',parameters:['2026-10-01']}).catch(v=>v);
  expect(e).toMatchObject({code:'ANALYTICS_SCOPE_DENIED',executed:false});expect(failureForAgent(e).recovery.action).toBe('ask_manager');
  expect(mockRpc.mock.calls.map(([n])=>n)).toEqual(['connector_analytics_result_ready']);expect(f.dispatches()).toBe(0);expect(f.stores).toEqual([]);
});

it('explains monthly SQL validation locally, then checks the original platform grant on a corrected request',async()=>{
  const f=setup(false);
  const query="SELECT date_trunc('month',sale_date) AS period,currency,COUNT(DISTINCT site_id) AS sites,COUNT(*) AS sales,SUM(amount) AS gross_amount FROM analytics.paid_sales WHERE sale_date >= '2026-01-01' AND sale_date < '2026-10-01' GROUP BY 1,2 ORDER BY 1,2 LIMIT 25";
  for (const [invalid, hint] of [
    [query.replace("'month'",`'${f.key}'`),"date_trunc('month', column)"],
    [query.replace('GROUP BY 1,2','GROUP BY 1,6'),'SELECT-list position'],
  ]) {
    const err=await f.call({scope:'platform',query:invalid}).catch(e=>e);
    expect(err).toMatchObject({code:'INVALID_TOOL_ARGUMENTS',executed:false});
    const result=failureForAgent(err);
    expect(result).toMatchObject({automatic_retry:false,recovery:{action:'fix_arguments',message:expect.stringContaining(hint)}});
    expect(JSON.stringify(result)).not.toContain(f.key);expect(result.error).not.toContain('gross_amount');
  }
  expect(mockRpc).not.toHaveBeenCalled();
  const denial=await f.call({scope:'platform',query}).catch(e=>e);
  expect(failureForAgent(denial)).toMatchObject({code:'ANALYTICS_SCOPE_DENIED',executed:false,recovery:{action:'ask_manager'}});
  expect(mockRpc.mock.calls.map(([n])=>n)).toEqual(['connector_analytics_result_ready']);
  expect(mockRpc.mock.calls[0][1]).toMatchObject({p_data_scope:'platform',p_source:'paid_sales'});
  expect(f.dispatches()).toBe(0);expect(f.stores).toHaveLength(0);
});

it('does not trust the connector ref, a matching URL, or an old description when a fresh admission has no project proof',async()=>{
  const f=setup();const d=await f.runtime.describe(f.name);
  const unresolved={...f.bound,localProjectRef:undefined};jest.mocked(resolveConnectorAction).mockResolvedValue(unresolved);
  const current=await f.runtime.describe(f.name);expect(current.description).toContain('could not verify the identity');
  expect(JSON.stringify(current.parameters)).not.toContain('paid_sales');
  await expect(f.runtime.call(f.name,{version:d.version,schema_hash:d.schema_hash,arguments:{query:f.query}})).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',executed:false});
  expect(f.dispatches()).toBe(0);
});

it('does not dispatch when the authorization database changes after preparing a valid query',async()=>{
  const f=setup();const d=await f.runtime.describe(f.name);
  jest.mocked(resolveConnectorAction).mockResolvedValueOnce(f.bound).mockResolvedValue({...f.bound,localProjectRef:undefined});
  await expect(f.runtime.call(f.name,{version:d.version,schema_hash:d.schema_hash,arguments:{query:f.query,parameters:['2026-10-01']}}))
    .rejects.toMatchObject({code:'ACCESS_CHANGED',executed:false});
  expect(f.dispatches()).toBe(0);expect(f.stores).toEqual([]);
});
it.each(['rotated grant','unverified response'])('withholds already-dispatched results after %s',async mode=>{
  const f=setup();if(mode==='rotated grant')f.rotate();else f.tamper();
  const e=await f.call({query:f.query,scope:'platform',parameters:['2026-10-01']}).catch(v=>v);
  expect(e).toMatchObject({code:mode==='rotated grant'?'ACCESS_CHANGED':'CONNECTOR_RESULT_UNSUPPORTED'});
  expect(e).not.toHaveProperty('executed'); expect(e).not.toHaveProperty('receipt');expect(f.dispatches()).toBe(1);expect(f.stores).toEqual([]);
});
it.each([{query:'UPDATE analytics.paid_sales SET amount=5'},{query:'SELECT count(*) FROM pg_catalog.pg_class'},
  {scope:'platform'}, {query:'SELECT count(*) FROM analytics.paid_sales',view:'weekly'}, {query:'SELECT count(*) FROM analytics.paid_sales',scope:'other'}])('rejects an unsupported request before dispatch',async args=>{
  const f=setup();await expect(f.call(args)).rejects.toMatchObject({executed:false});expect(f.dispatches()).toBe(0);expect(mockRpc).not.toHaveBeenCalled();
});

it.each(['no change','before dispatch','after dispatch'] as const)('loads only the exact external workspace facts and withholds a result on registry change: %s',async phase=>{
  const f=setup(); f.bound.localProjectRef='b'.repeat(20); f.bound.connector.revocation_dispatched=false;
  const query='SELECT currency, COUNT(DISTINCT site_id) AS accounts, SUM(amount) AS total FROM analytics.bookings GROUP BY currency';
  const mapping={siteId:f.site,projectRef:f.ref,sources:[{name:'bookings',schema:'makinari_facts_studio',table:'monthly',siteColumn:'tenant',
    columns:[{name:'currency',column:'ccy',type:'text',values:['USD']},{name:'amount',column:'gross',type:'numeric'}],money:{currency:'currency',measures:['amount']}}]};
  const original=mockRpc.getMockImplementation()!;let reads=0;
  mockRpc.mockImplementation((name,params)=>{
    if(name!=='connector_external_analytics_dataset')return original(name,params);
    expect(params).toEqual({p_site_id:f.site,p_project_ref:f.ref,p_connector_id:f.bound.connector.id,p_connector_revision:f.bound.connector.revision});
    return {abortSignal:async()=>{
      reads++;const removed=(phase==='before dispatch' && reads>=3)||(phase==='after dispatch' && f.dispatches()>0);
      return {data:removed?{siteId:f.site,projectRef:f.ref,missing:true}:mapping,error:null};
    }};
  });
  const d=await f.runtime.describe(f.name);expect(JSON.stringify(d.parameters)).toContain('bookings(');
  expect(JSON.stringify(d)).not.toMatch(/paid_sales|makinari_facts_studio|monthly/);
  const result=f.runtime.call(f.name,{version:d.version,schema_hash:d.schema_hash,arguments:{query}});
  if(phase==='no change'){
    await expect(result).resolves.toMatchObject({receipt:{status:'private_result_ready'}});expect(f.stores).toHaveLength(1);
    expect(f.bodies[0]).toMatchObject({arguments:{ref:f.ref,parameters:expect.arrayContaining([f.site])}});
  }else{
    await expect(result).rejects.toMatchObject({code:'ACCESS_CHANGED',...(phase==='before dispatch'&&{executed:false})});
    expect(f.dispatches()).toBe(phase==='after dispatch'?1:0);expect(f.stores).toHaveLength(0);
  }
});
