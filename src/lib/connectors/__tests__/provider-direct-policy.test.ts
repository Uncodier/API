import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { listDirectAccounts, authorizeDirectAction } from '../provider-direct-policy';
import { ConnectorError, type ConnectorContext } from '../types';

const rpc = jest.fn(), access = jest.fn(), visible = jest.fn(), load = jest.fn(), binding = jest.fn(), evidence = jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...args:unknown[])=>rpc(...args)}}));
jest.mock('../account-access',()=>({requireConnectorSiteAccess:(...args:unknown[])=>access(...args), getVisibleConnector:(...args:unknown[])=>visible(...args),
  loadConnectorCredential:(...args:unknown[])=>load(...args),connectorDatabaseError:()=>{throw new Error('DB error');}}));
jest.mock('../provider-project-binding',()=>({readTokenProviderBinding:(...args:unknown[])=>binding(...args)}));
jest.mock('@/lib/database/hosted-project-identity',()=>({withDirectActorEvidence:(...args:unknown[])=>evidence(...args)}));
const site=randomUUID(),user=randomUUID(),instance=randomUUID(),agent=randomUUID(),id=randomUUID(),provider=randomUUID(),attestation=randomUUID();
const credential=randomBytes(32).toString('hex'), rev=createHash('sha256').update(credential).digest('hex');
const ctx:ConnectorContext={host:'assistant',catalogUserSession:true,siteId:site,userId:user,instanceId:instance,agentId:agent};
const fresh=()=>({attestation_id:attestation,direct_revision:3,expires_at:new Date(Date.now()+60_000).toISOString(),resource_boundary:'external-tenant-01',local_installation_ref:null as string|null,
  connector:{id,site_id:site,provider_id:provider,provider_project_id:'p1',toolkit_slug:'crm',provider_account_id:'a1',auth_config_id:'ac1',display_name:'My CRM',supabase_project_ref:null as null|string,
    provider_status:'ACTIVE',enabled:true,access_mode:'workspace',revocation_pending:false,revocation_dispatched:false,granted_scopes:[],created_by:user,revision:4,verified_at:new Date().toISOString()},
  provider:{id:provider,site_id:site,provider:'composio',project_id:'p1',provider_user_id:site,credential_revision:rev,status:'active'},
  policy:{allowed_tools:[] as string[],allowed_hosts:['assistant'],revision:7,require_approval:true,tool_access_mode:'all'}});
const reply = (data:unknown,error:unknown=null)=>({abortSignal:async()=>({data,error})});
const target = ()=>authorizeDirectAction(ctx,id,'CRM_LIST_DEALS');
beforeEach(()=>{jest.resetAllMocks(); rpc.mockImplementation(()=>reply([fresh()]));load.mockResolvedValue({source:'byok',apiKey:credential,revision:rev});
  binding.mockResolvedValue({projectId:'p1'});visible.mockResolvedValue(fresh().connector);access.mockResolvedValue({can_view:true,can_manage:false});});

it('only returns current DB-backed direct proof for the exact account/actor and drops unrelated fields',async()=>{
  rpc.mockReturnValue(reply([{...fresh(),not_public:'ignored'}])); const t=await target();
  expect(t.directProof).toMatchObject({attestationId:attestation,directRevision:3,accountId:'a1',authConfigId:'ac1',siteId:site,projectId:'p1',credentialRevision:rev});
  expect(rpc).toHaveBeenCalledWith('connector_direct_accounts',{p_site_id:site,p_user_id:user,p_instance_id:instance,p_agent_id:agent,p_connector_id:id,p_slug:'CRM_LIST_DEALS'});
  expect(t.policy.tool_access_mode).toBe('all');expect(t).not.toHaveProperty('requestOnly');expect(JSON.stringify(t)).not.toContain(credential);
  expect(evidence).not.toHaveBeenCalled(); expect(t).not.toHaveProperty('not_public');
});
it('uses one site-scoped browse check, or an exact account visibility check even on a denial',async()=>{
  rpc.mockReturnValue(reply([]));expect(await listDirectAccounts(ctx)).toEqual([]);expect(access).toHaveBeenCalledWith(site,user);expect(load).not.toHaveBeenCalled();
  await expect(listDirectAccounts({...ctx,connectorIdHint:id})).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});expect(visible).toHaveBeenCalledWith(site,user,id);
  visible.mockRejectedValueOnce(new ConnectorError('NOT_FOUND','Connector not found.',404));await expect(target()).rejects.toMatchObject({status:404});
});
it('does not classify an unenrolled account by project name or grant it direct execution',async()=>{
  const local='a'.repeat(20);
  visible.mockResolvedValue({...fresh().connector,toolkit_slug:'supabase',supabase_project_ref:local});
  rpc.mockImplementation((name:string)=>reply(name==='connector_direct_actor' ? true : []));
  evidence.mockImplementation(async check=>({allowed:await check(),localProjectRef:local}));
  await expect(listDirectAccounts({...ctx,connectorIdHint:id})).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  await expect(authorizeDirectAction(ctx,id,'SUPABASE_RUN_READ_ONLY_QUERY')).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  visible.mockRejectedValueOnce(new ConnectorError('NOT_FOUND','Connector not found.',404));
  await expect(listDirectAccounts({...ctx,connectorIdHint:id})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await listDirectAccounts(ctx)).toEqual([]);
  expect(evidence).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled();
});
it('rejects noninteractive/forged scopes and account hint substitutions before database access',async()=>{
  for (const patch of [{host:'workflow'}, {host:'direct'}, {catalogUserSession:undefined}, {agentId:''}, {instanceId:undefined}, {siteId:''}, {userId:''}, {connectorIdHint:randomUUID()}]) {
    await expect(authorizeDirectAction({...ctx,...patch} as ConnectorContext,id,'CRM_UPDATE_DEAL')).rejects.toBeInstanceOf(ConnectorError);
  }
  await expect(authorizeDirectAction(ctx,id,'COMPOSIO_EXECUTE_TOOL')).rejects.toBeInstanceOf(ConnectorError);
  expect(visible).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});
it('does not trust a stale credential/project/expiry or a foreign returned DTO',async()=>{
  binding.mockResolvedValueOnce({projectId:'other'});await expect(target()).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  load.mockResolvedValueOnce({revision:'new'});await expect(target()).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  const expired=fresh();expired.expires_at=new Date(0).toISOString();rpc.mockReturnValueOnce(reply([expired]));await expect(target()).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED'});
  for (const direct_revision of [0,undefined,1.5]) {
    rpc.mockReturnValueOnce(reply([{...fresh(),direct_revision}]));await expect(target()).rejects.toMatchObject({status:503});
  }
  const foreign=fresh();foreign.connector.site_id=randomUUID();rpc.mockReturnValueOnce(reply([foreign]));await expect(target()).rejects.toMatchObject({status:503});
  const unverified=fresh();unverified.connector.revocation_dispatched=true;rpc.mockReturnValueOnce(reply([unverified]));await expect(target()).rejects.toMatchObject({status:503});
  rpc.mockReturnValueOnce(reply([fresh(),fresh()]));await expect(target()).rejects.toMatchObject({status:503});
  const wrongSelection=fresh();wrongSelection.policy.tool_access_mode='selected';wrongSelection.policy.allowed_tools=['CRM_OTHER'];rpc.mockReturnValueOnce(reply([wrongSelection]));await expect(target()).rejects.toMatchObject({status:503});
});
it('compares an independently attested database resource to fresh local installation identity, refusing unknown/mismatch/local',async()=>{
  const local='a'.repeat(20),external='b'.repeat(20);const db=fresh(); db.connector.toolkit_slug='supabase'; db.resource_boundary=external;
  db.connector.supabase_project_ref=external;db.local_installation_ref=local;rpc.mockImplementation((name:string)=>name==='connector_direct_actor'?reply(true):reply([db]));
  const resolve=()=>authorizeDirectAction(ctx,id,'SUPABASE_LIST_WIDGETS');
  evidence.mockImplementation(async check=>({allowed:await check(),localProjectRef:local}));expect((await resolve()).localProjectRef).toBe(local);
  // The provider action stays subject to its own business-tool policy; it must not become a report.
  await expect(authorizeDirectAction(ctx,id,'SUPABASE_RUN_READ_ONLY_QUERY')).rejects.toMatchObject({code:'DIRECT_ACTION_UNSUPPORTED'});
  for (const actual of [null,'c'.repeat(20),external]) {evidence.mockResolvedValueOnce({allowed:true,localProjectRef:actual});await expect(resolve()).rejects.toMatchObject({status:403});}
  db.local_installation_ref=external;evidence.mockResolvedValueOnce({allowed:true,localProjectRef:external});await expect(resolve()).rejects.toMatchObject({status:403});
  db.local_installation_ref=local;db.connector.supabase_project_ref=null;await expect(resolve()).rejects.toMatchObject({status:403});
});

it('never upgrades explicit unsafe capabilities to executable actions through all mode',async()=>{
  for (const action of ['CRM_EXECUTE_SCRIPT','CRM_GET_CREDENTIALS','CRM_SQL_QUERY','CRM_HTTP_PROXY','OTHER_LIST_DEALS']) {
    await expect(authorizeDirectAction(ctx,id,action)).rejects.toMatchObject({code:'DIRECT_ACTION_UNSUPPORTED'});
  }
});
