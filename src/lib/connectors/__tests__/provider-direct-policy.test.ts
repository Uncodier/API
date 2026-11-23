import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { listDirectAccounts, authorizeDirectAction, authorizedProviderRow, verifyProviderAccounts } from '../provider-direct-policy';
import { ConnectorError, type ConnectorContext } from '../types';

const rpc = jest.fn(), access = jest.fn(), visible = jest.fn(), load = jest.fn(), binding = jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...args:unknown[])=>rpc(...args)}}));
jest.mock('../account-access',()=>({requireConnectorSiteAccess:(...args:unknown[])=>access(...args), getVisibleConnector:(...args:unknown[])=>visible(...args),
  loadConnectorCredential:(...args:unknown[])=>load(...args),connectorDatabaseError:()=>{throw new Error('DB error');}}));
jest.mock('../provider-project-binding',()=>({readTokenProviderBinding:(...args:unknown[])=>binding(...args)}));
const site=randomUUID(),user=randomUUID(),instance=randomUUID(),agent=randomUUID(),id=randomUUID(),provider=randomUUID(),attestation=randomUUID();
const attempt=randomUUID();
const credential=randomBytes(32).toString('hex'), rev=createHash('sha256').update(credential).digest('hex');
const ctx:ConnectorContext={host:'assistant',catalogUserSession:true,siteId:site,userId:user,instanceId:instance,agentId:agent};
const fresh=()=>({attestation_id:attestation,direct_revision:3,expires_at:new Date(Date.now()+60_000).toISOString(),resource_boundary:'external-tenant-01',local_installation_ref:null as string|null,
  connector:{id,site_id:site,provider_id:provider,provider_project_id:'p1',toolkit_slug:'crm',provider_account_id:'a1',auth_config_id:'ac1',display_name:'My CRM',supabase_project_ref:null as null|string,
    provider_status:'ACTIVE',enabled:true,access_mode:'workspace',revocation_pending:false,revocation_dispatched:false,granted_scopes:[],created_by:user,revision:4,verified_at:new Date().toISOString()},
  provider:{id:provider,site_id:site,provider:'composio',project_id:'p1',provider_user_id:site,credential_revision:rev,status:'active'},
  policy:{allowed_tools:[] as string[],allowed_hosts:['assistant'],revision:7,require_approval:true,tool_access_mode:'all'}});
const connected=()=>{const {connector,provider,policy,direct_revision}=fresh();return {
  connector,provider,policy,direct_revision,authority_kind:'verified_connection',connection_attempt_id:attempt,
};};
const reply = (data:unknown,error:unknown=null)=>({abortSignal:async()=>({data,error})});
const target = ()=>authorizeDirectAction(ctx,id,'CRM_LIST_DEALS');
const legacyTarget = async (row: unknown, local: string|null, action: string) => {
  const [target] = await verifyProviderAccounts(site,[authorizedProviderRow.parse(row)],local,id,action);
  return target;
};
beforeEach(()=>{jest.resetAllMocks(); rpc.mockImplementation(()=>reply([connected()]));load.mockResolvedValue({source:'byok',apiKey:credential,revision:rev});
  binding.mockResolvedValue({projectId:'p1'});visible.mockResolvedValue(fresh().connector);access.mockResolvedValue({can_view:true,can_manage:false});});

it('uses the completed connection and exact actor without delegation or attestation',async()=>{
  rpc.mockReturnValue(reply([{...connected(),connector:{...connected().connector,not_public:'ignored'}}])); const t=await target();
  expect(t.directProof).toMatchObject({kind:'verified_connection',connectionAttemptId:attempt,directRevision:3,accountId:'a1',authConfigId:'ac1',siteId:site,projectId:'p1',credentialRevision:rev});
  expect(rpc).toHaveBeenCalledWith('connector_ask_connections',{p_site_id:site,p_user_id:user,p_instance_id:instance,p_agent_id:agent,p_connector_id:id,p_slug:'CRM_LIST_DEALS'});
  expect(rpc).toHaveBeenCalledTimes(1);expect(visible).not.toHaveBeenCalled();expect(access).not.toHaveBeenCalled();
  expect(t.policy.tool_access_mode).toBe('all');expect(t).not.toHaveProperty('requestOnly');expect(JSON.stringify(t)).not.toContain(credential);
  expect(t.connector).not.toHaveProperty('not_public');
});
it('uses one site-scoped browse check, or an exact account visibility check even on a denial',async()=>{
  rpc.mockReturnValue(reply([]));expect(await listDirectAccounts(ctx)).toEqual([]);expect(access).toHaveBeenCalledWith(site,user);expect(load).not.toHaveBeenCalled();
  await expect(listDirectAccounts({...ctx,connectorIdHint:id})).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});expect(visible).toHaveBeenCalledWith(site,user,id);
  visible.mockRejectedValueOnce(new ConnectorError('NOT_FOUND','Connector not found.',404));await expect(target()).rejects.toMatchObject({status:404});
});
it('does not use a visible account as proof of a verified connection',async()=>{
  const local='a'.repeat(20);
  visible.mockResolvedValue({...fresh().connector,toolkit_slug:'supabase',supabase_project_ref:local});
  rpc.mockReturnValue(reply([]));
  await expect(listDirectAccounts({...ctx,connectorIdHint:id})).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  await expect(authorizeDirectAction(ctx,id,'SUPABASE_RUN_READ_ONLY_QUERY')).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  visible.mockRejectedValueOnce(new ConnectorError('NOT_FOUND','Connector not found.',404));
  await expect(listDirectAccounts({...ctx,connectorIdHint:id})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await listDirectAccounts(ctx)).toEqual([]);
  expect(load).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled();
});
it('rejects noninteractive/forged scopes and account hint substitutions before database access',async()=>{
  for (const patch of [{host:'workflow'}, {host:'direct'}, {catalogUserSession:undefined}, {agentId:''}, {instanceId:undefined}, {siteId:''}, {userId:''}, {connectorIdHint:randomUUID()}]) {
    await expect(authorizeDirectAction({...ctx,...patch} as ConnectorContext,id,'CRM_UPDATE_DEAL')).rejects.toBeInstanceOf(ConnectorError);
  }
  await expect(authorizeDirectAction(ctx,id,'COMPOSIO_EXECUTE_TOOL')).rejects.toBeInstanceOf(ConnectorError);
  expect(visible).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});
it('does not trust a stale credential/project or a foreign returned DTO',async()=>{
  binding.mockResolvedValueOnce({projectId:'other'});await expect(target()).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  load.mockResolvedValueOnce({revision:'new'});await expect(target()).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  const expired=fresh();expired.expires_at=new Date(0).toISOString();await expect(legacyTarget(expired,null,'CRM_LIST_DEALS')).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  for (const direct_revision of [0,undefined,1.5]) {
    rpc.mockReturnValueOnce(reply([{...connected(),direct_revision}]));await expect(target()).rejects.toMatchObject({status:503});
  }
  const foreign=connected();foreign.connector.site_id=randomUUID();rpc.mockReturnValueOnce(reply([foreign]));await expect(target()).rejects.toMatchObject({status:503});
  const unverified=connected();unverified.connector.revocation_dispatched=true;rpc.mockReturnValueOnce(reply([unverified]));await expect(target()).rejects.toMatchObject({status:503});
  rpc.mockReturnValueOnce(reply([connected(),connected()]));await expect(target()).rejects.toMatchObject({status:503});
  const wrongSelection=connected();wrongSelection.policy.tool_access_mode='selected';wrongSelection.policy.allowed_tools=['CRM_OTHER'];rpc.mockReturnValueOnce(reply([wrongSelection]));await expect(target()).rejects.toMatchObject({status:503});
});
it('compares an independently attested database resource to fresh local installation identity, refusing unknown/mismatch/local',async()=>{
  const local='a'.repeat(20),external='b'.repeat(20);const db=fresh(); db.connector.toolkit_slug='supabase'; db.resource_boundary=external;
  db.connector.supabase_project_ref=external;db.local_installation_ref=local;
  const resolve=(actual: string|null)=>legacyTarget(db,actual,'SUPABASE_LIST_WIDGETS');
  expect((await resolve(local)).localProjectRef).toBe(local);
  // SQL is a provider action, not a locally substituted report. Keep its exact account proof.
  await expect(legacyTarget(db,local,'SUPABASE_RUN_READ_ONLY_QUERY')).resolves.toMatchObject({localProjectRef:local,connector:{id}});
  for (const actual of [null,'c'.repeat(20),external]) await expect(resolve(actual)).rejects.toMatchObject({status:403});
  db.local_installation_ref=external;await expect(resolve(external)).rejects.toMatchObject({status:403});
  db.local_installation_ref=local;db.connector.supabase_project_ref=null;await expect(resolve(local)).rejects.toMatchObject({status:403});
});

it.each(['all','selected'])('admits catalog capabilities through %s without widening account or tool selection',async mode=>{
  for (const action of ['CRM_EXECUTE_SCRIPT','CRM_GET_CREDENTIALS','CRM_SQL_QUERY','CRM_HTTP_PROXY']) {
    const row=connected();row.policy.tool_access_mode=mode;row.policy.allowed_tools=[action];
    rpc.mockReturnValueOnce(reply([row]));
    await expect(authorizeDirectAction(ctx,id,action)).resolves.toMatchObject({connector:{id},policy:{tool_access_mode:mode}});
  }
  await expect(authorizeDirectAction(ctx,id,'OTHER_LIST_DEALS')).rejects.toMatchObject({code:'DIRECT_ACTION_UNSUPPORTED'});
});

it('admits a positively classified account on its exact pin, without manufacturing an attestation', async()=>{
  const {connector,provider,policy,direct_revision}=fresh();
  const ordinary={connector:{...connector,toolkit_slug:'gmail',granted_scopes:['https://www.googleapis.com/auth/gmail.send']},
    provider,policy,direct_revision,authority_kind:'connected_account',authorization_id:randomUUID()};
  const admit=(row:unknown=ordinary)=>legacyTarget(row,null,'GMAIL_SEND_EMAIL');
  expect((await admit()).directProof).toEqual({kind:'connected_account',authorizationId:ordinary.authorization_id,
    directRevision:3,siteId:site,connectorId:id,providerId:provider.id,toolkitSlug:'gmail',projectId:'p1',accountId:'a1',authConfigId:'ac1',credentialRevision:rev});
  for(const patch of [{authority_kind:'other'}, {authorization_id:undefined}, {attestation_id:randomUUID()},
    {local_installation_ref:null},{resource_boundary:'unverified'},{expires_at:new Date().toISOString()},
    {connector:{...ordinary.connector,toolkit_slug:'supabase'}},{connector:{...ordinary.connector,supabase_project_ref:'a'.repeat(20)}},
    {connector:{...ordinary.connector,granted_scopes:[...ordinary.connector.granted_scopes,'unknown.admin']}},
    {provider:{...provider,provider_user_id:randomUUID()}},{provider:{...provider,site_id:randomUUID()}},
    {provider:{...provider,project_id:'another'}},{provider:{...provider,id:randomUUID()}}]) {
    await expect(admit({...ordinary,...patch})).rejects.toThrow();
  }
  for(const patch of [{authority_kind:'connected_account'}, {authority_kind:'attested'}, {authorization_id:randomUUID()}]) {
    rpc.mockReturnValueOnce(reply([{...fresh(),...patch}]));await expect(target()).rejects.toBeInstanceOf(ConnectorError);
  }
});

it('distinguishes a delegated scheme/project pin from both legacy consent and a project attestation',async()=>{
  const {connector,provider,policy,direct_revision}=fresh(), project='b'.repeat(20);
  const row={authority_kind:'connected_account',authorization_id:randomUUID(),auth_scheme:'API_KEY',bound_project_ref:project,
    connector:{...connector,toolkit_slug:'supabase',supabase_project_ref:project},provider,policy,direct_revision};
  const admit=(slug='SUPABASE_GET_PROJECT',fixture:unknown=row,localRef:string|null=project)=>legacyTarget(fixture,localRef,slug);
  expect((await admit()).directProof).toMatchObject({kind:'connected_account',authScheme:'API_KEY',boundProjectRef:project});
  for(const action of ['UPDATE_PROJECT','LIST_TABLES','RUN_READ_ONLY_QUERY']) {
    await expect(admit(`SUPABASE_${action}`)).resolves.toMatchObject({connector:{supabase_project_ref:project}});
  }
  for(const patch of [{bound_project_ref:'c'.repeat(20)},{bound_project_ref:undefined},{auth_scheme:undefined},
    {auth_scheme:'SERVICE_ROLE'},{auth_scheme:'OAUTH2'},{authorization_id:undefined}]) {
    await expect(admit(undefined,{...row,...patch})).rejects.toThrow();
  }
  await expect(admit(undefined,row,null)).resolves.toMatchObject({connector:{supabase_project_ref:project}});
});

it('admits verified Supabase actions on the saved project without a locality check, but still enforces the saved selection',async()=>{
  const project='a'.repeat(20), row=connected();
  row.connector.toolkit_slug='supabase';row.connector.supabase_project_ref=project;
  rpc.mockReturnValue(reply([row]));
  expect(await listDirectAccounts({...ctx,connectorIdHint:id})).toMatchObject([{directProof:{kind:'verified_connection',connectionAttemptId:attempt}}]);
  for (const action of ['SUPABASE_GET_PROJECT','SUPABASE_LIST_TABLES','SUPABASE_RUN_READ_ONLY_QUERY']) {
    await expect(authorizeDirectAction(ctx,id,action)).resolves.toMatchObject({connector:{supabase_project_ref:project}});
  }
  expect(rpc.mock.calls.map(([name])=>name)).toEqual(Array(4).fill('connector_ask_connections'));
  row.policy.tool_access_mode='selected';row.policy.allowed_tools=['SUPABASE_LIST_TABLES'];
  await expect(authorizeDirectAction(ctx,id,'SUPABASE_LIST_TABLES')).resolves.toMatchObject({connector:{supabase_project_ref:project}});
  await expect(authorizeDirectAction(ctx,id,'SUPABASE_RUN_READ_ONLY_QUERY')).rejects.toMatchObject({code:'DIRECT_POLICY_UNAVAILABLE'});
  row.connector.supabase_project_ref=null;
  await expect(authorizeDirectAction(ctx,id,'SUPABASE_LIST_TABLES')).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
});
