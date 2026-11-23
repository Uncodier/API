import {randomUUID} from 'node:crypto';
import {authorizeGenericSupport,optionalGenericSupport} from '../support-generic-authority';
import {getMemberGrant,getVisibleConnector,loadConnectorCredential} from '../account-access';
import {loadToolScreenAccess} from '@/app/api/agents/tools/router/screen-access';
import {readTokenProviderBinding} from '../provider-project-binding';
import {connectorFixture,providerFixture,secret} from './composio-fixtures';

const mockRpc=jest.fn();
jest.mock('@/lib/database/supabase-client',()=>({supabaseAdmin:{rpc:(...v:unknown[])=>mockRpc(...v)}}));
jest.mock('../account-access',()=>({getVisibleConnector:jest.fn(),getMemberGrant:jest.fn(),loadConnectorCredential:jest.fn()}));
jest.mock('../provider-project-binding',()=>({readTokenProviderBinding:jest.fn()}));
jest.mock('@/app/api/agents/tools/router/screen-access',()=>({...jest.requireActual('@/app/api/agents/tools/router/screen-access'),loadToolScreenAccess:jest.fn()}));
const scope={siteId:randomUUID(),agentId:randomUUID(),userId:randomUUID(),conversationId:randomUUID(),audience:'member' as const,idempotencyKey:'turn'};
const id=randomUUID(), provider={...providerFixture(),id:randomUUID(),site_id:scope.siteId,provider_user_id:scope.siteId};
const c={...connectorFixture(),id,site_id:scope.siteId,toolkit_slug:'salesdesk',access_mode:'explicit' as const,created_by:scope.userId,provider_id:provider.id,supabase_project_ref:null,revocation_dispatched:false};
const slug='SALESDESK_LIST_INVOICES', row={required_screens:['leads'],attestation_id:randomUUID(),expires_at:new Date(Date.now()+3600000).toISOString(),connector:c,provider,direct_revision:2,local_installation_ref:null,resource_boundary:'site-inventory',policy:{tool_access_mode:'selected',allowed_tools:[slug],allowed_hosts:['assistant'],revision:1,require_approval:true}};
const reply=(data:unknown)=>({abortSignal:async()=>({data,error:null})});
beforeEach(()=>{jest.resetAllMocks();jest.mocked(getVisibleConnector).mockResolvedValue(c);jest.mocked(getMemberGrant).mockResolvedValue({user_id:scope.userId,can_use:true,can_view:true,revoked_at:null,expires_at:null});
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:true,blockedScreens:[]});jest.mocked(loadConnectorCredential).mockResolvedValue({source:'byok',revision:provider.credential_revision,apiKey:secret()});
  jest.mocked(readTokenProviderBinding).mockResolvedValue({projectId:provider.project_id});mockRpc.mockReturnValue(reply([row]));});
it('requires both member and assigned agent use; preserves the exact account and action',async()=>{
  const access=await authorizeGenericSupport(scope,id,slug);
  expect(access.target.connector.id).toBe(id);expect(access.releaseMemberResult).toBe(true);
  expect(mockRpc).toHaveBeenCalledWith('connector_support_agent_account_v2',{p_site_id:scope.siteId,p_agent_id:scope.agentId,p_connector_id:id,p_slug:slug});
});
it.each(['agent','screen','member','site','selected','expiry','credential','project'])('rejects stale or mismatched %s before dispatch',async cause=>{
  if(cause==='agent')mockRpc.mockReturnValue(reply([]));
  if(cause==='screen')jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:['leads']});
  if(cause==='member')jest.mocked(getMemberGrant).mockResolvedValue({user_id:scope.userId,can_use:false,can_view:false,revoked_at:null,expires_at:null});
  if(cause==='site')mockRpc.mockReturnValue(reply([{...row,connector:{...c,site_id:randomUUID()}}]));
  if(cause==='selected')mockRpc.mockReturnValue(reply([{...row,policy:{...row.policy,allowed_tools:['SALESDESK_ANOTHER']}}]));
  if(cause==='expiry')mockRpc.mockReturnValue(reply([{...row,expires_at:new Date(0).toISOString()}]));
  if(cause==='credential')jest.mocked(loadConnectorCredential).mockResolvedValue({source:'byok',revision:secret(),apiKey:secret()});
  if(cause==='project')mockRpc.mockReturnValue(reply([{...row,connector:{...c,supabase_project_ref:'a'.repeat(20)},local_installation_ref:'b'.repeat(20),resource_boundary:'a'.repeat(20)}]));
  await expect(authorizeGenericSupport(scope,id,slug)).rejects.toThrow();
});
it('distinguishes an absent binding from a failed authority read during discovery',async()=>{
  mockRpc.mockReturnValue(reply([]));await expect(optionalGenericSupport(scope,id)).resolves.toBeNull();
  mockRpc.mockReturnValue(reply({}));await expect(optionalGenericSupport(scope,id)).rejects.toMatchObject({code:'DIRECT_POLICY_UNAVAILABLE'});
});

it('rejects a mixed external/member scope before account access, including direct authority calls',async()=>{
  const forged={...scope,leadId:randomUUID()};
  await expect(optionalGenericSupport(forged,id)).rejects.toThrow();
  await expect(authorizeGenericSupport(forged,id,slug)).rejects.toThrow();
  expect(getVisibleConnector).not.toHaveBeenCalled();expect(mockRpc).not.toHaveBeenCalled();
});

it('requires exactly one assigned, review-enabled account; never chooses the first or uses a client account ID',async()=>{
  const {uniqueAgentReviewAccount,genericReviewTarget}=await import('../generic-review-target');
  for(const result of [[],[id,randomUUID()],[id,id],['invalid']]){
    mockRpc.mockReturnValue(reply(result));
    await expect(uniqueAgentReviewAccount(scope.siteId,scope.agentId,slug)).rejects.toMatchObject({code:'APPROVAL_UNAVAILABLE'});
  }
  mockRpc.mockReturnValue(reply([id]));expect(await uniqueAgentReviewAccount(scope.siteId,scope.agentId,slug)).toBe(id);
  expect(mockRpc).toHaveBeenLastCalledWith('connector_agent_review_candidates',{p_site_id:scope.siteId,p_agent_id:scope.agentId,p_slug:slug});
  mockRpc.mockReturnValue(reply([{...row,policy:{...row.policy,require_approval:false}}]));
  await expect(genericReviewTarget(scope.siteId,scope.agentId,id,slug)).rejects.toMatchObject({code:'APPROVAL_UNAVAILABLE'});
  mockRpc.mockReturnValue(reply([row]));
  expect((await genericReviewTarget(scope.siteId,scope.agentId,id,slug)).screens).toBeNull();
  jest.mocked(getMemberGrant).mockResolvedValue({user_id:scope.userId,can_use:false,can_view:true,expires_at:null});
  expect((await genericReviewTarget(scope.siteId,scope.agentId,id,slug,scope.userId,'requester')).target.connector.id).toBe(id);
  await expect(authorizeGenericSupport(scope,id,slug)).rejects.toMatchObject({code:'SUPPORT_UNAVAILABLE'});
  await expect(genericReviewTarget(scope.siteId,scope.agentId,id,slug,scope.userId)).rejects.toMatchObject({code:'APPROVAL_UNAVAILABLE'});
  jest.mocked(getMemberGrant).mockResolvedValue({user_id:scope.userId,can_use:true,can_view:true,expires_at:null});
  expect((await genericReviewTarget(scope.siteId,scope.agentId,id,slug,scope.userId)).target.connector.id).toBe(id);
});

it('requires ordinary agent authority and its business screens before authorizing this exact action',async()=>{
  const action='HUBSPOT_LIST_CONTACTS';
  const ordinary={authority_kind:'connected_account',authorization_id:randomUUID(),required_screens:['people','leads','deals'],
    direct_revision:1,connector:{...c,toolkit_slug:'hubspot',granted_scopes:['oauth','crm.objects.contacts.read']},provider,
    policy:{...row.policy,allowed_tools:[action]}};
  mockRpc.mockReturnValue(reply([ordinary]));
  expect((await authorizeGenericSupport(scope,id,action)).target.directProof).toMatchObject({kind:'connected_account',authorizationId:ordinary.authorization_id});
  mockRpc.mockReturnValueOnce(reply([{...ordinary,required_screens:['leads','people']}]));
  await expect(authorizeGenericSupport(scope,id,action)).rejects.toMatchObject({code:'DIRECT_POLICY_UNAVAILABLE'});
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:['deals']});
  await expect(authorizeGenericSupport(scope,id,action)).rejects.toMatchObject({code:'SUPPORT_UNAVAILABLE'});
});

it.each(['salesdesk','gmail'])('does not mistake the all-screens sentinel for a screen named *: %s',async kit=>{
  const action=kit.toUpperCase()+'_LIST_RECORDS';
  const delegated={authority_kind:'connected_account',authorization_id:randomUUID(),auth_scheme:'OAUTH2',bound_project_ref:null,
    required_screens:['*'],direct_revision:1,connector:{...c,toolkit_slug:kit,granted_scopes:[]},provider,
    policy:{...row.policy,allowed_tools:[action]}};
  mockRpc.mockReturnValue(reply([delegated]));
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:[]});
  expect((await authorizeGenericSupport(scope,id,action)).target.directProof).toMatchObject({authScheme:'OAUTH2'});
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:['leads']});
  await expect(authorizeGenericSupport(scope,id,action)).rejects.toMatchObject({code:'SUPPORT_UNAVAILABLE'});
  for(const required_screens of [[],['chat']]) {
    mockRpc.mockReturnValue(reply([{...delegated,required_screens}]));
    await expect(authorizeGenericSupport(scope,id,action)).rejects.toMatchObject({code:'DIRECT_POLICY_UNAVAILABLE'});
  }
});
