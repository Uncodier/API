import { hostedAskCompatibility, requireHostedAskCompatibility } from '../ask-compatibility';
import { getToolkit } from '../composio-catalog';
import { projectToolkit } from '../catalog-service';
import { accountFixture, connectorFixture, providerFixture, toolkitFixture } from './composio-fixtures';

const from=jest.fn(), visible=jest.fn(), bound=jest.fn(), current=jest.fn(), request=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{from:(...args:unknown[])=>from(...args)}}));
jest.mock('../account-access',()=>({...jest.requireActual('../account-access'),getVisibleConnector:(...args:unknown[])=>visible(...args)}));
jest.mock('../connection-service',()=>({providerClient:(...args:unknown[])=>bound(...args),requireCurrentProviderProof:(...args:unknown[])=>current(...args)}));
const c=connectorFixture(), provider=providerFixture(), site=c.site_id, manager='manager';
const attempt={ setup_mode:'hosted',user_id:c.created_by,provider_id:c.provider_id,credential_revision:provider.credential_revision,
  toolkit_slug:c.toolkit_slug,auth_config_id:c.auth_config_id,provider_account_id:c.provider_account_id };
const check=()=>hostedAskCompatibility(site,manager,c.id);
function rows(data:unknown,error?:unknown){
  const query={ select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),neq:jest.fn().mockReturnThis(),
    limit:jest.fn().mockReturnThis(), abortSignal:jest.fn().mockResolvedValue({data,error}) };
  from.mockReturnValue(query);return query;
}
function exact(scheme:string,patch:Record<string,unknown>={}) {
  return {...accountFixture(),state:{authScheme:scheme,val:{}},...patch};
}
beforeEach(()=>{
  jest.resetAllMocks();rows([attempt]);visible.mockResolvedValue(c);
  bound.mockResolvedValue({provider,client:{request}});
});
it.each([['hosted_credentials','API_KEY'],['hosted','OAUTH2']])('only labels %s compatible after exact private-account and binding checks',async(mode,scheme)=>{
  const q=rows([{...attempt,setup_mode:mode}]);
  request.mockResolvedValueOnce(toolkitFixture()).mockResolvedValueOnce(exact(scheme));
  expect(await check()).toEqual({ask_compatible:true});
  expect(from).toHaveBeenCalledWith('site_connector_auth_attempts');expect(q.eq.mock.calls).toEqual([['site_id',site],['connector_id',c.id],['status','completed']]);
  expect(q.neq).toHaveBeenCalledWith('setup_mode','legacy');expect(q.limit).toHaveBeenCalledWith(2);
  expect(visible).toHaveBeenCalledWith(site,manager,c.id);expect(bound).toHaveBeenCalledWith(c);
  expect(request.mock.calls).toEqual([[`/toolkits/${c.toolkit_slug}`],[`/connected_accounts/${c.provider_account_id}`]]);
  expect(current).toHaveBeenCalledWith(c,provider);
});
it.each(['OAUTH1','DCR_OAUTH','BASIC','BASIC_WITH_JWT','BEARER_TOKEN','NO_AUTH','unknown'])('does not offer Ask for a verified account using %s',async scheme=>{
  request.mockResolvedValueOnce(toolkitFixture()).mockResolvedValueOnce(exact(scheme));
  expect(await check()).toEqual({ask_compatible:false,ask_incompatibility:'auth_scheme'});
});
it('identifies MCP both before sign-in and on the exact saved account, without looking up credentials for an MCP action',async()=>{
  const mcp={...toolkitFixture(),toolkit_type:'mcp'};
  request.mockResolvedValue(mcp);
  expect(projectToolkit(await getToolkit({request},c.toolkit_slug),[]).toolkit_type).toBe('mcp');
  expect(await check()).toEqual({ask_compatible:false,ask_incompatibility:'toolkit'});
  expect(request.mock.calls).toEqual([[`/toolkits/${c.toolkit_slug}`],[`/toolkits/${c.toolkit_slug}`]]);
});
it.each([{user_id:'wrong'}, {id:'wrong'}, {auth_config:{id:'wrong',is_disabled:false}}, {experimental:{account_type:'SHARED'}},
  {experimental:undefined},{state:undefined},{status:'EXPIRED'}, {toolkit:{slug:'wrong'}}])('rejects an unverified exact provider identity (%j)',async patch=>{
  request.mockResolvedValueOnce(toolkitFixture()).mockResolvedValueOnce(exact('OAUTH2',patch));
  expect(await check()).toEqual({ask_compatible:null,ask_incompatibility:'unverified'});
});
it('preserves legacy status and does not declassify stale or ambiguous hosted attribution as legacy',async()=>{
  rows([]);expect(await check()).toBeUndefined();
  rows([attempt,attempt]);expect(await check()).toEqual({ask_compatible:null,ask_incompatibility:'unverified'});
  for(const key of ['user_id','provider_id','toolkit_slug','auth_config_id','provider_account_id','credential_revision']) {
    rows([{...attempt,[key]:'wrong'}]);await expect(requireHostedAskCompatibility(site,manager,c.id)).rejects.toMatchObject({code:'ASK_INCOMPATIBLE'});
  }
  expect(request).not.toHaveBeenCalled();
});
it('does not treat a storage failure as legacy; provider failures or rotation do not leak details or allow enable',async()=>{
  rows(null,{code:'42501'});await expect(check()).rejects.toMatchObject({code:'ACCESS_DENIED'});
  rows([attempt]);request.mockRejectedValueOnce(Error('private provider detail'));
  expect(await check()).toEqual({ask_compatible:null,ask_incompatibility:'unverified'});
  request.mockResolvedValueOnce(toolkitFixture()).mockResolvedValueOnce(exact('OAUTH2'));current.mockRejectedValue(Error('rotated'));
  await expect(requireHostedAskCompatibility(site,manager,c.id)).rejects.toMatchObject({code:'ASK_INCOMPATIBLE'});
});
it('keeps Supabase OAuth separate from pre-existing project-token authority',async()=>{
  visible.mockResolvedValue({...c,toolkit_slug:'supabase'});rows([{...attempt,toolkit_slug:'supabase'}]);
  expect(await check()).toEqual({ask_compatible:false,ask_incompatibility:'project_token_required'});
  rows([]);expect(await check()).toBeUndefined();expect(bound).not.toHaveBeenCalled();
});

it('treats a toolkit without positive API type evidence as unknown, not compatible',async()=>{
  request.mockResolvedValueOnce({...toolkitFixture(),toolkit_type:undefined});
  expect(await check()).toEqual({ask_compatible:null,ask_incompatibility:'unverified'});
});
