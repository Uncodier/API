import { workflowDescriptorMarkers } from '../workflow-descriptor-markers';
jest.mock('../workflow-descriptor-markers', () => ({workflowDescriptorMarkers:jest.fn()}));
import { randomBytes, randomUUID } from 'node:crypto';
import { runWorkflowConnectorRead, type WorkflowConnectorReadBinding } from '../workflow-read';
import { describeWorkflowOperation } from '../workflow-read-descriptor';
import * as local from '../account-access';
import { readProviderBinding } from '../provider-project-binding';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { accountFixture, connectorFixture, jsonResponse, providerFixture, toolFixture, toolkitFixture } from './composio-fixtures';

jest.mock('../account-access', () => ({getVisibleConnector:jest.fn(),getConnectorProvider:jest.fn(),getConnectorPolicy:jest.fn(),
  getMemberGrant:jest.fn(),loadConnectorCredential:jest.fn(),requireConnectorSiteAccess:jest.fn()}));
jest.mock('../provider-project-binding', () => ({readProviderBinding:jest.fn()}));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({loadToolScreenAccess:jest.fn()}));

const scope='deliverables.read';
const http=jest.fn(), original=global.fetch;
let b:WorkflowConnectorReadBinding, claim:jest.Mock, key:string;
const row=()=>({...connectorFixture(),site_id:b.site_id,id:b.connector_id,provider_id:b.provider_id,revision:b.connector_revision,
  toolkit_slug:b.toolkit_slug,granted_scopes:[scope],revocation_dispatched:false,supabase_project_ref:null});
const provider=()=>({...providerFixture(),id:b.provider_id,site_id:b.site_id,provider_user_id:b.site_id,credential_revision:b.credential_revision});
const member=()=>({user_id:b.principal_id,can_view:true,can_use:true,expires_at:null});
const policy=()=>({allowed_hosts:['direct'],tool_access_mode:'selected' as const,allowed_tools:[b.tool_slug],require_approval:true});
const credential=()=>({apiKey:key,revision:b.credential_revision,source:'byok' as const});
const kit=()=>({...toolkitFixture(),slug:b.toolkit_slug});
const tool=()=>({...toolFixture(),slug:b.tool_slug,toolkit:{slug:b.toolkit_slug},tags:['Basic','readOnlyHint'],scopes:[scope],
  input_parameters:{type:'object',properties:{page_size:{type:'integer',maximum:12},query:{type:'string'}}},description:'Lists matching deliverables.'});
const account=()=>({...accountFixture(),user_id:b.site_id,toolkit:{slug:b.toolkit_slug},state:{authScheme:'OAUTH2',val:{scope}}});
function mockProvider(kitPatch={},toolPatch={},accountPatch={},result:unknown={successful:true,error:null,data:{name:'Blue item',secret:key,details:key,account:b.provider_account_id}}) {
  http.mockImplementation(async (url:string,init:{method:string})=>{
    const resource=new URL(url).pathname.replace('/api/v3.1','');
    if (resource===`/toolkits/${b.toolkit_slug}`) return jsonResponse({...kit(),...kitPatch});
    if (resource===`/tools/${b.tool_slug}`) return jsonResponse({...tool(),...toolPatch});
    if (resource==='/connected_accounts/ca_one') return jsonResponse({...account(),...accountPatch});
    if (resource===`/tools/execute/${b.tool_slug}` && init.method==='POST') return jsonResponse(result);
    throw new Error('Unexpected offline request');
  });
}
function configure(kitSlug='sketchpad',slug=kitSlug.toUpperCase()+'_LIST_DELIVERABLES') {
  b.toolkit_slug=kitSlug; b.tool_slug=slug;
  jest.mocked(local.getVisibleConnector).mockResolvedValue(row());
  jest.mocked(local.getConnectorPolicy).mockResolvedValue(policy());
  mockProvider();
}
const request=()=>({connector_id:b.connector_id,site_id:b.site_id,tool_slug:b.tool_slug,arguments:b.arguments});
const describe=()=>describeWorkflowOperation(b.principal_id,request());
const pin=async()=>{const d=await describe(); b.schema_hash=d.schema_hash; http.mockClear(); return d;};
const execute=()=>runWorkflowConnectorRead(b,claim);
const noPost=()=>expect(http.mock.calls.some(c=>c[1].method==='POST')).toBe(false);
beforeEach(()=>{
  jest.resetAllMocks(); jest.mocked(workflowDescriptorMarkers).mockResolvedValue(['hidden-boundary']); key=randomBytes(32).toString('hex'); global.fetch=http; claim=jest.fn(async()=>undefined);
  const site=randomUUID(); b={site_id:site,principal_id:randomUUID(),connector_id:randomUUID(),provider_id:randomUUID(),
    connector_revision:7,provider_project_id:'project_one',provider_user_id:site,provider_account_id:'ca_one',auth_config_id:'ac_one',
    credential_revision:randomBytes(32).toString('hex'),toolkit_slug:'',tool_slug:'',schema_hash:'0'.repeat(64),toolkit_version:'20261119_00',
    arguments:{page_size:3,query:'blue'}};
  configure(); jest.mocked(local.getConnectorProvider).mockResolvedValue(provider()); jest.mocked(local.getMemberGrant).mockResolvedValue(member());
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:[]});
  jest.mocked(local.loadConnectorCredential).mockResolvedValue(credential());
  jest.mocked(readProviderBinding).mockResolvedValue({projectId:b.provider_project_id,callbackUrl:''});
});
afterEach(()=>{global.fetch=original;});
it.each(['sketchpad','orbital-planner'])('pins the operation on %s and projects only safe fields into the private report',async name=>{
  configure(name,name.toUpperCase().replace('-','_')+'_LIST_DELIVERABLES');
  const d=await pin(); expect(d).toMatchObject({connector_id:b.connector_id,toolkit_slug:name,tool_slug:b.tool_slug,
    toolkit_version:b.toolkit_version,schema_hash:expect.stringMatching(/^[a-f0-9]{64}$/),input_schema:{additionalProperties:false,required:['page_size']}});
  claim.mockImplementation(async()=>{expect(http).toHaveBeenCalledTimes(3);noPost(); b.arguments.page_size=999; b.provider_account_id='ca_other';});
  const receipt=await execute();
  expect(receipt.executed).toBe(true); expect(receipt.report.rows).toEqual([['$.name','Blue item']]);
  expect(JSON.stringify(receipt)).not.toContain(key); expect(JSON.stringify(receipt)).not.toContain('ca_one');
  expect(http.mock.calls[1][0]).toMatch(/\?version=20261119_00$/); expect(http).toHaveBeenCalledTimes(4);
  expect(JSON.parse(http.mock.calls[3][1].body)).toEqual({connected_account_id:'ca_one',user_id:b.site_id,version:b.toolkit_version,arguments:{page_size:3,query:'blue'}});
  expect(claim).toHaveBeenCalledTimes(1);
});
it('accepts scope-less native PRIVATE API key only with a scope-less descriptor and stored grant inventory',async()=>{
  jest.mocked(local.getVisibleConnector).mockResolvedValue({...row(),granted_scopes:[]});
  mockProvider({},{scopes:[]},{state:{authScheme:'API_KEY',val:{}}}); await pin(); await expect(execute()).resolves.toMatchObject({executed:true,report:{rows:[['$.name','Blue item']]}});
});
it.each(['EXECUTE_CODE','RUN_SQL','CUSTOM_PROXY','GET_ADMIN_DATA','DELETE_STAGES','SEND_MESSAGES','FETCH_FILES','RAW_QUERY'])('rejects %s even if labelled read-only',async action=>{
  configure('sketchpad','SKETCHPAD_'+action);await expect(describe()).rejects.toThrow();noPost();
});
it.each([{version:'stable'},{toolkit:{slug:'foreign'}},{tags:[]},{tags:['readOnlyHint','createHint']},{tags:['readOnlyHint','otherHint']},
  {no_auth:true},{is_deprecated:true},{scope_requirements:{}},{scopes:[]},{scopes:['*']},{scopes:['deliverables.write']},
  {input_parameters:{type:'object',properties:{query:{type:'string'}}}},{input_parameters:{type:'object',additionalProperties:true,properties:{}}},
  {input_parameters:{type:'object',properties:{sql:{type:'string'},limit:{type:'integer'}}}},
  {input_parameters:{type:'object',properties:{page_size:{type:'integer'},flags:{type:'boolean',default:true}}}},
])('declines incompatible metadata %j',async patch=>{mockProvider({},patch);await expect(describe()).rejects.toThrow();noPost();});
it.each([{type:'custom'},{toolkit_type:'mcp'},{enabled:false},{slug:'foreign'}])('rejects toolkit %j',async patch=>{
  mockProvider(patch);await expect(describe()).rejects.toThrow();noPost();
});
it.each([{id:'ca_other'},{user_id:randomUUID()},{experimental:{account_type:'SHARED'}},{experimental:undefined},
  {auth_config:{id:'ac_other',is_disabled:false}},{status:'INACTIVE'},{state:{authScheme:'OAUTH2',val:{}}},
  {data:{base_url:'https://api.vendor.example.test'}},{state:{authScheme:'OAUTH2',val:{scope:[scope,'deliverables.write']}}}
])('rejects unverified live account %j',async patch=>{mockProvider({},{},patch);await expect(describe()).rejects.toThrow();noPost();});
it.each([{}, {page_size:'2'}, {page_size:13},{page_size:2,extra:1},{page_size:2,query:'https://other.example.test'},
  {page_size:2,query:'select id from people'}])('validates exact args at authoring and execution %j',async args=>{
  await pin(); b.arguments=args;await expect(describe()).rejects.toThrow();await expect(execute()).rejects.toThrow();noPost();expect(claim).not.toHaveBeenCalled();
});
it.each(['grant','expired','screen','manager','host','tool','tenant','revision','account','config','disabled','revoked','project','entity','credential','attestation'])('refuses stale %s before provider contact',async why=>{
  if (why==='grant') jest.mocked(local.getMemberGrant).mockResolvedValue(null);
  if (why==='expired') jest.mocked(local.getMemberGrant).mockResolvedValue({...member(),expires_at:new Date(0).toISOString()});
  if (why==='screen') jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:['connectors']});
  if (why==='manager') jest.mocked(local.requireConnectorSiteAccess).mockRejectedValue(new Error(key));
  if (why==='host' || why==='tool') jest.mocked(local.getConnectorPolicy).mockResolvedValue({...policy(),...(why==='host'?{allowed_hosts:['assistant']}:{allowed_tools:[]})});
  const patch:Record<string,object>={tenant:{site_id:randomUUID()},revision:{revision:1},account:{provider_account_id:'other'},config:{auth_config_id:'other'},disabled:{enabled:false},revoked:{revocation_pending:true}};
  jest.mocked(local.getVisibleConnector).mockResolvedValue({...row(),...patch[why]});
  if (why==='project'||why==='entity') jest.mocked(local.getConnectorProvider).mockResolvedValue({...provider(),...(why==='project'?{project_id:'other'}:{provider_user_id:randomUUID()})});
  if (why==='credential') jest.mocked(local.loadConnectorCredential).mockResolvedValue({...credential(),revision:'f'.repeat(64)});
  if (why==='attestation') jest.mocked(readProviderBinding).mockResolvedValue({projectId:'other',callbackUrl:''});
  await expect(execute()).rejects.toMatchObject({code:'WORKFLOW_READ_DENIED'});expect(claim).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();
});
it.each(['version','hash','schema','claim','claim-false','revoked','credential'])('rechecks %s before POST',async why=>{
  await pin(); if (why==='version') b.toolkit_version='20261118_00'; if (why==='hash') b.schema_hash='1'.repeat(64);
  if (why==='schema') mockProvider({},{input_parameters:{type:'object',properties:{page_size:{type:'integer'}}}});
  if (why==='claim') claim.mockRejectedValue(new Error(key));if (why==='claim-false') claim.mockResolvedValue(false);
  if (why==='revoked') jest.mocked(local.getMemberGrant).mockResolvedValueOnce(member()).mockResolvedValueOnce(null);
  if (why==='credential') jest.mocked(local.loadConnectorCredential).mockResolvedValueOnce(credential()).mockResolvedValueOnce({...credential(),apiKey:randomUUID()});
  await expect(execute()).rejects.toMatchObject({code:'WORKFLOW_READ_DENIED'});noPost();
});
it.each([{successful:false,error:'failed',data:{}},{successful:true,error:null}])('never retries an ambiguous response %j',async result=>{
  await pin();mockProvider({},{},{},result);await expect(execute()).rejects.toMatchObject({code:'WORKFLOW_READ_UNCONFIRMED'});
  expect(http).toHaveBeenCalledTimes(4);expect(claim).toHaveBeenCalledTimes(1);
});
it('rejects a missing final claim callback without contacting storage or the provider',async()=>{
  await expect(runWorkflowConnectorRead(b,undefined as never)).rejects.toMatchObject({code:'WORKFLOW_READ_DENIED'});
  expect(local.requireConnectorSiteAccess).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();
});
it('accepts bounded single-record descriptors with a provider-owned URL scope',async()=>{
  b.arguments={};const scoped='https://vendor.example.test/auth/stages.readonly';
  configure('looms','LOOMS_CURRENT_STAGE');jest.mocked(local.getVisibleConnector).mockResolvedValue({...row(),granted_scopes:[scoped]});
  mockProvider({},{scopes:[scoped],input_parameters:{type:'object',properties:{}},output_parameters:{type:'object',additionalProperties:false,
    properties:{stage:{type:'integer'}}}},{state:{authScheme:'OAUTH2',val:{scope:scoped}}},{successful:true,error:null,data:{stage:3}});
  await pin();await expect(execute()).resolves.toMatchObject({executed:true,report:{rows:[['$.stage','3']]}});
});
it('refuses collection options that bypass the reviewed row limit',async()=>{
  mockProvider({},{input_parameters:{type:'object',properties:{page_size:{type:'integer'},return_all:{type:'boolean'}}}});
  await expect(describe()).rejects.toThrow();noPost();
});

it.each(['account', 'credential', 'boundary'])('never exposes a reflected %s in a workflow descriptor', async source => {
  // Short permitted enum vocabulary and field names can still contain private binding values.
  const marker = source === 'account' ? b.provider_account_id : source === 'boundary' ? 'hidden-boundary' : randomBytes(12).toString('hex');
  if (source === 'credential') jest.mocked(local.loadConnectorCredential).mockResolvedValue({...credential(),apiKey:marker});
  const original = tool().input_parameters;
  mockProvider({}, {input_parameters:{...original,properties:{...original.properties,
    selection:{type:'string',enum:[marker]}}}});
  const error=await describe().then(() => null,e=>e);
  expect(error).toMatchObject({code:'WORKFLOW_READ_DENIED'});
  expect(String(error)).not.toContain(marker); noPost();
});
