import {randomUUID,randomBytes} from 'node:crypto';
import {createProviderDirectRuntime} from '../provider-direct-runtime';
import {authorizeDirectAction,listDirectAccounts} from '../provider-direct-policy';
import {loadConnectorCredential} from '../account-access';
import {executeDirectTool,describeDirectTool} from '../provider-direct-transport';
import {claimDirectDispatch,storeDirectResult} from '../provider-direct-receipt';
import {searchDirectTools} from '../provider-direct-discovery';
import {ConnectorError,type ConnectorContext} from '../types';
import {failureForAgent} from '../agent-recovery';
import {accountFixture,connectorFixture,providerFixture} from './composio-fixtures';

jest.mock('../provider-direct-policy',()=>({authorizeDirectAction:jest.fn(),listDirectAccounts:jest.fn()}));
jest.mock('../provider-direct-discovery',()=>({searchDirectTools:jest.fn()}));
jest.mock('../provider-direct-transport',()=>({describeDirectTool:jest.fn(),executeDirectTool:jest.fn()}));
jest.mock('../provider-direct-receipt',()=>({claimDirectDispatch:jest.fn(),storeDirectResult:jest.fn()}));
jest.mock('../account-access',()=>({loadConnectorCredential:jest.fn()}));

const random = ()=>randomBytes(24).toString('hex');
function fixture() {
  const connectorId=randomUUID(), siteId=randomUUID(), proofId=randomUUID();
  const ctx:ConnectorContext={host:'assistant',catalogUserSession:true,siteId,userId:randomUUID(),agentId:randomUUID(),instanceId:randomUUID(),requestId:randomUUID(),connectorIdHint:connectorId};
  const kit='orderdesk',slug='ORDERDESK_CREATE_ITEM',name=`connector:${connectorId}:${slug}`;
  const connector={...connectorFixture(),toolkit_slug:kit,id:connectorId,site_id:siteId};
  const provider={...providerFixture(),provider_user_id:siteId,site_id:siteId};
  const proof={attestationId:proofId,directRevision:3,expiresAt:new Date(Date.now()+60000).toISOString(),siteId,connectorId,providerId:provider.id,
    projectId:provider.project_id,accountId:accountFixture().id,authConfigId:connector.auth_config_id,credentialRevision:provider.credential_revision,
    resourceBoundary:'business-data',toolkitSlug:kit};
  const target={connector,provider,policy:{revision:1,tool_access_mode:'all' as const,allowed_tools:[],allowed_hosts:['assistant'],require_approval:true},directProof:proof};
  const key=random(),privateValue='Private customer value',receipt=randomUUID(),claim=randomUUID(),hash=randomBytes(32).toString('hex');
  const pin={version:'20261119_00',schema_hash:hash,arguments:{text:'requested change'}};
  jest.mocked(loadConnectorCredential).mockResolvedValue({source:'byok',apiKey:key,revision:provider.credential_revision});
  jest.mocked(authorizeDirectAction).mockImplementation(async()=>structuredClone(target));
  jest.mocked(listDirectAccounts).mockResolvedValue([target]);
  jest.mocked(searchDirectTools).mockResolvedValue({tools:[],truncated:false,next_cursor:null});
  jest.mocked(describeDirectTool).mockResolvedValue({version:pin.version,schemaHash:hash,parameters:{type:'object'},effect:'write',description:'Create item'});
  jest.mocked(claimDirectDispatch).mockResolvedValue(claim);jest.mocked(storeDirectResult).mockResolvedValue(receipt);
  let posts=0;
  jest.mocked(executeDirectTool).mockImplementation(async(_t,_cred,_s,_p,before)=>{await before();posts++;return {data:{label:privateValue,secret:key}};});
  return {run:createProviderDirectRuntime(async()=>ctx),ctx,name,slug,key,privateValue,claim,receipt,target,pin,posts:()=>posts};
}
beforeEach(()=>jest.resetAllMocks());

it('rechecks identity, policy and claim, uses current version and returns only an authenticated private link',async()=>{
  const f=fixture(),desc=await f.run.describe(f.name);expect(desc).toMatchObject({effect:'write',schema_hash:f.pin.schema_hash});
  const call=await f.run.call(f.name,f.pin);expect(f.posts()).toBe(1);
  expect(call).toMatchObject({success:true,receipt:{url:`/connectors/results/${f.receipt}`}});
  const stored=jest.mocked(storeDirectResult).mock.calls[0];expect(stored[5].rows).toEqual([['$.label',f.privateValue]]);expect(stored[6]).toBe(f.claim);
  expect(jest.mocked(claimDirectDispatch).mock.calls[0].at(-1)).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(stored[5])).not.toContain(f.key);expect(JSON.stringify(call)).not.toContain(f.privateValue);
  expect(authorizeDirectAction).toHaveBeenCalledTimes(5);
});
it.each([['before','direct epoch'],['after','direct epoch'],['before','policy'],['after','policy']])('rejects a change %s external dispatch (%s)',async (when,field)=>{
  const f=fixture(),step=jest.mocked(authorizeDirectAction);
  step.mockResolvedValueOnce(f.target);
  if(when==='after') step.mockResolvedValueOnce(f.target);
  step.mockResolvedValue(field==='direct epoch' ? {...f.target,directProof:{...f.target.directProof,directRevision:5}} :
    {...f.target,policy:{...f.target.policy,revision:2}});
  const e=await f.run.call(f.name,f.pin).catch(e=>e);
  if (when==='before') {expect(e).toMatchObject({code:'ACCESS_CHANGED',executed:false});expect(claimDirectDispatch).not.toHaveBeenCalled();}
  else {expect(e).toMatchObject({code:'DIRECT_RESULT_UNCONFIRMED'});expect(e).not.toHaveProperty('executed');}
  expect(f.posts()).toBe(when==='before'?0:1);expect(storeDirectResult).not.toHaveBeenCalled();
});
it('propagates a duplicate durable reservation without dispatch or a claim that the original never executed',async()=>{
  const f=fixture();jest.mocked(claimDirectDispatch).mockRejectedValue(new ConnectorError('DIRECT_DISPATCH_ALREADY_CLAIMED','Already reserved',409));
  const err=await f.run.call(f.name,f.pin).catch(e=>e);const failure=failureForAgent(err);
  expect(f.posts()).toBe(0);expect(failure.recovery.action).toBe('reconcile');expect(failure).not.toHaveProperty('executed');expect(failure.automatic_retry).toBe(false);
});
it('no key/metadata/dispatch for wrong host, wrong account or invalid interactive identity',async()=>{
  const f=fixture();
  await expect(f.run.search({connector_id:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(f.run.describe(`connector:${randomUUID()}:${f.slug}`)).rejects.toMatchObject({code:'NOT_FOUND'});
  f.ctx.catalogUserSession=undefined;
  await expect(f.run.call(f.name,f.pin)).rejects.toMatchObject({executed:false,code:'PRIVATE_DESTINATION_REQUIRED'});
  for(const dependency of [listDirectAccounts,authorizeDirectAction,loadConnectorCredential,executeDirectTool,describeDirectTool]) expect(dependency).not.toHaveBeenCalled();
});
it('rejects retired inputs before resolving authority, describing a provider action or claiming a receipt', async () => {
  const resolve = jest.fn(), runtime = createProviderDirectRuntime(resolve);
  const stale = `report:${randomUUID()}:MAKINARI_METRICS`;
  // Simulate an older client rather than weakening the current discovery type.
  await expect(runtime.search(JSON.parse('{"tool_origin":"makinari_report"}'))).rejects.toMatchObject({code:'INVALID_FILTER'});
  for (const ref of [stale, ' REPORT :malformed']) {
    await expect(runtime.search({query:ref})).rejects.toMatchObject({code:'INVALID_FILTER'});
    await expect(runtime.describe(ref)).rejects.toMatchObject({code:'INVALID_TOOL_REFERENCE'});
    await expect(runtime.call(ref,{})).rejects.toMatchObject({code:'INVALID_TOOL_REFERENCE',executed:false,effectStarted:false});
  }
  for (const dep of [resolve,listDirectAccounts,authorizeDirectAction,describeDirectTool,executeDirectTool,claimDirectDispatch]) expect(dep).not.toHaveBeenCalled();
});
it('does not use the legacy read or native report when policy is missing',async()=>{
  const f=fixture();jest.mocked(authorizeDirectAction).mockRejectedValue(new ConnectorError('DIRECT_POLICY_REQUIRED','Not enrolled',403));
  await expect(f.run.call(f.name,f.pin)).rejects.toMatchObject({code:'DIRECT_POLICY_REQUIRED',executed:false});
  expect(loadConnectorCredential).not.toHaveBeenCalled();expect(claimDirectDispatch).not.toHaveBeenCalled();
});
it('requires a trusted action for effects and narrows account pagination before querying policy',async()=>{
  const f=fixture();f.ctx.connectorIdHint=undefined;
  await f.run.search({connector_id:f.target.connector.id});expect(listDirectAccounts).toHaveBeenCalledWith({...f.ctx,connectorIdHint:f.target.connector.id});
  f.ctx.requestId=undefined;
  await expect(f.run.call(f.name,f.pin)).rejects.toMatchObject({executed:false,code:'PRIVATE_DESTINATION_REQUIRED'});
  expect(executeDirectTool).not.toHaveBeenCalled();
});