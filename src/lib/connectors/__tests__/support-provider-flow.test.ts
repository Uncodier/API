import { randomUUID } from 'node:crypto';
import { executeSupportConnectorTool } from '../support-runtime';
import { supportConnectorTool, type SupportConnectorScope } from '../support-runtime-contract';
import { candidateWindow, supportInventory, authorizeSupportAction, PUBLIC_TOOL, publicDescription } from '../support-runtime-access';
import { getReviewedTool } from '../reviewed-tools';
import { loadConnectorCredential } from '../access';
import { requestProposal } from '../approval-store';
import { accountFixture, connectorFixture, jsonResponse, providerFixture, secret, toolFixture } from './composio-fixtures';

// Stub storage and the network boundary, not discovery, describe, schema checks,
// schema pinning, publication projection or private proposal validation.
jest.mock('../support-runtime-access', () => ({ ...jest.requireActual('../support-runtime-access'),
  candidateWindow: jest.fn(), supportInventory: jest.fn(), authorizeSupportAction: jest.fn() }));
jest.mock('../access', () => ({loadConnectorCredential: jest.fn()}));
jest.mock('../approval-store', () => ({requestProposal: jest.fn()}));
jest.mock('@/lib/database/supabase-client', () => ({supabaseAdmin: {}}));

const siteId = randomUUID(), agentId = randomUUID(), connectorId = randomUUID();
const scope: SupportConnectorScope = { audience: 'anonymous', siteId, agentId, conversationId: randomUUID(), idempotencyKey: randomUUID() };
const host = { siteId, agentId, resolve: async () => scope };
const run = (args: object) => executeSupportConnectorTool(host, supportConnectorTool.name, args);
const label = 'Label_190';
const operation = getReviewedTool('GMAIL_FETCH_EMAILS');
const toolkit = { ...toolFixture(), scopes: operation.requiredScopes, input_parameters: { type: 'object', properties: {
  user_id: { type: 'string' }, label_ids: {type:'array',items:{type:'string'}}, max_results: {type:'integer'},
  ids_only:{type:'boolean'}, verbose:{type:'boolean'},include_payload:{type:'boolean'},include_spam_trash:{type:'boolean'},
} } };
const fetchMock = jest.spyOn(global, 'fetch');
beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected offline request'));
  jest.mocked(candidateWindow).mockResolvedValue([{ id: connectorId }]);
  jest.mocked(supportInventory).mockReturnValue(async () => ({ tools: [{ ...operation, slug: PUBLIC_TOOL, description: publicDescription }], label: undefined }));
  const provider = { ...providerFixture(), site_id: siteId };
  const connector = { ...connectorFixture(), site_id: siteId, id: connectorId, granted_scopes: operation.requiredScopes };
  jest.mocked(authorizeSupportAction).mockResolvedValue({access:{ provider, connector, policy:{ require_approval:true, allowed_tools:[operation.slug], allowed_hosts:['assistant'] } },
    tool:operation, publication:{ labelId:label, revision:1, audience:'anonymous' }});
  jest.mocked(loadConnectorCredential).mockResolvedValue({ apiKey:secret(), source:'byok', revision:provider.credential_revision });
});
afterAll(() => fetchMock.mockRestore());

test('a stale authenticated continuation can restart discovery; no raw diagnostics or provider requests', async () => {
  const member = { ...scope, audience:'member' as const, userId:randomUUID() };
  const runMember = (args: object) => executeSupportConnectorTool({...host,resolve:async () => member},supportConnectorTool.name,args);
  const entries = Array.from({length:8},(_,i) => ({...operation,slug:`MAIL_${i}`}));
  const eligible = jest.fn(async () => ({label:'Office',tools:entries}));
  jest.mocked(supportInventory).mockReturnValue(eligible);
  const query = {action:'list',connector_id:connectorId};
  const first = await runMember(query);
  if (!('next_cursor' in first) || !first.next_cursor) throw new Error('Missing continuation');
  eligible.mockResolvedValue({label:'Office',tools:entries.slice(0,2)});
  expect(await runMember({...query,cursor:first.next_cursor})).toEqual({success:false,status:'stale_cursor',hint:'Repeat the search or list without the cursor.'});
  const restarted = await runMember(query);
  expect(restarted).toMatchObject({success:true,next_cursor:null});
  expect('tools' in restarted && restarted.tools?.length).toBe(2);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(['pending','schema changed','extra scope','describe failure'] as const)('anonymous search → real pinned REST metadata → private request only: %s', async scenario => {
  const found = await run({action:'search',query:'avisos publicados'});
  expect(found).toMatchObject({tools:[{name:`connector:${connectorId}:${PUBLIC_TOOL}`}]});
  expect(fetchMock).not.toHaveBeenCalled();
  if (!('tools' in found) || !found.tools?.[0]?.name) throw new Error('Missing search result');
  const { name } = found.tools[0];
  fetchMock.mockResolvedValueOnce(jsonResponse(toolkit));
  const d = await run({action:'describe',name});
  expect(d).toMatchObject({parameters:{type:'object',properties:{},additionalProperties:false},require_approval:true});
  if (!('schema_hash' in d)) throw new Error('Missing descriptor');
  const versioned = scenario === 'schema changed' ? {...toolkit,input_parameters:{...toolkit.input_parameters,description:'updated'}} : toolkit;
  const current = scenario === 'extra scope' ? {...versioned, scopes:[...operation.requiredScopes, 'new.scope']} : versioned;
  fetchMock.mockResolvedValueOnce(jsonResponse(current, scenario === 'describe failure' ? 503 : 200));
  jest.mocked(requestProposal).mockResolvedValue({status:'pending'});
  const result = await run({action:'call',name,version:d.version,schema_hash:d.schema_hash,arguments:{}});
  expect(fetchMock.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(0);
  if (scenario === 'pending') {
    expect(result).toEqual({success:true,status:'pending'});
    expect(requestProposal).toHaveBeenCalledWith(expect.objectContaining({siteId,agentId}),expect.objectContaining({
      arguments:{label_ids:[label],max_results:5,ids_only:false,verbose:false,include_payload:false,include_spam_trash:false}}));
  } else {
    expect(result).toEqual({success:false,status:'unavailable'}); expect(requestProposal).not.toHaveBeenCalled();
  }
});


test.each(['completed','scope removed','provider failure'] as const)('explicit publication still enforces provider scope and projects titles only: %s', async scenario => {
  const authorized = await authorizeSupportAction(scope,connectorId,PUBLIC_TOOL);
  authorized.access.policy.require_approval = false;
  const name = `connector:${connectorId}:${PUBLIC_TOOL}`;
  fetchMock.mockResolvedValueOnce(jsonResponse(toolkit));
  const d = await run({action:'describe',name});
  expect(d).toMatchObject({require_approval:false});
  if (!('schema_hash' in d)) throw new Error('Missing descriptor');
  const account = accountFixture();
  const response = {successful:true,error:null,data:{messages:[{labelIds:[label],subject:'November hours',sender:'private',snippet:'private'}]}};
  fetchMock.mockResolvedValueOnce(jsonResponse(toolkit)).mockResolvedValueOnce(jsonResponse(toolkit))
    .mockResolvedValueOnce(jsonResponse({...account,state:{val:{scope:scenario === 'scope removed' ? '' : operation.requiredScopes.join(' ')}}}))
    .mockResolvedValueOnce(jsonResponse(response,scenario === 'provider failure' ? 503 : 200));
  const result = await run({action:'call',name,version:d.version,schema_hash:d.schema_hash,arguments:{}});
  const posts = fetchMock.mock.calls.filter(([,init]) => init?.method === 'POST');
  expect(posts).toHaveLength(scenario === 'scope removed' ? 0 : 1);
  if (posts[0]) expect(JSON.parse(String(posts[0][1]?.body))).toEqual({connected_account_id:account.id,user_id:account.user_id,version:toolkit.version,
    arguments:{user_id:'me',label_ids:[label],max_results:5,ids_only:false,verbose:false,include_payload:false,include_spam_trash:false}});
  expect(result).toEqual(scenario === 'completed' ? {success:true,status:'completed',result:{titles:['November hours'],limited:false}} : {success:false,status:'unavailable'});
  expect(requestProposal).not.toHaveBeenCalled();
});
