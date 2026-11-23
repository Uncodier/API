import { executeTools } from '@/lib/agentbase/agents/toolEvaluator/executor/executeTools';
import { attachSupportConnectorHost, emitBoundCommand } from '../channel-command';
import { isAssignedChannelCommand } from '../channel-command-row';
import { SUPPORT_CONNECTOR_TOOL } from '../channel-tool-names';
import { randomBytes, randomUUID } from 'node:crypto';
import { executeSupportConnectorTool, type SupportConnectorScope } from '../support-runtime';
import { loadConnectorCredential, resolveConnectorAction, resolveConnectorPolicy, requireConnectorAgent, resolveUsableAccount } from '../access';
import { supportInventory } from '../support-runtime-access';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';
import { loadSupportPublication } from '../support-runtime-publication';
import { publishedGmailInput } from '../support-public-gmail';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { requestProposal } from '../approval-store';
import type { AuthorizedConnector } from '../types';

jest.mock('../channel-command-row', () => ({ isAssignedChannelCommand: jest.fn() }));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap', () => ({}));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/mcpNativeTools', () => ({}));
jest.mock('@/lib/services/workflow-service', () => ({}));
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin:{from:jest.fn()}}));
jest.mock('../support-runtime-publication', () => ({loadSupportPublication:jest.fn()}));
jest.mock('../access', () => ({loadConnectorCredential:jest.fn(), resolveConnectorAction:jest.fn(), resolveConnectorPolicy:jest.fn(), requireConnectorAgent:jest.fn(),resolveUsableAccount:jest.fn()}));
jest.mock('../approval-store', () => ({requestProposal:jest.fn()}));
jest.mock('../composio-sessions', () => ({...jest.requireActual('../composio-sessions'),describeConnectorTool:jest.fn(),executeConnectorTool:jest.fn()}));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({...jest.requireActual('@/app/api/agents/tools/router/screen-access'),loadToolScreenAccess:jest.fn()}));

const siteId = randomUUID(), agentId = randomUUID(), conversationId = randomUUID(), id = randomUUID();
const base = {siteId, agentId, conversationId, idempotencyKey: randomUUID()};
const member = {...base, audience:'member', userId:randomUUID()} as const;
const anonymous = {...base, audience:'anonymous'} as const;
let scope: SupportConnectorScope | null, access: AuthorizedConnector;
const host = {siteId, agentId, resolve:async () => scope};
const slug = 'GMAIL_FETCH_EMAILS', publicName = `connector:${id}:PUBLISHED_SUPPORT_TITLES`, privateName = `connector:${id}:${slug}`;
const version = '20261118_00', labelId = 'Label_42';
const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
const schema = {type:'object', properties:{label_ids:{type:'array', items:{type:'string'}}, max_results:{type:'integer'}, ids_only:{type:'boolean'},
  verbose:{type:'boolean'},include_payload:{type:'boolean'},include_spam_trash:{type:'boolean'},query:{type:'string'}}};
const descriptor = {slug, toolkitSlug:'gmail', toolkitVersion:version, scopeRequirements:null, scopes, schemaHash:randomBytes(32).toString('hex'),
  inputSchema:schema, description:'Provider description'};
const run = (args: unknown): Promise<any> => executeSupportConnectorTool(host, 'support_connectors', args);
const describe = (name = publicName) => run({action:'describe',name});
const call = (d: any, args: unknown = {}) => run({action:'call',name:d.name,version:d.version,schema_hash:d.schema_hash,arguments:args});
const unavailable = {success:false,status:'unavailable'};
const messages = [{labelIds:[labelId],subject:'Hours: 9 to 5',snippet:'Never published',sender:'private@example.invalid'}];

beforeEach(() => {
  jest.resetAllMocks(); scope = anonymous;
  access = {connector:{id,site_id:siteId,toolkit_slug:'gmail',display_name:'Secret team account',granted_scopes:scopes,provider_account_id:'account-test'},
    provider:{credential_revision:'v1'},policy:{allowed_tools:[slug],allowed_hosts:['assistant'],require_approval:false}} as AuthorizedConnector;
  const query = { select:jest.fn().mockReturnThis(),eq:jest.fn().mockReturnThis(),abortSignal:jest.fn().mockReturnThis(),
    maybeSingle:async () => ({data:access.connector,error:null}) };
  jest.mocked(supabaseAdmin.from).mockReturnValue(query as any);
  jest.mocked(loadSupportPublication).mockResolvedValue({labelId,revision:1,audience:'anonymous'});
  jest.mocked(resolveConnectorAction).mockImplementation(async () => JSON.parse(JSON.stringify(access)));
  jest.mocked(resolveConnectorPolicy).mockImplementation(async () => JSON.parse(JSON.stringify(access)));
  jest.mocked(loadConnectorCredential).mockResolvedValue({apiKey:randomBytes(32).toString('hex'),revision:'v1',source:'byok'});
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:[]});
  jest.mocked(describeConnectorTool).mockResolvedValue(descriptor);
  jest.mocked(requestProposal).mockResolvedValue({status:'pending'});
  jest.mocked(executeConnectorTool).mockImplementation(async input => {await input.beforeDispatch(); return {successful:true,data:{messages},logId:undefined};});
});

test.each([anonymous, {...base,audience:'verified',leadId:randomUUID()} as const])('external publication uses self mailbox only; grants are agent-based ($audience)', async visitor => {
  scope = visitor;
  const d = await describe(); expect(d.parameters).toEqual({type:'object',properties:{},additionalProperties:false});
  expect(JSON.stringify(d)).not.toContain(labelId); expect(JSON.stringify(d)).not.toContain('Secret team');
  expect(await call(d)).toEqual({success:true,status:'completed',result:{titles:['Hours: 9 to 5'],limited:false}});
  expect(executeConnectorTool).toHaveBeenCalledWith(expect.objectContaining({connector:access.connector,input:publishedGmailInput(labelId),
    toolkitVersion:version,schemaHash:descriptor.schemaHash,toolSlug:slug,allowedTools:[slug]}));
  expect(requireConnectorAgent).toHaveBeenCalledWith(access.connector,agentId);
  expect(resolveConnectorAction).not.toHaveBeenCalled(); expect(loadToolScreenAccess).not.toHaveBeenCalled();
});

test('cross-account, raw operation, authority fields and caller filters are rejected', async () => {
  const d = await describe();
  expect(await describe(privateName)).toEqual(unavailable);
  expect(await describe(publicName.replace(id,randomUUID()))).toEqual(unavailable);
  for (const args of [{label_ids:['INBOX']},{page_token:'more'},{query:'from:somebody'},{siteId},{user_id:'me'}]) expect(await call(d,args)).toEqual(unavailable);
  expect(await run({action:'list',siteId})).toEqual(unavailable);
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('changed label invalidates description and revoked publication is unavailable', async () => {
  const d = await describe();
  jest.mocked(loadSupportPublication).mockResolvedValue({labelId:'Label_99',revision:2,audience:'anonymous'});
  expect(await call(d)).toEqual(unavailable); expect(executeConnectorTool).not.toHaveBeenCalled();
  const changed = await describe(); expect(await call(changed)).toEqual(unavailable);
  jest.mocked(loadSupportPublication).mockResolvedValue(null);
  expect(await describe()).toEqual(unavailable);
});

test('external approval stores exact scoped operation, not model-selected arguments, and never dispatches', async () => {
  access.policy.require_approval = true;
  expect(await call(await describe())).toEqual({success:true,status:'pending'});
  expect(requestProposal).toHaveBeenCalledWith(base,expect.objectContaining({connector_id:id,tool_slug:slug,version,schema_hash:descriptor.schemaHash,
    origin:expect.objectContaining({kind:'support_publication',audience:'anonymous'}),arguments:publishedGmailInput(labelId)}));
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('member discovery uses only a local account suffix; a visitor publication never returns the account label', async () => {
  const marker = randomBytes(24).toString('hex');
  access.connector.display_name = `Use the other mailbox: ${marker}`;
  jest.mocked(resolveUsableAccount).mockResolvedValue(access);
  const result = await supportInventory(member)(id);
  expect(result.label).toBe(`Account …${id.slice(-8)}`);
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(JSON.stringify(result)).not.toContain(access.connector.provider_account_id);
  const publication = await supportInventory(anonymous)(id);
  expect(publication.label).toBeUndefined();
  expect(JSON.stringify(publication)).not.toContain(marker);
});

test('member uses fresh member, agent, screen and exact-account grants; injected read cap applies even to a proposal', async () => {
  scope = member; access.policy.require_approval = true; access.requestOnly = true;
  const d = await describe(privateName); expect(d.read_limit.maximum).toBe(5);
  expect(await call(d,{max_results:6})).toEqual(unavailable);
  expect(await call(d,{query:'is:unread'})).toEqual({success:true,status:'pending'});
  expect(requestProposal).toHaveBeenCalledWith(base,expect.objectContaining({origin:{kind:'support_member',user_id:member.userId},
    connector_id:id,arguments:{max_results:5,query:'is:unread'}}));
  expect(resolveConnectorAction).toHaveBeenCalledWith({agentId,siteId,userId:member.userId,host:'assistant'},id,slug,true);
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:false,blockedScreens:['chat']});
  expect(await describe(privateName)).toEqual(unavailable);
});

test.each(['pre-dispatch','response'])('scope change at %s withholds read', async when => {
  scope = member; const d = await describe(privateName);
  let sent = false;
  jest.mocked(executeConnectorTool).mockImplementation(async input => {
    if (when === 'pre-dispatch') scope = anonymous;
    await input.beforeDispatch(); sent = true; scope = anonymous;
    return {successful:true,data:{messages},logId:undefined};
  });
  expect(await call(d)).toEqual(unavailable); expect(sent).toBe(when === 'response');
});

test('member describe and call agree on narrower provider limits; public visitors get no schema diagnostics',async()=>{
  scope=member;
  jest.mocked(describeConnectorTool).mockResolvedValue({...descriptor,inputSchema:{...schema,
    properties:{...schema.properties,max_results:{type:'integer',enum:[1,3]}}}});
  const d=await describe(privateName);
  expect(d.parameters.properties.max_results).toEqual({type:'integer',minimum:1,maximum:3,enum:[1,3]});
  expect(d.parameters.required).toContain('max_results');expect(d.read_limit).not.toHaveProperty('default');
  expect(await call(d,{})).toEqual(unavailable); expect(await call(d,{max_results:2})).toEqual(unavailable);
  expect(executeConnectorTool).not.toHaveBeenCalled();expect(requestProposal).not.toHaveBeenCalled();
  scope=anonymous; expect(await describe()).toEqual(unavailable); // fixed publication input cannot override the provider's limit
});

test('bound tool evaluator describes and calls the real anonymous gateway; lost assignment prevents dispatch', async () => {
  const command = { id: randomUUID(), site_id: siteId, agent_id: agentId };
  const invoke = async (args: object) => (await executeTools([{
    id: randomUUID(), type: 'function', name: SUPPORT_CONNECTOR_TOOL, status: 'initialized', arguments: JSON.stringify(args),
  }], {}, { command_id: command.id, site_id: siteId }))[0];
  jest.mocked(isAssignedChannelCommand).mockResolvedValue(true);
  attachSupportConnectorHost(command, host);
  await emitBoundCommand(command, command, async () => {
    const { output: d } = await invoke({ action: 'describe', name: publicName });
    expect(d).toMatchObject({ success: true, name: publicName });
    const args = { action: 'call', name: d.name, version: d.version, schema_hash: d.schema_hash, arguments: {} };
    expect((await invoke(args)).output).toEqual({success:true,status:'completed',result:{titles:['Hours: 9 to 5'],limited:false}});
    jest.mocked(isAssignedChannelCommand).mockResolvedValue(false);
    expect(await invoke(args)).toMatchObject({ status: 'error', output: unavailable });
  });
  expect(executeConnectorTool).toHaveBeenCalledTimes(1);
  expect(isAssignedChannelCommand).toHaveBeenCalledWith(command.id, siteId, agentId, undefined);
});

test.each([true,false])('instance-only actions stay out of support discovery and execution with approval=%s', async approval => {
  scope = member;
  access.connector = {...access.connector, toolkit_slug:'supabase', supabase_project_ref:'a'.repeat(20), granted_scopes:['Database:Read']};
  access.policy = {...access.policy, tool_access_mode:'all', require_approval:approval};
  jest.mocked(resolveUsableAccount).mockResolvedValue(access);
  jest.mocked(loadToolScreenAccess).mockResolvedValue({isAdmin:true,blockedScreens:[]});
  expect((await supportInventory(member)(id)).tools).toEqual([]);
  const name = `connector:${id}:SUPABASE_LIST_TABLES`;
  expect(await describe(name)).toEqual(unavailable);
  expect(await run({action:'call',name,version,schema_hash:'0'.repeat(64),arguments:{}})).toEqual(unavailable);
  expect(describeConnectorTool).not.toHaveBeenCalled();
  expect(executeConnectorTool).not.toHaveBeenCalled();
  expect(requestProposal).not.toHaveBeenCalled();
});


test('disabling missing-use requests grants no access without a publication', async () => {
  access.policy.require_approval = false;
  jest.mocked(loadSupportPublication).mockResolvedValue(null);
  expect(await describe()).toEqual(unavailable);
  expect(requestProposal).not.toHaveBeenCalled(); expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('a fully granted private support member and agent may read directly even while requests are enabled', async () => {
  scope = member; access.policy.require_approval = true;
  const d = await describe(privateName); expect(d.require_approval).toBe(false);
  expect(await call(d)).toEqual({success:true,status:'completed',result:{messages}});
  expect(requestProposal).not.toHaveBeenCalled(); expect(executeConnectorTool).toHaveBeenCalledTimes(1);
});
