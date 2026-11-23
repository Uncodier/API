import {randomUUID,randomBytes} from 'node:crypto';
import {createProviderDirectRuntime} from '../provider-direct-runtime';
import {authorizeDirectAction,listDirectAccounts} from '../provider-direct-policy';
import {loadConnectorCredential} from '../account-access';
import {executeDirectTool,describeDirectTool} from '../provider-direct-transport';
import {claimDirectDispatch,confirmDirectResultRelease,storeDirectResult} from '../provider-direct-receipt';
import {searchDirectTools} from '../provider-direct-discovery';
import {ConnectorError,type ConnectorContext} from '../types';
import {failureForAgent} from '../agent-recovery';
import {accountFixture,connectorFixture,providerFixture} from './composio-fixtures';

jest.mock('../provider-direct-policy',()=>({authorizeDirectAction:jest.fn(),listDirectAccounts:jest.fn()}));
jest.mock('../provider-direct-discovery',()=>({searchDirectTools:jest.fn()}));
jest.mock('../provider-direct-transport',()=>({describeDirectTool:jest.fn(),executeDirectTool:jest.fn()}));
jest.mock('../provider-direct-receipt',()=>({claimDirectDispatch:jest.fn(),confirmDirectResultRelease:jest.fn(),storeDirectResult:jest.fn()}));
jest.mock('../account-access',()=>({loadConnectorCredential:jest.fn()}));

const random = ()=>randomBytes(24).toString('hex');
function fixture(kit = 'orderdesk', slug = 'ORDERDESK_CREATE_ITEM') {
  const connectorId=randomUUID(), siteId=randomUUID(), proofId=randomUUID();
  const ctx:ConnectorContext={host:'assistant',catalogUserSession:true,siteId,userId:randomUUID(),agentId:randomUUID(),instanceId:randomUUID(),requestId:randomUUID(),connectorIdHint:connectorId};
  const name=`connector:${connectorId}:${slug}`;
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

it('saves an opted-in redacted record for the same claim without forwarding the flag to the provider',async()=>{
  const f=fixture(),desc=await f.run.describe(f.name);expect(desc).toMatchObject({effect:'write',schema_hash:f.pin.schema_hash});
  expect(desc.parameters.properties.save_record).toMatchObject({type:'boolean',default:false});
  expect(desc.parameters.required).not.toContain('save_record');
  const call=await f.run.call(f.name,{...f.pin,save_record:true});expect(f.posts()).toBe(1);
  expect(call).toMatchObject({success:true,receipt:{url:`/connectors/results/${f.receipt}`},result_omitted:true});
  expect(call).not.toHaveProperty('result');
  const stored=jest.mocked(storeDirectResult).mock.calls[0];expect(stored[5].rows).toEqual([['$.label',f.privateValue]]);expect(stored[6]).toBe(f.claim);
  expect(executeDirectTool).toHaveBeenCalledWith(expect.anything(),expect.anything(),f.slug,f.pin,expect.any(Function));
  expect(confirmDirectResultRelease).not.toHaveBeenCalled();
  expect(jest.mocked(claimDirectDispatch).mock.calls[0].at(-1)).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(stored[5])).not.toContain(f.key);expect(JSON.stringify(call)).not.toContain(f.privateValue);
  expect(authorizeDirectAction).toHaveBeenCalledTimes(5);
});
it.each([{}, {save_record:false}])('returns Supabase inventory facts without storing a record (%j)', async options => {
  const f = fixture('supabase', 'SUPABASE_LIST_TABLES');
  const table = 'internal_orders';
  const data = { tables: null, schemas: [{ schema_name: 'public', tables: [
    { schema_name:'public', table_name:table, table_type:'BASE TABLE', rows:[f.key] },
    { schema_name:'public', table_name:'order_summary', table_type:'VIEW' },
  ] }], query_metadata: { errors:[f.privateValue] }, total_count:99 };
  jest.mocked(executeDirectTool).mockImplementationOnce(async (_t,_c,_s,_p,before) => {
    await before(); return { data };
  });
  const out = await f.run.call(f.name, { ...f.pin, arguments:{}, ...options });
  expect(out).toMatchObject({ success:true, result:{ returned_count:1, coverage:expect.stringMatching(/^Partial:/) } });
  expect(out).not.toHaveProperty('receipt');
  expect(out).not.toHaveProperty('record_status');
  expect(out).not.toHaveProperty('result.total_count');
  expect(out).not.toHaveProperty('result_omitted');
  expect(JSON.stringify(out)).not.toContain(table);
  expect(JSON.stringify(out)).not.toContain(f.privateValue);
  expect(JSON.stringify(out)).not.toContain(f.key);
  expect(storeDirectResult).not.toHaveBeenCalled();
  expect(confirmDirectResultRelease).toHaveBeenCalledTimes(1);
  expect(confirmDirectResultRelease).toHaveBeenCalledWith(f.claim);
  expect(executeDirectTool).toHaveBeenCalledTimes(1);
});
it('counts the returned tables rather than the bounded private preview rows', async () => {
  const f = fixture('supabase', 'SUPABASE_LIST_TABLES');
  const tables = Array.from({length:125}, (_, i) => ({schema:'public', name:`table_${i}`}));
  jest.mocked(executeDirectTool).mockImplementationOnce(async (_t,_c,_s,_p,before) => { await before(); return {data:{tables}}; });
  await expect(f.run.call(f.name, {...f.pin,save_record:true})).resolves.toMatchObject({result:{returned_count:125},receipt:{status:'private_result_ready'}});
  expect(jest.mocked(storeDirectResult).mock.calls[0][5].rows).toHaveLength(100);
});
it.each([
  { data:{ tables:[] }, result:{ returned_count:0, coverage:expect.stringContaining('can be partial') } },
  { data:{ tables:[{ name:'unknown_schema' }], count:0 }, result:undefined },
])('does not conflate an unrecognized result with a verified empty inventory ($data)', async ({ data, result }) => {
  const f = fixture('supabase', 'SUPABASE_LIST_TABLES');
  jest.mocked(executeDirectTool).mockImplementationOnce(async (_t,_c,_s,_p,before) => { await before(); return { data }; });
  const out = await f.run.call(f.name, f.pin);
  if (result) expect(out).toHaveProperty('result', result);
  else {
    expect(out).toMatchObject({ success:true, result_omitted:true });
    expect(out).not.toHaveProperty('result');
  }
  expect(out).not.toHaveProperty('receipt');
  expect(storeDirectResult).not.toHaveBeenCalled();
});
it('preserves an authorized provider result when an optional save fails, without retrying the provider', async () => {
  const f = fixture();
  jest.mocked(executeDirectTool).mockImplementationOnce(async (_t,_c,_s,_p,before) => { await before(); return { data:{ count:3 } }; });
  jest.mocked(storeDirectResult).mockRejectedValueOnce(new ConnectorError('DIRECT_RESULT_UNCONFIRMED',f.key,503));
  const out = await f.run.call(f.name, {...f.pin,save_record:true});
  expect(out).toMatchObject({success:true,result:{count:3},record_status:'unconfirmed'});
  expect(out).not.toHaveProperty('receipt');
  expect(JSON.stringify(out)).not.toContain(f.key);
  expect(storeDirectResult).toHaveBeenCalledTimes(1);
  expect(confirmDirectResultRelease).toHaveBeenCalledWith(f.claim);
  expect(executeDirectTool).toHaveBeenCalledTimes(1);
});
it.each(['ACCESS_CHANGED','DIRECT_RESULT_UNCONFIRMED'])('withholds the tool result for an unconfirmed release (%s)', async code => {
  const f = fixture();
  jest.mocked(executeDirectTool).mockImplementationOnce(async (_t,_c,_s,_p,before) => { await before(); return { data:{ count:3 } }; });
  jest.mocked(confirmDirectResultRelease).mockRejectedValueOnce(new ConnectorError(code,f.key,503));
  const error = await f.run.call(f.name, f.pin).catch(failureForAgent);
  expect(error).toMatchObject({ success:false, code, automatic_retry:false });
  expect(error).not.toHaveProperty('result');
  expect(error).not.toHaveProperty('executed');
  expect(JSON.stringify(error)).not.toContain(f.key);
  expect(executeDirectTool).toHaveBeenCalledTimes(1);
});
it('rejects a nonboolean save option before admission or dispatch', async () => {
  const f = fixture();
  const failure = await f.run.call(f.name,{...f.pin,save_record:f.key}).catch(failureForAgent);
  expect(failure).toMatchObject({success:false,executed:false,code:'INVALID_TOOL_ARGUMENTS',argument_issue:{path:'save_record',rule:'type',expected:'boolean'}});
  expect(JSON.stringify(failure)).not.toContain(f.key);
  for(const dep of [authorizeDirectAction,claimDirectDispatch,executeDirectTool,storeDirectResult,confirmDirectResultRelease]) expect(dep).not.toHaveBeenCalled();
});
it.each([['before','direct epoch'],['after','direct epoch'],['before','policy'],['after','policy']])('rejects a change %s external dispatch (%s)',async (when,field)=>{
  const f=fixture(),step=jest.mocked(authorizeDirectAction);
  step.mockResolvedValueOnce(f.target);
  if(when==='after') step.mockResolvedValueOnce(f.target);
  step.mockResolvedValue(field==='direct epoch' ? {...f.target,directProof:{...f.target.directProof,directRevision:5}} :
    {...f.target,policy:{...f.target.policy,revision:2}});
  const e=await f.run.call(f.name,f.pin).catch(e=>e);
  if (when==='before') {expect(e).toMatchObject({code:'ACCESS_CHANGED',executed:false});expect(claimDirectDispatch).not.toHaveBeenCalled();}
  else {expect(e).toMatchObject({code:'ACCESS_CHANGED'});expect(e).not.toHaveProperty('executed');}
  expect(f.posts()).toBe(when==='before'?0:1);expect(storeDirectResult).not.toHaveBeenCalled();expect(confirmDirectResultRelease).not.toHaveBeenCalled();
});
it('propagates a duplicate durable reservation without dispatch or a claim that the original never executed',async()=>{
  const f=fixture();jest.mocked(claimDirectDispatch).mockRejectedValue(new ConnectorError('DIRECT_DISPATCH_ALREADY_CLAIMED','Already reserved',409));
  const err=await f.run.call(f.name,{...f.pin,save_record:true}).catch(e=>e);const failure=failureForAgent(err);
  expect(f.posts()).toBe(0);expect(failure.recovery.action).toBe('reconcile');expect(failure).not.toHaveProperty('executed');expect(failure.automatic_retry).toBe(false);
  expect(storeDirectResult).not.toHaveBeenCalled();
});
it('cannot rerun a completed provider call by changing only the save option', async () => {
  const f=fixture();
  jest.mocked(claimDirectDispatch).mockResolvedValueOnce(f.claim)
    .mockRejectedValueOnce(new ConnectorError('DIRECT_DISPATCH_ALREADY_CLAIMED','Already reserved',409));
  await expect(f.run.call(f.name,f.pin)).resolves.toMatchObject({success:true});
  await expect(f.run.call(f.name,{...f.pin,save_record:true})).rejects.toMatchObject({code:'DIRECT_DISPATCH_ALREADY_CLAIMED'});
  expect(jest.mocked(claimDirectDispatch).mock.calls[1]).toEqual(jest.mocked(claimDirectDispatch).mock.calls[0]);
  expect(f.posts()).toBe(1);
  expect(storeDirectResult).not.toHaveBeenCalled();
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