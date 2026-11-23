import companies from './fixtures/HUBSPOT_LIST_COMPANIES-20261116_01.json';
import calendars from './fixtures/GOOGLECALENDAR_LIST_CALENDARS-20261116_00.json';
import { createHash, randomUUID } from 'node:crypto';
import { describeDirectTool, executeDirectTool, type DirectEnvelope } from '../provider-direct-transport';
import { directActionNameSafe, directEffect } from '../provider-direct-guards';
import { ConnectorError } from '../types';
import { accountFixture, connectorFixture, jsonResponse, providerFixture, secret, toolFixture, toolkitFixture } from './composio-fixtures';
import { attestedProject, byokOrigin } from './byok-rpc-fixture';

const mockProof = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin:{rpc:(...args:unknown[])=>mockProof(...args)}}));
const http = jest.fn();
const originalFetch = global.fetch;
const originalOrigin = process.env.CONNECTORS_WEB_ORIGIN;
const noPost = () => expect(http.mock.calls.filter(([, options])=>options.method==='POST')).toHaveLength(0);
beforeEach(() => { http.mockReset(); global.fetch = http; process.env.CONNECTORS_WEB_ORIGIN = byokOrigin; });
afterEach(() => {
  global.fetch = originalFetch;
  if (originalOrigin === undefined) delete process.env.CONNECTORS_WEB_ORIGIN; else process.env.CONNECTORS_WEB_ORIGIN = originalOrigin;
});

function fixture(kit='planning', operation='SEARCH_DELIVERABLES') {
  const site = randomUUID(), revision = secret();
  const slug = `${kit.toUpperCase()}_${operation}`;
  const credential = {apiKey:secret(),revision};
  const connector = {...connectorFixture(),id:randomUUID(),site_id:site,toolkit_slug:kit,granted_scopes:[]};
  const provider = {...providerFixture(),id:connector.provider_id,site_id:site,provider_user_id:site,credential_revision:revision};
  const directProof = {attestationId:randomUUID(),directRevision:3,expiresAt:new Date(Date.now()+3600000).toISOString(),siteId:site,connectorId:connector.id,
    accountId:connector.provider_account_id,authConfigId:connector.auth_config_id,toolkitSlug:kit,projectId:provider.project_id,
    providerId:provider.id,credentialRevision:revision,resourceBoundary:`tenant-${randomUUID()}`};
  const target = {connector,provider,policy:{revision:4,require_approval:false,allowed_hosts:['assistant'],allowed_tools:[slug],tool_access_mode:'selected' as const},directProof};
  const toolkit = {...toolkitFixture(),slug:kit,enabled:true};
  const tool = {...toolFixture(),toolkit:{slug:kit},slug, description:'Find matching business records.', tags:['readOnlyHint'],
    scopes:['business.data'],scope_requirements:{any_of:[['additional.scope']]},
    input_parameters:{type:'object',properties:{query:{type:'string',maxLength:30,description:'Search phrase.',examples:['not public']},
      options:{type:'object',properties:{count:{type:'integer',maximum:20}}}},required:['query']},
    output_parameters:{type:'object',properties:{count:{type:'integer'}}}};
  const account = {...accountFixture(),toolkit:{slug:kit},user_id:site,state:{authScheme:'OAUTH2',val:{scope:'business.data another.read'}}};
  mockProof.mockImplementation(attestedProject({...provider}));
  const queue = (...values: unknown[]) => { for (const value of values) http.mockResolvedValueOnce(jsonResponse(value)); };
  const read = () => describeDirectTool(target,credential,slug);
  const describe = async () => { queue(tool,toolkit,account); const d=await read(); http.mockReset(); return d; };
  const call = (e:DirectEnvelope,before=async()=>{})=>executeDirectTool(target,credential,slug,e,before);
  return {slug,target,credential,tool,toolkit,account,queue,read,describe,call};
}

it.each([['cloudplanner','SEARCH_LEASES','API_KEY'],['maildesk','CREATE_DRAFT','OAUTH2'],['salesdesk','LIST_CUSTOMER_ACCOUNTS','OAUTH2'],['retail','GET_PRODUCT_CODE','API_KEY'],
  ['marketplace','GET_SETTINGS','OAUTH2'],['planner','LIST_WORKSPACES','API_KEY'],['retail','GET_SHIPPING_CONFIGURATION','OAUTH2'],
  ['directory','GET_ADMIN_ROLE','OAUTH2']])(
  'uses one pinned transport for new %s %s business actions with %s', async (kit,op,scheme) => {
    const f=fixture(kit,op); Object.assign(f.target.policy,{tool_access_mode:'all',allowed_tools:[]});
    f.account.state.authScheme=scheme; if (scheme==='API_KEY') Object.assign(f.account.state,{val:{}});
    const d=await f.describe();
    expect(d).toMatchObject({version:f.tool.version,effect:op.startsWith('CREATE')?'write':'read',schemaHash:expect.stringMatching(/^[a-f0-9]{64}$/),
      parameters:{additionalProperties:false,properties:{query:{type:'string',maxLength:30},options:{additionalProperties:false}}}});
    for (const s of [f.credential.apiKey,f.target.directProof.resourceBoundary,'Search phrase.','not public','additional.scope']) expect(JSON.stringify(d)).not.toContain(s);
    const pin = {version:d.version,schema_hash:d.schemaHash,arguments:{query:'overdue',options:{count:3}}};
    const hidden = secret(); f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{found:2},log_id:hidden,logs:[hidden]});
    const before=jest.fn(async()=>{expect(http).toHaveBeenCalledTimes(3);pin.arguments.options.count=99;
      f.target.provider.provider_user_id=randomUUID();f.credential.apiKey=secret();});
    const apiKey = f.credential.apiKey;
    await expect(f.call(pin,before)).resolves.toEqual({data:{found:2}});
    expect(before).toHaveBeenCalledTimes(1);
    const [url,init]=http.mock.calls[3];
    expect(url).toBe(`https://backend.composio.dev/api/v3.1/tools/execute/${f.slug}`);
    expect(init).toMatchObject({method:'POST',redirect:'error',cache:'no-store',credentials:'omit',headers:{'x-api-key':apiKey}});
    expect(JSON.parse(init.body)).toEqual({connected_account_id:f.account.id,user_id:f.account.user_id,version:d.version,arguments:{query:'overdue',options:{count:3}}});
    expect(http.mock.calls[0][0]).toMatch(new RegExp(`/tools/${f.slug}\\?version=${d.version}$`));
    expect(http).toHaveBeenCalledTimes(4);
  });

it.each(['selected','all'])('dispatches a delegated QUERY_ORDERS with structured filters under %s and rejects open query input',async mode=>{
  const f=fixture('shop','QUERY_ORDERS');Object.assign(f.target.connector,{supabase_project_ref:null});Object.assign(f.target.policy,{tool_access_mode:mode});
  Object.assign(f.target,{directProof:{...f.target.directProof,kind:'connected_account',authorizationId:randomUUID(),authScheme:'OAUTH2',boundProjectRef:null}});
  Object.assign(f.tool,{input_parameters:{type:'object',properties:{since:{type:'string',format:'date'}},required:['since']}});
  const d=await f.describe();f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{orders:[]}});
  const pin={version:d.version,schema_hash:d.schemaHash,arguments:{since:'2026-11-23'}};
  await expect(f.call(pin)).resolves.toEqual({data:{orders:[]}});
  const posts=http.mock.calls.filter(([,o])=>o.method==='POST');expect(posts).toHaveLength(1);
  expect(posts[0][0]).toMatch(/tools\/execute\/SHOP_QUERY_ORDERS$/);expect(JSON.parse(posts[0][1].body)).toMatchObject({connected_account_id:f.account.id,arguments:pin.arguments});
  http.mockReset();f.queue({...f.tool,input_parameters:{type:'object',properties:{query:{type:'string'}}}});
  await expect(f.call(pin)).rejects.toMatchObject({code:'SCHEMA_UNSUPPORTED',executed:false});noPost();
});

it('treats flat/structured permissions, including missing/extra OAuth grants, as provider-owned (never grants or blockers)', async()=>{
  const f=fixture();Object.assign(f.tool,{scopes:undefined});Object.assign(f.account.state,{val:{}});
  const d=await f.describe(); f.queue(f.tool,f.toolkit,f.account,{successful:false,error:secret(),data:{status_code:403}});
  const err=await f.call({version:d.version,schema_hash:d.schemaHash,arguments:{query:'items'}}).catch(e=>e);
  expect(err).toMatchObject({code:'APP_RESOURCE_DENIED'});expect(err.effectStarted).not.toBe(false);expect(http).toHaveBeenCalledTimes(4);
});

it.each(['latest','canary','stable','v1','20261119_00\n'])('never accepts a floating/ambiguous release: %j',async version=>{
  const f=fixture();f.queue({...f.tool,version});await expect(f.read()).rejects.toBeInstanceOf(ConnectorError);noPost();
  http.mockReset();await expect(describeDirectTool(f.target,f.credential,f.slug,version)).rejects.toBeInstanceOf(ConnectorError);expect(http).not.toHaveBeenCalled();
});

it.each(['createHint','updateHint','destructiveHint'])('never labels a recognized %s readOnlyHint operation as read',tag=>{
  expect(directEffect(['readOnlyHint',tag],'test','TEST_GET_RECORDS')).toBe('write');
  expect(directEffect(['readOnlyHint','newBehaviorHint'],'test','TEST_GET_RECORDS')).toBe('unknown');
  expect(directEffect(['idempotentHint'],'test','TEST_GET_RECORDS')).toBe('unknown');
});

it.each(['RUN_READ_ONLY_QUERY','EXECUTE_SQL','RUN_CODE','PORT_SCAN','HTTP_GET','TRACEROUTE','RAW_API_REQUEST','UPLOAD_FILE','GET_CREDENTIALS','SET_WEBHOOK','UPDATE_PERMISSIONS'])('rejects non-business operation %s without fetching provider metadata', async op=>{
  const f=fixture('drivecloud',op);await expect(f.read()).rejects.toMatchObject({code:'TOOL_UNREVIEWED'});expect(http).not.toHaveBeenCalled();
  expect(directActionNameSafe('another',f.slug)).toBe(false);
});

it.each(['tool','toolkit','version','deprecated','no_auth','custom','mcp','disabled_toolkit','account','owner','auth_config','inactive','shared','private_missing','scheme'])('denies mismatched live identity/capability: %s',async kind=>{
  const f=fixture(); const d=await f.describe();
  if(kind==='tool')f.tool.slug+='_OTHER';if(kind==='toolkit')f.tool.toolkit.slug='other';if(kind==='version')f.tool.version='20261125_04';
  if(kind==='deprecated')Object.assign(f.tool,{deprecated:{is_deprecated:true}});if(kind==='no_auth')f.tool.no_auth=true;
  if(kind==='custom')f.toolkit.type='custom';if(kind==='mcp')f.toolkit.toolkit_type='mcp';if(kind==='disabled_toolkit')f.toolkit.enabled=false;
  if(kind==='account')f.account.id+='_other';if(kind==='owner')f.account.user_id=randomUUID();if(kind==='auth_config')f.account.auth_config.id+='_other';
  if(kind==='inactive')f.account.status='EXPIRED';if(kind==='shared')f.account.experimental.account_type='SHARED';if(kind==='private_missing')Object.assign(f.account,{experimental:undefined});
  if(kind==='scheme')f.account.state.authScheme='NONE';
  f.queue(f.tool,f.toolkit,f.account); const before=jest.fn();
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{query:'books'}},before)).rejects.toMatchObject({executed:false,effectStarted:false});
  expect(before).not.toHaveBeenCalled();noPost();
});

it.each([['supabase','ref'],['businessdata','ref'],['supabase','project_ref'],['businessdata','project_ref']])('uses a private API key on the attested external project for %s with the provider field %s',async (kit,field)=>{
  const f=fixture(kit,'LIST_TABLES'), ref='b'.repeat(20);
  f.target.directProof.resourceBoundary=ref;
  Object.assign(f.target.connector,{supabase_project_ref:ref});Object.assign(f.target,{localProjectRef:'a'.repeat(20)});
  Object.assign(f.tool,{input_parameters:{type:'object',properties:{[field]:{type:'string'}},required:[field]}});
  Object.assign(f.account.state,{authScheme:'API_KEY',val:kit==='supabase'?{full:'https://api.supabase.com'}:{}});
  const d=await f.describe();expect(d.parameters.properties).toEqual({});
  const pin={version:d.version,schema_hash:d.schemaHash,arguments:{}};
  f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{count:1}});
  await expect(f.call(pin)).resolves.toEqual({data:{count:1}});
  expect(JSON.parse(http.mock.calls[3][1].body)).toMatchObject({connected_account_id:f.account.id,arguments:{[field]:ref}});
  http.mockReset();f.queue(f.tool,f.toolkit,f.account);
  await expect(f.call({...pin,arguments:{[field]:'c'.repeat(20)}})).rejects.toMatchObject({executed:false});noPost();
  http.mockReset();Object.assign(f.target,{localProjectRef:ref});
  await expect(f.call(pin)).rejects.toMatchObject({code:'CONNECTOR_NOT_READY',executed:false});expect(http).not.toHaveBeenCalled();
});

it.each(['attestation','direct_revision','policy_revision','account_revision','new_account','resource','schema','default','effect','output','key','scheme'])('prevents replay after %s changes',async kind=>{
  const f=fixture(), d=await f.describe();
  if(kind==='attestation')f.target.directProof.attestationId=randomUUID();if(kind==='policy_revision')f.target.policy.revision++;
  if(kind==='direct_revision')f.target.directProof.directRevision++;
  if(kind==='account_revision')f.target.connector.revision++;if(kind==='resource')f.target.directProof.resourceBoundary+='-new';
  if(kind==='new_account')f.target.connector.provider_account_id=f.target.directProof.accountId=f.account.id=randomUUID();
  if(kind==='schema')f.tool.input_parameters.properties.query.maxLength=25;if(kind==='default')Object.assign(f.tool.input_parameters.properties.options.properties.count,{default:12});
  if(kind==='effect')f.tool.tags.push('updateHint');if(kind==='output')f.tool.output_parameters.properties.count.type='string';
  if(kind==='key')f.credential.apiKey=secret();if(kind==='scheme')f.account.state.authScheme='API_KEY';
  f.queue(f.tool,f.toolkit,f.account);const before=jest.fn();await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{query:'books'}},before))
    .rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',effectStarted:false});expect(before).not.toHaveBeenCalled();noPost();
});

it.each(['request_only','legacy','selected','host','proof','expired','provider_project','credential_revision','known_local','project_evidence','binding','revoking'])('denies stale/absent authority before sending any project credential: %s',async kind=>{
  const f=fixture(); const d=await f.describe();
  if(kind==='request_only')Object.assign(f.target,{requestOnly:true});
  if(kind==='legacy')Object.assign(f.target,{directProof:undefined});
  if(kind==='selected')f.target.policy.allowed_tools=[];if(kind==='host')f.target.policy.allowed_hosts=['direct'];
  if(kind==='proof')f.target.directProof.authConfigId=randomUUID();if(kind==='expired')f.target.directProof.expiresAt=new Date(0).toISOString();
  if(kind==='provider_project')f.target.provider.project_id+='-other';if(kind==='credential_revision')f.credential.revision=secret();
  if(kind==='known_local' || kind==='project_evidence') {
    const project='c'.repeat(20);Object.assign(f.target.connector,{supabase_project_ref:project});f.target.directProof.resourceBoundary=project;
    if(kind==='known_local')Object.assign(f.target,{localProjectRef:project});
  }
  if(kind==='binding')mockProof.mockImplementation(attestedProject({...f.target.provider,project_id:'other'}));
  if(kind==='revoking')f.target.connector.revocation_pending=true;
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{query:'books'}})).rejects.toMatchObject({effectStarted:false});
  expect(http).not.toHaveBeenCalled();
});

it('has one required reauthorization boundary immediately before dispatch; denial never posts',async()=>{
  const f=fixture(), d=await f.describe();f.queue(f.tool,f.toolkit,f.account);
  const recheck=jest.fn(async()=>{expect(http).toHaveBeenCalledTimes(3);throw new ConnectorError('ACCESS_CHANGED','Actor can no longer use this account.',403);});
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{query:'books'}},recheck)).rejects.toMatchObject({code:'ACCESS_CHANGED',executed:false});noPost();
});

it.each(['network','malformed','missing_data','failed','upstream'])('never retries or labels an unconfirmed POST not dispatched (%s)',async kind=>{
  const f=fixture(),d=await f.describe();const marker=secret();f.queue(f.tool,f.toolkit,f.account);
  if(kind==='network')http.mockRejectedValueOnce(new Error(marker));
  if(kind==='malformed')http.mockResolvedValueOnce(new Response(marker));
  if(kind==='missing_data')f.queue({successful:true,error:null});
  if(kind==='failed')f.queue({successful:false,error:marker,data:{detail:marker}});
  if(kind==='upstream')http.mockResolvedValueOnce(jsonResponse({error:marker},503));
  const error=await f.call({version:d.version,schema_hash:d.schemaHash,arguments:{query:'books'}}).catch(e=>e);
  expect(error).toMatchObject({code:'CONNECTOR_OUTCOME_UNKNOWN'});expect(error.executed).not.toBe(false);expect(error.effectStarted).not.toBe(false);
  expect(http).toHaveBeenCalledTimes(4);expect(String(error)).not.toContain(marker);expect(JSON.stringify(error)).not.toContain(marker);
});

it('confirms a missing owner using only a provider-filtered exact-account proof, never adopts a different account',async()=>{
  const f=fixture();Object.assign(f.account,{user_id:undefined});f.queue(f.tool,f.toolkit,f.account,{items:[f.account],next_cursor:null});await f.read();
  expect(http.mock.calls[3][0]).toMatch(new RegExp(`/connected_accounts\\?user_ids=${f.target.provider.provider_user_id}&connected_account_ids=${f.account.id}&limit=1$`));
  http.mockReset();f.queue(f.tool,f.toolkit,f.account,{items:[{...f.account,id:'another'}],next_cursor:null});
  await expect(f.read()).rejects.toMatchObject({code:'CONNECTOR_ACCOUNT_MISMATCH'});noPost();
});

it('accepts the platform transport project key only with its proven project and exact fingerprint',async()=>{
  const oldKey=process.env.COMPOSIO_API_KEY,oldProject=process.env.COMPOSIO_PROJECT_ID;
  try {
    const f=fixture();process.env.COMPOSIO_API_KEY=f.credential.apiKey;process.env.COMPOSIO_PROJECT_ID=f.target.provider.project_id;
    f.target.provider.credential_revision=f.target.directProof.credentialRevision=f.credential.revision=
      `platform:${createHash('sha256').update(f.credential.apiKey).digest('hex')}`;
    await f.describe();f.credential.apiKey=secret();await expect(f.read()).rejects.toMatchObject({code:'CONNECTOR_NOT_READY'});expect(http).not.toHaveBeenCalled();
  } finally {
    if(oldKey===undefined)delete process.env.COMPOSIO_API_KEY;else process.env.COMPOSIO_API_KEY=oldKey;
    if(oldProject===undefined)delete process.env.COMPOSIO_PROJECT_ID;else process.env.COMPOSIO_PROJECT_ID=oldProject;
  }
});

it('hides selectors, validates exact server bindings and accepts ordinary text/search in an isolated account',async()=>{
  const f=fixture('outlookdesk','CREATE_DRAFT');const project='b'.repeat(20);Object.assign(f.target,{localProjectRef:'a'.repeat(20)});
  Object.assign(f.target.connector,{supabase_project_ref:project});f.target.directProof.resourceBoundary=project;
  Object.assign(f.tool,{input_parameters:{type:'object',properties:{user_id:{type:'string',default:'me'},project_ref:{type:'string',pattern:'^[a-z]{20}$'},
    customAuthParams:{type:'object'},attachmentUrl:{type:'string'},text:{type:'string'}},required:['user_id','text','project_ref']}});
  const d=await f.describe();expect(d.parameters).toMatchObject({properties:{text:{type:'string'}},required:['text']});expect(Object.keys(d.parameters.properties as object)).toEqual(['text']);
  for (const bad of [{user_id:'foreign'},{project_ref:project},{attachmentUrl:'foreign'},{customAuthParams:{}},{text:'https://external.invalid'}]) {
    http.mockReset();f.queue(f.tool,f.toolkit,f.account);await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{text:'ok',...bad}})).rejects.toMatchObject({effectStarted:false});noPost();
  }
  http.mockReset();f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{draft_id:'123'}});
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{text:'Schedule next week'}})).resolves.toEqual({data:{draft_id:'123'}});
  expect(JSON.parse(http.mock.calls[3][1].body).arguments).toEqual({text:'Schedule next week',user_id:'me',project_ref:project});
});

const published = [
  {kit:'hubspot',op:'LIST_COMPANIES',schema:companies,version:'20261116_01', args:{limit:8,properties:['name'],after:'cursor'}},
  {kit:'googlecalendar',op:'LIST_CALENDARS',schema:calendars,version:'20261116_00',args:{page_token:'cursor',max_results:6}},
];

it.each(['calendar','orderdesk'])('dispatches the declared date and record ID on the selected %s account without treating schema annotations as grants', async kit=>{
  const f=fixture(kit,'LIST_RECORDS');
  const privateLabel=secret();
  Object.assign(f.tool,{tags:{providerLabel:privateLabel},input_parameters:{type:'object',definitions:{
    Day:{type:'string',format:'date'},
  },properties:{day:{$ref:'#/definitions/Day'},record_id:{type:'string',format:'uuid',title:{en:privateLabel}}},required:['day','record_id']}});
  const d=await f.describe(), args={day:'2026-09-30',record_id:randomUUID()};
  expect(d.effect).toBe('unknown');expect(JSON.stringify(d)).not.toContain(privateLabel);
  const before=jest.fn(async()=>{});
  for (const bad of [{...args,day:'2026-02-30'},{...args,record_id:'not-a-uuid'}]) {
    f.queue(f.tool,f.toolkit,f.account);
    await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:bad},before)).rejects.toMatchObject({executed:false});
    noPost();http.mockReset();
  }
  expect(before).not.toHaveBeenCalled();
  f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{count:1}});
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:args},before)).resolves.toEqual({data:{count:1}});
  expect(before).toHaveBeenCalledTimes(1);
  expect(JSON.parse(http.mock.calls[3][1].body)).toMatchObject({connected_account_id:f.account.id,arguments:args});
});

it('executes an explicitly closed zero-argument tool without requiring a redundant properties object',async()=>{
  const f=fixture('ledger','LIST_CURRENCIES');Object.assign(f.tool,{input_parameters:{type:'object',additionalProperties:false}});
  const d=await f.describe();expect(d.parameters.properties).toEqual({});
  f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{count:0}});
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{}})).resolves.toEqual({data:{count:0}});
});
it.each(published)('passes the committed $kit schema (including annotations and output refs), without a special adapter',async sample=>{
  const f=fixture(sample.kit,sample.op);Object.assign(f.tool,sample.schema,{version:sample.version,description:'List provider records. Optional URLs, headers and response links are documented.'});
  f.target.policy.require_approval=true; // Missing-use review setting: this is already a fully authorized account.
  const d=await f.describe(); const args:Record<string,unknown>=JSON.parse(JSON.stringify(sample.args));
  f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{items:[{name:'example'}]}});
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:args})).resolves.toEqual({data:{items:[{name:'example'}]}});
  expect(JSON.parse(http.mock.calls[3][1].body).arguments).toEqual(sample.args);
});

it('never publishes a private binding repeated in a provider enum, even with an innocuous field name', async()=>{
  const f=fixture(); const marker=secret().slice(0,32);f.target.directProof.resourceBoundary=marker;
  Object.assign(f.tool.input_parameters.properties,{filter:{type:'string',enum:[marker]}});
  f.queue(f.tool,f.toolkit,f.account);
  const err=await f.read().catch(e=>e);expect(err).toMatchObject({code:'TOOL_UNREVIEWED'});
  expect(String(err)).not.toContain(marker);expect(JSON.stringify(err)).not.toContain(marker);noPost();
});

it.each([['drive','LIST_FILES','folder_id'],['drive','LIST_FOLDERS','parent_folder_id'],['tracker','LIST_PROJECTS','board_id'],
  ['planner','GET_PROJECT','id']])('uses stored business IDs with %s %s (no paths, URLs, or alternate authorities)',async (kit,op,field)=>{
  const f=fixture(kit,op);Object.assign(f.tool,{input_parameters:{type:'object',properties:{[field]:{type:'string'},filePath:{type:'string'}},required:[field]}});
  const d=await f.describe(), args={[field]:'object-7'};expect(Object.keys(d.parameters.properties as object)).toEqual([field]);
  f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{count:2}});
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:args})).resolves.toEqual({data:{count:2}});
  http.mockReset();f.queue(f.tool,f.toolkit,f.account);
  await expect(f.call({version:d.version,schema_hash:d.schemaHash,arguments:{[field]:'https://example.invalid/item'}})).rejects.toMatchObject({effectStarted:false});noPost();
});
it.each(['DOWNLOAD_FROM_URL','GET_FILE_CONTENT','LIST_FILES_AND_DOWNLOAD','UPLOAD_FILE','MOVE_FILE_BY_PATH'])('still denies file capabilities %s',op=>{
  expect(directActionNameSafe('drive',`DRIVE_${op}`)).toBe(false);
});
it('never enumerates or selects a different project under a database-scoped binding',async()=>{
  const f=fixture('businessdata','LIST_PROJECTS'), ref='c'.repeat(20);
  f.target.directProof.resourceBoundary=ref;Object.assign(f.target.connector,{supabase_project_ref:ref});Object.assign(f.target,{localProjectRef:'d'.repeat(20)});
  f.queue(f.tool);await expect(f.read()).rejects.toMatchObject({code:'TOOL_UNREVIEWED'});noPost();
});

// The v3.1 tool detail includes display text, pricing/Instant metadata and a list of
// available releases. None selects the account or changes this exact pinned action.
it('keeps a pin across display/advertisement edits, including schema-node annotations', async () => {
  const f = fixture(), d = await f.describe(), marker = secret();
  Object.assign(f.tool, {name:null, description:null, available_versions:[f.tool.version, '20261125_04'],
    instant:{price:{description:marker}}});
  Object.assign(f.tool.input_parameters.properties.query, {title:null, description:marker, examples:[marker]});
  Object.assign(f.tool.output_parameters.properties.count, {human_parameter_name:marker});
  f.tool.tags.push('Business');
  const after = await f.describe();
  expect(after).toEqual(d);
  expect(JSON.stringify(after)).not.toContain(marker);
  f.queue(f.tool, f.toolkit, f.account, {successful:true,error:null,data:{count:1}});
  await f.call({version:d.version,schema_hash:d.schemaHash,arguments:{query:'invoices'}});
  expect(JSON.parse(http.mock.calls[3][1].body)).toEqual({version:d.version,connected_account_id:f.account.id,
    user_id:f.account.user_id,arguments:{query:'invoices'}});
});

it.each(['display copy', 'reported requirements', 'reported grants'])('does not stale the descriptor just for changed %s', async kind => {
  const f = fixture(), d = await f.describe();
  if (kind === 'display copy') f.tool.description = 'Updated catalogue copy.';
  if (kind === 'reported requirements') f.tool.scope_requirements.any_of = [['different']];
  if (kind === 'reported grants') f.account.state.val.scope += ' another.permission';
  expect(await f.describe()).toEqual(d);
});

it('does not use reported tool requirements or optional grant lists as a dispatch permission', async () => {
  const f = fixture(), d = await f.describe(), marker = secret();
  // No known list of grants and no locally interpretable requirements. Only the app can decide.
  Object.assign(f.account.state, {val:{scope:{provider_defined:marker}}});
  Object.assign(f.tool, {description:undefined, scopes:{label:marker}, scope_requirements:[{provider_defined:marker}]});
  expect(await f.describe()).toEqual(d);
  f.queue(f.tool, f.toolkit, f.account, {successful:false,error:marker,data:{status_code:403}});
  const before = jest.fn(async () => {});
  const pin = {version:d.version,schema_hash:d.schemaHash,arguments:{query:'invoices'}};
  const denied = await f.call(pin, before).catch(e => e);
  expect(denied).toMatchObject({code:'APP_RESOURCE_DENIED'});
  expect(JSON.stringify(denied)).not.toContain(marker);
  expect(before).toHaveBeenCalledTimes(1);
  expect(http).toHaveBeenCalledTimes(4);
  http.mockReset();
  f.account.state.val.scope = '*';
  f.target.policy.allowed_tools = [];
  await expect(f.call(pin, before)).rejects.toMatchObject({code:'CONNECTOR_TOOL_DENIED',effectStarted:false});
  expect(http).not.toHaveBeenCalled();
  expect(before).toHaveBeenCalledTimes(1);
});

it('does not mistake literal field names or default-object keys for presentation annotations', async () => {
  const f = fixture();
  const outputField = {type:'string'};
  Object.assign(f.tool.output_parameters.properties, {description:outputField});
  const defaults = {description:'weekday'};
  Object.assign(f.tool.input_parameters.properties, {filter:{type:'object',properties:{description:{type:'string'}},default:defaults}});
  const d = await f.describe();
  const pin = {version:d.version,schema_hash:d.schemaHash,arguments:{query:'new'}};
  outputField.type = 'integer'; f.queue(f.tool, f.toolkit, f.account);
  await expect(f.call(pin)).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',effectStarted:false}); noPost();
  http.mockReset(); outputField.type = 'string'; defaults.description = 'weekend'; f.queue(f.tool, f.toolkit, f.account);
  await expect(f.call(pin)).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',effectStarted:false}); noPost();
});

it('describes Stripe promotion-code retrieval by stored ID, not executable code', async () => {
  // https://docs.composio.dev/toolkits/stripe#retrieve-promotion-code (20261116_00).
  const f = fixture('stripe','RETRIEVE_PROMOTION_CODE');
  Object.assign(f.tool, {version:'20261116_00',input_parameters:{type:'object',required:['promotion_code_id'],
    properties:{promotion_code_id:{type:'string'}}}});
  const d = await f.describe();
  const pin = {version:d.version,schema_hash:d.schemaHash,arguments:{promotion_code_id:'promo_sample'}};
  f.queue(f.tool, f.toolkit, f.account, {successful:true,error:null,data:{active:true}});
  await expect(f.call(pin)).resolves.toEqual({data:{active:true}});
  expect(JSON.parse(http.mock.calls[3][1].body).arguments).toEqual(pin.arguments);
  for (const op of ['RETRIEVE_CODE','RUN_CODE','RETRIEVE_PROMOTION_CODE_AND_RUN_SCRIPT']) {
    expect(directActionNameSafe('stripe', `STRIPE_${op}`)).toBe(false);
  }
  expect(directActionNameSafe('other', 'OTHER_RETRIEVE_PROMOTION_CODE')).toBe(true);
  expect(directActionNameSafe('other','OTHER_EXECUTE_PROMOTION_CODE_SCRIPT')).toBe(false);
  http.mockReset();
  f.queue(f.tool, f.toolkit, f.account);
  await expect(f.call({...pin,arguments:{...pin.arguments,code:'not an ID'}})).rejects.toMatchObject({effectStarted:false});
  noPost();
});

it('dispatches LIST_TABLES once with the delegated external project and account, not a caller-supplied ref',async()=>{
  const f=fixture('supabase','LIST_TABLES'),project='b'.repeat(20);
  Object.assign(f.target,{localProjectRef:'a'.repeat(20),directProof:{...f.target.directProof,kind:'connected_account',
    authorizationId:randomUUID(),authScheme:'API_KEY',boundProjectRef:project}});
  Object.assign(f.target.policy,{tool_access_mode:'all',allowed_tools:[]});Object.assign(f.target.connector,{supabase_project_ref:project});
  Object.assign(f.account.state,{authScheme:'API_KEY',val:{full:'https://api.supabase.com'}});
  Object.assign(f.tool,{input_parameters:{type:'object',required:['project_ref'],properties:{project_ref:{type:'string',pattern:'^[a-z]+$'},
    schemas:{type:'array',items:{type:'string'}},include_metadata:{type:'boolean',default:true},include_views:{type:'boolean',default:true},
    include_system_schemas:{type:'boolean',default:false}}}});
  const d=await f.describe(),pin={version:d.version,schema_hash:d.schemaHash,arguments:{}};
  f.queue(f.tool,f.toolkit,f.account);await expect(f.call({...pin,arguments:{project_ref:'c'.repeat(20)}})).rejects.toMatchObject({executed:false});noPost();
  const data={tables:[{name:'orders'}]};f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data});
  await expect(f.call(pin)).resolves.toEqual({data});const posts=http.mock.calls.filter(([,o])=>o.method==='POST');expect(posts).toHaveLength(1);
  expect(posts[0][0]).toMatch(/\/tools\/execute\/SUPABASE_LIST_TABLES$/);expect(JSON.parse(posts[0][1].body)).toMatchObject({
    connected_account_id:f.target.connector.provider_account_id,arguments:{project_ref:project}});
});

it.each(['shared','external'])('injects the sole project ref for a delegated %s database metadata read and withholds other fields', async location=>{
  const f=fixture('supabase','GET_PROJECT'), project='b'.repeat(20);
  Object.assign(f.target,{localProjectRef:location==='shared'?project:'a'.repeat(20),directProof:{...f.target.directProof,
    kind:'connected_account',authorizationId:randomUUID(),authScheme:'API_KEY',boundProjectRef:project}});
  Object.assign(f.target.connector,{supabase_project_ref:project});
  const schema={type:'object',required:['ref'],properties:{ref:{type:'string'}}};
  Object.assign(f.tool,{input_parameters:schema});Object.assign(f.account.state,{authScheme:'API_KEY',val:{full:'https://api.supabase.com'}});
  const d=await f.describe(),pin={version:d.version,schema_hash:d.schemaHash,arguments:{}};
  expect(d.parameters.properties).toEqual({});
  f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{id:project,ref:project,status:'ACTIVE_HEALTHY',owner_email:'private',rows:[secret()]}});
  await expect(f.call(pin)).resolves.toEqual({data:{project_verified:true,status:'ACTIVE_HEALTHY'}});
  expect(JSON.parse(http.mock.calls[3][1].body).arguments).toEqual({ref:project});
  for (const patch of [{input_parameters:{type:'object',properties:{}}},{input_parameters:{...schema,required:[]}},
    {input_parameters:{...schema,properties:{...schema.properties,table:{type:'string'}}}},{tags:['readOnlyHint','updateHint']}]) {
    http.mockReset();f.queue({...f.tool,...patch},f.toolkit,f.account);await expect(f.call(pin)).rejects.toMatchObject({executed:false});noPost();
  }
  for (const state of [{authScheme:'OAUTH2',val:{}},{authScheme:'API_KEY',val:{full:'https://other.example.test'}}]) {
    http.mockReset();f.queue(f.tool,f.toolkit,{...f.account,state});await expect(f.call(pin)).rejects.toMatchObject({executed:false});noPost();
  }
  http.mockReset();f.queue(f.tool,f.toolkit,f.account);await expect(f.call({...pin,arguments:{ref:'c'.repeat(20)}})).rejects.toMatchObject({executed:false});noPost();
  http.mockReset();f.queue(f.tool,f.toolkit,f.account,{successful:true,error:null,data:{ref:'c'.repeat(20),id:project}});
  await expect(f.call(pin)).rejects.toBeInstanceOf(ConnectorError);
});

it('refuses an executable toolkit with an opaque operation name before fetching metadata',async()=>{
  const f=fixture('code_interpreter','RUN');await expect(f.read()).rejects.toMatchObject({code:'TOOL_UNREVIEWED'});expect(http).not.toHaveBeenCalled();
});
