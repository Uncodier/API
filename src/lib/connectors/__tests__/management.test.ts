import { accessPatchSchema, getConnectorAccess, policyPatchSchema, updateConnectorAccess, updateConnectorPolicy } from '../management';
import { ConnectorError } from '../types';

import { secret, toolFixture } from './composio-fixtures';

const credential = jest.fn(), provider = jest.fn(), key = secret();
jest.mock('../composio-transport', () => ({ ...jest.requireActual('../composio-transport'),
  createComposioClient: (value: string) => { if (value !== key) throw Error('Wrong workspace key'); return { request: provider }; },
}));
const rpc = jest.fn();
const from = jest.fn();
const access = jest.fn();
const visible = jest.fn();
const policy = jest.fn();
const ownGrant = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: (...args: unknown[]) => rpc(...args), from: (...args: unknown[]) => from(...args) } }));
jest.mock('../access', () => ({
  ...jest.requireActual('../access'), loadConnectorCredential: (...args: unknown[]) => credential(...args), requireConnectorSiteAccess: (...args: unknown[]) => access(...args),
  getVisibleConnector: (...args: unknown[]) => visible(...args), getConnectorPolicy: (...args: unknown[]) => policy(...args), getMemberGrant: (...args: unknown[]) => ownGrant(...args),
}));
const site = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const grant = { user_id: user, can_view: true, can_use: false, expires_at: null, revoked_at: null };
const base = { site_id: site, expected_revision: 1 };
function query(data: unknown, error: unknown = null, count = Array.isArray(data) ? data.length : null) {
  const result: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error, count }).then(resolve) };
  for (const key of ['select', 'eq', 'neq', 'limit', 'abortSignal']) result[key] = jest.fn(() => result);
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  credential.mockResolvedValue({ apiKey: key });
  provider.mockReset();
  access.mockResolvedValue({ can_view: true, can_manage: true });
  visible.mockResolvedValue({ id, revision: 1, toolkit_slug: 'gmail', enabled: true, provider_status: 'ACTIVE', revocation_pending: false });
  policy.mockResolvedValue({ allowed_tools: ['GMAIL_FETCH_EMAILS'], allowed_hosts: ['assistant'], require_approval: false });
  ownGrant.mockResolvedValue(grant);
  from.mockImplementation(table => query(table === 'connector_members' ? [grant, { ...grant, user_id: other }] : []));
  rpc.mockImplementation((name: string) => query(name === 'connector_access_options'
    ? { member_options: [{ id: user, label: 'Member' }], agent_options: [] }
    : { connector_id: id, revision: 2 }));
});

it('nonmanagers receive only own effective grant metadata, never ACLs or selection options', async () => {
  access.mockResolvedValue({ can_view: true, can_manage: false });
  const result = await getConnectorAccess(site, user, id);
  expect(result.members).toEqual([grant]); expect(result.agents).toEqual([]);
  expect(result.member_options).toEqual([]); expect(result.agent_options).toEqual([]);
  expect(result.policy.allowed_tools).toEqual([]); expect(result.can_manage).toBe(false);
  expect(from).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(other);
});

it('manager access uses bounded safe columns/options but does not create any grants', async () => {
  const result = await getConnectorAccess(site, user, id);
  expect(result.members).toHaveLength(2); expect(result.can_manage).toBe(true);
  expect(rpc).toHaveBeenCalledWith('connector_access_options', { p_site_id: site, p_actor_id: user });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('access patch changes only named rows with exact actor/CAS and same-site references handled by RPC', async () => {
  const input = { ...base, members: [grant], agents: [] };
  expect(await updateConnectorAccess(user, id, input)).toEqual({ connector_id: id, revision: 2 });
  expect(rpc).toHaveBeenCalledWith('connector_update_access', { p_site_id: site, p_connector_id: id, p_actor_id: user, p_expected_revision: 1, p_members: [grant], p_agents: [] });
  rpc.mockImplementationOnce(() => query(null, { code: '23503' }));
  await expect(updateConnectorAccess(user, id, input)).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
});

it('preserves revision conflicts and denies nonmanagers before any mutation', async () => {
  const input = { ...base, members: [grant], agents: [] };
  rpc.mockImplementationOnce(() => query(null, { code: '40001' }));
  await expect(updateConnectorAccess(user, id, input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  rpc.mockClear(); access.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied.', 403));
  await expect(updateConnectorAccess(user, id, input)).rejects.toMatchObject({ status: 403 });
  expect(rpc).not.toHaveBeenCalled();
});

it('rejects implicit use, duplicate targets, empty updates, future revocation and unexpected fields', () => {
  for (const input of [
    { ...base, members: [], agents: [] },
    { ...base, members: [grant, grant], agents: [] },
    { ...base, members: [{ ...grant, can_view: false, can_use: true }], agents: [] },
    { ...base, members: [{ ...grant, role: 'admin' }], agents: [] },
    { ...base, members: [{ ...grant, revoked_at: '2999-01-01T00:00:00Z' }], agents: [] },
  ]) expect(accessPatchSchema.safeParse(input).success).toBe(false);
});

const catalogOnly = 'GMAIL_SEND_EMAIL';
const policyInput = { ...base, allowed_tools: ['GMAIL_FETCH_EMAILS', catalogOnly], allowed_hosts: ['assistant' as const], require_approval: true, enabled: true };
const row = (slug: string) => ({ ...toolFixture(), name: 'Example tool', slug });
const askChange = {enabled:true,expected_direct_revision:7};
const combinedReceipt = {connector_id:id,revision:2,direct_revision:8,ask_enabled:true};
it('saves the ordinary tool policy and explicit Ask permission with one manager RPC and both revisions',async()=>{
  rpc.mockReturnValueOnce(query(combinedReceipt));
  provider.mockResolvedValueOnce({items:policyInput.allowed_tools.map(row)});
  expect(await updateConnectorPolicy(user,id,{...policyInput,ask_access:askChange})).toEqual(combinedReceipt);
  expect(access).toHaveBeenCalledWith(site,user,true);expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('connector_save_policy_with_ask',expect.objectContaining({p_actor_id:user,p_connector_id:id,
    p_expected_revision:1,p_expected_direct_revision:7,p_ask_enabled:true,p_catalog_reads:null,p_tool_access_mode:'selected',p_allowed_tools:policyInput.allowed_tools}));
});
it.each([{ask_enabled:false},{direct_revision:7},{revision:3},{connector_id:other},{direct_revision:undefined}])('does not confirm a partial, stale or mismatched combined receipt: %j',async patch=>{
  rpc.mockReturnValueOnce(query({...combinedReceipt,...patch}));
  await expect(updateConnectorPolicy(user,id,{...policyInput,tool_access_mode:'all',allowed_tools:[],ask_access:askChange})).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  expect(rpc).toHaveBeenCalledTimes(1);
});
it.each([['P0D01','DIRECT_ATTESTATION_REQUIRED'],['40001','REVISION_CONFLICT'],['PGRST202','STORAGE_UNAVAILABLE']])('does not split, downgrade or replay an unsuccessful combined save: %s',async (sqlCode,code)=>{
  rpc.mockReturnValueOnce(query(null,{code:sqlCode}));
  await expect(updateConnectorPolicy(user,id,{...policyInput,tool_access_mode:'all',allowed_tools:[],ask_access:askChange})).rejects.toMatchObject({code});
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('rejects conflicting authority fields and never upgrades a catalog opt-out or a partial request into consent',()=>{
  for (const patch of [{enabled:false},{allowed_hosts:[]},{allowed_tools:[]},{catalog_reads:false},
    {ask_access:{enabled:true}},{ask_access:{...askChange,actor_id:other}},{ask_access:{...askChange,expected_direct_revision:0}}]) {
    expect(policyPatchSchema.safeParse({...policyInput,ask_access:askChange,...patch}).success).toBe(false);
  }
  expect(policyPatchSchema.safeParse({...base,catalog_reads:false,ask_access:askChange}).success).toBe(false);
  expect(policyPatchSchema.safeParse({...policyInput,ask_access:{...askChange,enabled:false}}).success).toBe(false);
});
it('turns off the assistant and its saved permission together without checking provider credentials in all mode', async()=>{
  const receipt={...combinedReceipt,ask_enabled:false};rpc.mockReturnValueOnce(query(receipt));
  expect(await updateConnectorPolicy(user,id,{...policyInput,tool_access_mode:'all',allowed_tools:[],allowed_hosts:[],
    ask_access:{...askChange,enabled:false}})).toEqual(receipt);
  expect(rpc).toHaveBeenCalledTimes(1);expect(provider).not.toHaveBeenCalled();expect(credential).not.toHaveBeenCalled();
});
it.each(['workspace', 'explicit'])('validates the full selection on %s connectors, not just new or reviewed tools', async mode => {
  visible.mockResolvedValue({ ...await visible(), toolkit_slug: 'gmail', access_mode: mode });
  provider.mockResolvedValueOnce({ items: policyInput.allowed_tools.map(row).reverse() });
  await updateConnectorPolicy(user, id, policyInput);
  expect(access).toHaveBeenCalledWith(site, user, true);
  expect(credential).toHaveBeenCalledWith(site);
  expect(provider.mock.calls[0][0]).toContain('tool_slugs=GMAIL_FETCH_EMAILS%2CGMAIL_SEND_EMAIL');
  expect(rpc).toHaveBeenCalledWith('connector_update_policy', { p_site_id: site, p_connector_id: id, p_actor_id: user,
    p_expected_revision: 1, p_tool_access_mode: 'selected', p_allowed_tools: policyInput.allowed_tools, p_allowed_hosts: ['assistant'], p_require_approval: true, p_enabled: true, p_support_publication: null });
  // Previously saved IDs are not grandfathered when a subsequent PATCH resubmits them.
  visible.mockResolvedValue({ ...await visible(), revision: 2 });
  provider.mockResolvedValueOnce({ items: [row(catalogOnly)] });
  await expect(updateConnectorPolicy(user, id, { ...policyInput, expected_revision: 2 })).rejects.toMatchObject({ code: 'TOOL_NOT_IN_CATALOG' });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('saves all without enumerating the catalogue and preserves a submitted dormant list', async () => {
  await updateConnectorPolicy(user, id, { ...policyInput, allowed_tools: [], tool_access_mode: 'all' });
  expect(provider).not.toHaveBeenCalled();
  provider.mockResolvedValueOnce({ items: policyInput.allowed_tools.map(row) });
  await updateConnectorPolicy(user, id, { ...policyInput, tool_access_mode: 'all' });
  expect(rpc).toHaveBeenLastCalledWith('connector_update_policy', expect.objectContaining({
    p_tool_access_mode: 'all', p_allowed_tools: policyInput.allowed_tools,
  }));
  expect(policyPatchSchema.safeParse({ ...policyInput, tool_access_mode: null }).success).toBe(false);
  expect(policyPatchSchema.safeParse({ ...policyInput, tool_access_mode: 'any' }).success).toBe(false);
});

it('reports the mode but hides dormant selections outside the manager DTO', async () => {
  expect((await getConnectorAccess(site, user, id)).policy.tool_access_mode).toBe('selected');
  policy.mockResolvedValue({ ...(await policy()), tool_access_mode: 'all' });
  expect((await getConnectorAccess(site, user, id)).policy).toMatchObject({ tool_access_mode: 'all', allowed_tools: ['GMAIL_FETCH_EMAILS'] });
  access.mockResolvedValue({ can_view: true, can_manage: false });
  ownGrant.mockResolvedValue({ ...grant, can_use: true });
  expect((await getConnectorAccess(site, user, id)).policy).toMatchObject({ tool_access_mode: 'all', allowed_tools: [] });
  ownGrant.mockResolvedValue(grant);
  expect((await getConnectorAccess(site, user, id)).policy).toMatchObject({ tool_access_mode: 'selected', allowed_tools: [], allowed_hosts: [] });
});

it('does not mutate after credential, provider, authorization or visibility errors', async () => {
  access.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED', 'Denied', 403));
  await expect(updateConnectorPolicy(user, id, policyInput)).rejects.toMatchObject({ status: 403 });
  visible.mockRejectedValueOnce(new ConnectorError('NOT_FOUND', 'Not found', 404));
  await expect(updateConnectorPolicy(user, id, policyInput)).rejects.toMatchObject({ status: 404 });
  expect(credential).not.toHaveBeenCalled();
  credential.mockRejectedValueOnce(new ConnectorError('CREDENTIAL_UNAVAILABLE', 'Unavailable', 503));
  await expect(updateConnectorPolicy(user, id, policyInput)).rejects.toMatchObject({ status: 503 });
  expect(provider).not.toHaveBeenCalled();
  provider.mockRejectedValue(new ConnectorError('PROVIDER_UNAVAILABLE', 'Unavailable', 502));
  await expect(updateConnectorPolicy(user, id, policyInput)).rejects.toMatchObject({ status: 502 });
  expect(provider).toHaveBeenCalledTimes(2);
  expect(rpc).not.toHaveBeenCalled();
});

it('allows clearing stale entries without an upstream lookup and rejects malformed policy inputs', async () => {
  await updateConnectorPolicy(user, id, { ...policyInput, allowed_tools: [] });
  expect(credential).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
  for (const allowed_tools of [[catalogOnly, catalogOnly], ['_X'], ['a'], ['A'.repeat(151)], Array.from({ length: 101 }, (_, i) => `A${i}`)]) {
    expect(policyPatchSchema.safeParse({ ...policyInput, allowed_tools }).success).toBe(false);
  }
  expect(policyPatchSchema.safeParse({ ...policyInput, allowed_hosts: ['workflow'] }).success).toBe(false);
});

it('cannot falsely acknowledge a missing or wrong mutation receipt', async () => {
  rpc.mockImplementationOnce(() => query({ connector_id: other, revision: 2 }));
  await expect(updateConnectorAccess(user, id, { ...base, members: [grant], agents: [] })).rejects.toMatchObject({ status: 503 });
});
it('returns workspace mode and the inherited human policy without creating or exposing grant rows', async () => {
  access.mockResolvedValue({ can_view: true, can_manage: false });
  visible.mockResolvedValue({ ...(await visible()), access_mode: 'workspace' });
  ownGrant.mockResolvedValue(null);
  const result = await getConnectorAccess(site, user, id);
  expect(result).toMatchObject({ access_mode: 'workspace', members: [], agents: [], member_options: [], agent_options: [],
    policy: { allowed_tools: ['GMAIL_FETCH_EMAILS'], allowed_hosts: ['assistant'] } });
  expect(from).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();

  ownGrant.mockResolvedValue(grant);
  expect(await getConnectorAccess(site, user, id)).toMatchObject({ members: [grant], policy: { allowed_tools: [], allowed_hosts: [] } });
  ownGrant.mockResolvedValue({ ...grant, can_view: false });
  await expect(getConnectorAccess(site, user, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('fails closed rather than showing a truncated exception list as inheritance', async () => {
  visible.mockResolvedValue({ ...(await visible()), access_mode: 'workspace' });
  from.mockReturnValueOnce(query([], null, 1));
  await expect(getConnectorAccess(site, user, id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});


it('cannot publish a connector tool; preserves historical configuration unless explicitly cleared', async () => {
  const publication = {audience:'anonymous' as const,label_id:'Label_123'};
  const input = {...policyInput,tool_access_mode:'all' as const,allowed_tools:[]};
  expect(policyPatchSchema.safeParse({...input,support_publication:publication}).success).toBe(false);
  policy.mockResolvedValue({...await policy(),support_publication:publication});
  await updateConnectorPolicy(user,id,input);
  expect(rpc).toHaveBeenLastCalledWith('connector_update_policy',expect.objectContaining({p_support_publication:publication}));
  await updateConnectorPolicy(user,id,{...input,support_publication:null});
  expect(rpc).toHaveBeenLastCalledWith('connector_update_policy',expect.objectContaining({p_support_publication:null}));
});

it('sends publication settings only to managers, not to members with use permission', async () => {
  const publication = { audience: 'verified', label_id: 'Label_42' };
  expect((await getConnectorAccess(site, user, id)).policy).toHaveProperty('support_publication', null);
  policy.mockResolvedValue({ ...(await policy()), support_publication: publication });
  expect((await getConnectorAccess(site, user, id)).policy).toHaveProperty('support_publication', publication);
  access.mockResolvedValue({ can_view: true, can_manage: false });
  ownGrant.mockResolvedValue({ ...grant, can_use: true });
  expect((await getConnectorAccess(site, user, id)).policy).not.toHaveProperty('support_publication');
});

it('exposes configured catalogue reads to managers and effective policy only to usable members', async () => {
  expect((await getConnectorAccess(site,user,id)).policy.catalog_reads).toBe(false);
  visible.mockResolvedValue({...await visible(),verified_at:'2026-11-10T00:00:00Z'});
  policy.mockResolvedValue({...(await policy()), catalog_reads:true});
  expect((await getConnectorAccess(site,user,id)).policy.catalog_reads).toBe(true);
  access.mockResolvedValue({can_view:true,can_manage:false});
  expect((await getConnectorAccess(site,user,id)).policy.catalog_reads).toBe(false);
  ownGrant.mockResolvedValue({...grant,can_use:true});
  expect((await getConnectorAccess(site,user,id)).policy.catalog_reads).toBe(true);
  visible.mockResolvedValue({...await visible(),revocation_pending:true});
  expect((await getConnectorAccess(site,user,id)).policy.catalog_reads).toBe(false);
});

it('selects the catalog opt-in overload only for an explicit boolean and never infers consent from mode', async () => {
  const input = {...policyInput, tool_access_mode:'all' as const, allowed_tools:[]};
  for (const invalid of [null, 'true', 1]) expect(policyPatchSchema.safeParse({...input,catalog_reads:invalid}).success).toBe(false);
  for (const consent of [true, false]) {
    await updateConnectorPolicy(user,id,{...input,catalog_reads:consent});
    expect(rpc).toHaveBeenLastCalledWith('connector_update_policy',expect.objectContaining({p_catalog_reads:consent,p_expected_revision:1}));
  }
  await updateConnectorPolicy(user,id,input); expect(rpc.mock.calls.at(-1)![1]).not.toHaveProperty('p_catalog_reads');
  access.mockRejectedValue(new ConnectorError('ACCESS_DENIED','Denied.',403));
  await expect(updateConnectorPolicy(user,id,{...input,catalog_reads:true})).rejects.toMatchObject({code:'ACCESS_DENIED'});
  expect(rpc).toHaveBeenCalledTimes(3);
});

it('can turn reads off without a credential or provider catalogue, never mixing in additional changes', async () => {
  credential.mockRejectedValue(new Error('provider unavailable')); provider.mockResolvedValue({items:[]});
  const current = {...policyInput, allowed_tools:['DELISTED_ID'], catalog_reads:false};
  await updateConnectorPolicy(user,id,current);
  expect(rpc).toHaveBeenLastCalledWith('connector_update_policy',expect.objectContaining({p_catalog_reads:false,p_allowed_tools:['DELISTED_ID']}));
  rpc.mockImplementationOnce(() => query(null,{code:'P0C01'})); // Other fields differ from the locked DB snapshot.
  await expect(updateConnectorPolicy(user,id,{...current, allowed_tools:['UNCHECKED_ID']})).rejects.toMatchObject({code:'CATALOG_OPT_OUT_SEPARATE'});
  const revocation = {...base,catalog_reads:false as const}; await updateConnectorPolicy(user,id,revocation);
  expect(rpc).toHaveBeenLastCalledWith('connector_disable_catalog_reads',{p_actor_id:user,p_site_id:site,p_connector_id:id,p_expected_revision:1});
  for (const invalid of [{...revocation,allowed_tools:['NEW']}, {...revocation,enabled:true}, {...revocation,catalog_reads:true}]) {
    expect(policyPatchSchema.safeParse(invalid).success).toBe(false);
  }
  access.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED','Denied.',403));
  await expect(updateConnectorPolicy(user,id,revocation)).rejects.toMatchObject({code:'ACCESS_DENIED'});
  rpc.mockImplementationOnce(() => query(null,{code:'40001'}));
  await expect(updateConnectorPolicy(user,id,revocation)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  expect(credential).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
});


it.each([false,true])('blocks neutral incompatible Ask opt-in before host or combined save (combined=%s)',async combined=>{
  policy.mockResolvedValue({...await policy(),allowed_hosts:[]});
  from.mockImplementation(table=>query(table==='site_connector_auth_attempts' ? [{setup_mode:'hosted_credentials',provider_id:other}] : []));
  await expect(updateConnectorPolicy(user,id,{...policyInput,allowed_tools:[],tool_access_mode:'all',
    ...(combined && {ask_access:askChange})})).rejects.toMatchObject({code:'ASK_INCOMPATIBLE'});
  expect(rpc).not.toHaveBeenCalled();expect(credential).not.toHaveBeenCalled();
});
it('allows a pure assistant removal without provider availability, but not unrelated selected-tool edits',async()=>{
  policy.mockResolvedValue({allowed_hosts:['assistant'],tool_access_mode:'selected',allowed_tools:policyInput.allowed_tools,require_approval:true});
  credential.mockRejectedValue(new ConnectorError('CREDENTIAL_UNAVAILABLE','Unavailable',503));
  await updateConnectorPolicy(user,id,{...policyInput,allowed_hosts:[]});
  expect(from).not.toHaveBeenCalled();expect(credential).not.toHaveBeenCalled();expect(rpc).toHaveBeenCalledTimes(1);
  await expect(updateConnectorPolicy(user,id,{...policyInput,allowed_hosts:[],allowed_tools:['OTHER_TOOL']})).rejects.toMatchObject({status:503});
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('does not use an unchecked future revision to authorize an assistant transition',async()=>{
  await expect(updateConnectorPolicy(user,id,{...policyInput,expected_revision:base.expected_revision+1})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  expect(rpc).not.toHaveBeenCalled();expect(from).not.toHaveBeenCalled();expect(credential).not.toHaveBeenCalled();
});
