import { randomUUID } from 'node:crypto';
import { getRedisClient } from '@/lib/utils/redis-client';
import { createProviderDirectRuntime } from '../provider-direct-runtime';
import { authorizeDirectAction } from '../provider-direct-policy';
import { selectedCatalogAccount, type CatalogOnlyAccount } from '../selected-catalog-account';
import { prepareSelectedQueryProbe } from '../selected-query-probe-transport';
import { loadConnectorCredential } from '../account-access';
import { PROBE_PROVIDER_ACTION, SELECTED_QUERY_PROBE } from '../selected-query-probe-policy';
import { executeDirectTool } from '../provider-direct-transport';
import { claimDirectDispatch, storeDirectResult } from '../provider-direct-receipt';
import { ConnectorError, type ConnectorContext } from '../types';
import { failureForAgent } from '../agent-recovery';
import { connectorFixture, providerFixture, secret } from './composio-fixtures';

jest.mock('@/lib/utils/redis-client', () => ({getRedisClient:jest.fn()}));
jest.mock('../selected-catalog-account', () => ({selectedCatalogAccount:jest.fn()}));
jest.mock('../selected-query-probe-transport', () => ({prepareSelectedQueryProbe:jest.fn()}));
jest.mock('../provider-direct-policy', () => ({authorizeDirectAction:jest.fn()}));
jest.mock('../provider-direct-transport', () => ({executeDirectTool:jest.fn()}));
jest.mock('../provider-direct-receipt', () => ({claimDirectDispatch:jest.fn(),storeDirectResult:jest.fn()}));
jest.mock('../account-access', () => ({loadConnectorCredential:jest.fn()}));

beforeEach(() => jest.resetAllMocks());
afterEach(() => { for (const generic of [authorizeDirectAction,executeDirectTool,claimDirectDispatch,storeDirectResult]) expect(generic).not.toHaveBeenCalled(); });
function setup() {
  const site=randomUUID(), id=randomUUID(), req=randomUUID();
  const ctx:ConnectorContext={host:'assistant',catalogUserSession:true,siteId:site,userId:randomUUID(),instanceId:randomUUID(),agentId:randomUUID(),
    requestId:req,connectorIdHint:id,sourceDigest:secret()};
  const target:CatalogOnlyAccount={catalogOnly:true, connector:{...connectorFixture(),site_id:site,id,revocation_dispatched:false,
    toolkit_slug:'supabase',supabase_project_ref:'a'.repeat(20)}, provider:{...providerFixture(),site_id:site,provider_user_id:site},
    policy:{tool_access_mode:'selected',catalog_reads:true,allowed_hosts:['assistant'],allowed_tools:[PROBE_PROVIDER_ACTION],require_approval:true,revision:4}};
  jest.mocked(selectedCatalogAccount).mockResolvedValue(target);
  jest.mocked(loadConnectorCredential).mockResolvedValue({revision:target.provider.credential_revision,apiKey:secret(),source:'byok'});
  const checked = jest.fn(), posted=jest.fn();
  const prepared={version:'20261116_00',schemaHash:secret(),execute: async(check:()=>Promise<void>)=>{checked();await check();posted();}};
  jest.mocked(prepareSelectedQueryProbe).mockResolvedValue(prepared);
  const claimed=new Set<string>();
  const set=jest.fn(async(key:string)=>{if(claimed.has(key)) return null; claimed.add(key);return 'OK';});
  jest.mocked(getRedisClient).mockReturnValue({set} as unknown as ReturnType<typeof getRedisClient>);
  const name=`connector:${id}:${SELECTED_QUERY_PROBE}`, resolve=async()=>ctx, run=createProviderDirectRuntime(resolve);
  const pin=async()=>{const d=await run.describe(name);return {version:d.version,schema_hash:d.schema_hash,arguments:{query:'SELECT 1'}};};
  return {ctx,target,checked,posted,set,prepared,name,resolve,run,pin};
}

it.each(['all','selected'] as const)('rechecks %s use and returns verified connectivity only, never data/receipt',async mode=>{
  const f=setup(); f.target.policy.tool_access_mode=mode;
  const d=await f.run.describe(f.name);
  expect(d).toMatchObject({name:f.name,connector_id:f.target.connector.id,parameters:{properties:{arguments:{additionalProperties:false,
    properties:{query:{const:'SELECT 1'}}}}}});
  expect(JSON.stringify(d)).not.toContain(f.target.connector.supabase_project_ref);
  const result=await f.run.call(f.name,{version:d.version,schema_hash:d.schema_hash,arguments:{query:'SELECT 1'}});
  expect(result).toEqual({success:true,connection_test:'verified',guidance:expect.stringContaining('data access was not verified')});
  expect(f.posted).toHaveBeenCalledTimes(1); expect(selectedCatalogAccount).toHaveBeenCalledTimes(5);
  for(const [ctx,id] of jest.mocked(selectedCatalogAccount).mock.calls) {expect(ctx).toEqual(f.ctx);expect(id).toBe(f.ctx.connectorIdHint);}
});
it.each([{}, {query:'select 1'}, {query:'SELECT * FROM sales'}, {query:'SELECT 1;'}, {query:'SELECT 1',ref:'a'.repeat(20)}])('never rewrites %p to the fixed query',async args=>{
  const f=setup(); const pin=await f.pin(); jest.mocked(prepareSelectedQueryProbe).mockClear();
  await expect(f.run.call(f.name,{...pin,arguments:args})).rejects.toMatchObject({code:'DIRECT_ACTION_UNSUPPORTED',executed:false});
  expect(prepareSelectedQueryProbe).not.toHaveBeenCalled();expect(f.set).not.toHaveBeenCalled();
});
it.each(['no hint','different account','not signed in','workflow','no turn','wrong action','disabled host','unbound','actor veto','authority outage'])('fails closed: %s',async reason=>{
  const f=setup();
  switch(reason){
    case 'no hint': delete f.ctx.connectorIdHint;break;
    case 'different account':f.ctx.connectorIdHint=randomUUID();break;
    case 'not signed in':delete f.ctx.catalogUserSession;break;
    case 'workflow':f.ctx.host='workflow';break;
    case 'no turn':delete f.ctx.requestId;break;
    case 'wrong action':f.target.policy.allowed_tools=['SUPABASE_LIST_PROJECTS'];break;
    case 'disabled host':f.target.policy.allowed_hosts=[];break;
    case 'unbound':f.target.connector.supabase_project_ref=null;break;
    case 'actor veto':jest.mocked(selectedCatalogAccount).mockRejectedValue(new ConnectorError('ACCESS_DENIED','denied',403));break;
    case 'authority outage':jest.mocked(selectedCatalogAccount).mockRejectedValue(new ConnectorError('DIRECT_POLICY_UNAVAILABLE','unavailable',503));break;
  }
  await expect(f.run.describe(f.name)).rejects.toBeInstanceOf(ConnectorError);
  expect(prepareSelectedQueryProbe).not.toHaveBeenCalled();expect(f.posted).not.toHaveBeenCalled();
});
it.each(['user','turn','agent','digest','instance','binding','policy','transport'])('rejects a descriptor from another %s',async field=>{
  const f=setup();const pin=await f.pin();
  switch(field){case 'user':f.ctx.userId=randomUUID();break;case 'turn':f.ctx.requestId=randomUUID();break;case 'agent':f.ctx.agentId=randomUUID();break;
    case 'digest':f.ctx.sourceDigest=secret();break;case 'instance':f.ctx.instanceId=randomUUID();break;case 'binding':f.target.connector.supabase_project_ref='b'.repeat(20);break;
    case 'policy':f.target.policy.revision=5;break;case 'transport':f.prepared.schemaHash=secret();break;}
  await expect(f.run.call(f.name,pin)).rejects.toMatchObject({code:'CONNECTOR_SCHEMA_CHANGED',executed:false});expect(f.posted).not.toHaveBeenCalled();
});
it('stops a credential rotation at the last authorization check',async()=>{
  const f=setup();const pin=await f.pin(); f.checked.mockImplementation(()=>jest.mocked(loadConnectorCredential).mockResolvedValue({revision:secret(),apiKey:secret(),source:'byok'}));
  await expect(f.run.call(f.name,pin)).rejects.toMatchObject({code:'ACCESS_CHANGED',executed:false});expect(f.posted).not.toHaveBeenCalled();
});
it('withholds confirmation if grant is revoked during the call',async()=>{
  const f=setup();const pin=await f.pin(); f.posted.mockImplementation(()=>jest.mocked(selectedCatalogAccount).mockRejectedValue(new ConnectorError('ACCESS_DENIED','Member revoked',403)));
  const result=await f.run.call(f.name,pin).catch(failureForAgent);expect(result).toMatchObject({code:'PROBE_UNCONFIRMED',automatic_retry:false});expect(result).not.toHaveProperty('executed');
});
it.each(['PROVIDER_FORBIDDEN','APP_RESOURCE_DENIED','CONNECTOR_OUTCOME_UNKNOWN'])('one dispatch across independent gateways on %s',async code=>{
  const f=setup();const pin=await f.pin(); f.posted.mockImplementation(()=>{throw new ConnectorError(code,'private upstream message',502);});
  const other=createProviderDirectRuntime(f.resolve);
  const results=await Promise.all([f.run.call(f.name,pin).catch(failureForAgent),other.call(f.name,pin).catch(failureForAgent)]);
  expect(results).toEqual(expect.arrayContaining([expect.objectContaining({code:code==='CONNECTOR_OUTCOME_UNKNOWN'?'PROBE_UNCONFIRMED':code}),expect.objectContaining({code:'PROBE_ALREADY_ATTEMPTED'})]));
  for(const result of results){expect(result).toMatchObject({success:false,automatic_retry:false});expect(result).not.toHaveProperty('executed');}
  expect(JSON.stringify(results)).not.toContain('private upstream');expect(f.posted).toHaveBeenCalledTimes(1);
});
it('refuses to dispatch without a confirmed replay reservation',async()=>{
  const f=setup();const pin=await f.pin();f.set.mockRejectedValue(new Error('offline'));
  await expect(f.run.call(f.name,pin)).rejects.toMatchObject({code:'DIRECT_DISPATCH_UNCONFIRMED'});expect(f.posted).not.toHaveBeenCalled();
});
