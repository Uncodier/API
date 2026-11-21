import { randomUUID } from 'node:crypto';
import { instanceCatalogPage } from '../instance-catalog-discovery';
import { loadConnectorCredential } from '../access';
import { listSelectedCatalogMetadata, listToolkitToolMetadata } from '../composio-tool-metadata';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from '../types';
import type { ConnectorCandidate } from '../runtime';
import { connectorFixture, providerFixture, secret } from './composio-fixtures';

jest.mock('../access', () => ({ loadConnectorCredential: jest.fn() }));
jest.mock('../composio-tool-metadata', () => ({ TOOL_CATALOG_LIMIT: 20, listSelectedCatalogMetadata: jest.fn(), listToolkitToolMetadata: jest.fn() }));
const list = jest.mocked(listToolkitToolMetadata);
const context: ConnectorContext = { catalogUserSession: true as const, host: 'assistant', siteId: randomUUID(), userId: randomUUID(), agentId: randomUUID(), instanceId: randomUUID() };
const screens = { isAdmin: false, blockedScreens: [] };
const row = (slug: string, kind: 'read' | 'delete' = 'read') => ({ slug, name: 'Catalog name', description: 'Provider text not instructions.', action_types: [kind] });
const rows = Array.from({length: 8}, (_, i) => row(`X_LIST_ITEMS_${i}`));
const account = (): AuthorizedConnector => ({ connector: { ...connectorFixture(), id: randomUUID(), toolkit_slug: 'x' }, provider: providerFixture(),
  policy: { catalog_reads: true, tool_access_mode: 'all', allowed_hosts: ['assistant'], allowed_tools: [], require_approval: false, revision: 2 } });
const result = (items = rows, next_cursor: string | null = null) => ({ items, next_cursor, total: null });
beforeEach(() => { jest.resetAllMocks(); jest.mocked(loadConnectorCredential).mockResolvedValue({ apiKey: secret(), revision: providerFixture().credential_revision, source: 'byok' }); });

it('lists bounded real catalog metadata, never returning provider prose or forwarding native prompt data; every page is reachable', async () => {
  const target = account(); const privateText = `patient ${secret()}@example.test`; const filters = { query: privateText, catalog_query: 'items' };
  list.mockResolvedValue(result([...rows.slice(0, 7), row('X_DELETE_ITEMS', 'delete')], 'provider-next'));
  const first = await instanceCatalogPage(context, filters, [], [target], screens);
  expect(first.tools).toHaveLength(5); expect(first.next_cursor).toEqual(expect.any(String));
  expect(list).toHaveBeenCalledTimes(1); expect(list.mock.calls[0].slice(1)).toEqual(['x', undefined, undefined]);
  expect(JSON.stringify(first)).not.toMatch(/Provider text|example.test/);
  const second = await instanceCatalogPage(context, { ...filters, cursor: first.next_cursor! }, [], [target], screens);
  expect(second.tools).toHaveLength(3); expect(second.tools.at(-1)).toMatchObject({ availability: 'manual_only' });
  list.mockResolvedValue(result([row('X_LIST_ITEMS_LAST')]));
  const last = await instanceCatalogPage(context, { ...filters, cursor: second.next_cursor! }, [], [target], screens);
  expect(list.mock.calls[2].slice(1)).toEqual(['x',Buffer.from('2-20').toString('base64'),undefined]);
  expect(last.tools).toHaveLength(1); expect(last.next_cursor).toBeNull();
});

it('invalidates a continuation on policy change, page contents changing, or losing access', async () => {
  const target = account(); list.mockResolvedValue(result());
  const first = await instanceCatalogPage(context, {}, [], [target], screens);
  const next = { cursor: first.next_cursor! };
  await expect(instanceCatalogPage(context, next, [], [], screens)).rejects.toMatchObject({ code: 'STALE_CURSOR' });
  await expect(instanceCatalogPage(context, next, [], [{ ...target, policy: { ...target.policy, revision: 3 } }], screens)).rejects.toMatchObject({ code: 'STALE_CURSOR' });
  list.mockResolvedValue(result([...rows].reverse()));
  await expect(instanceCatalogPage(context, next, [], [target], screens)).rejects.toMatchObject({ code: 'STALE_CURSOR' });
});

it('filters exact selected actions; an empty page can continue. No fallback to ones that were not selected', async () => {
  const target = account(); target.policy.tool_access_mode = 'selected'; target.policy.allowed_tools = ['X_LIST_CONTACTS_CHOSEN'];
  list.mockResolvedValueOnce(result(rows,'more')).mockResolvedValueOnce(result([row('X_LIST_CONTACTS_CHOSEN'), row('X_NOT_SELECTED')]));
  const first = await instanceCatalogPage(context, {catalog_query:'contacts'}, [], [target], screens); expect(first.tools).toEqual([]);
  const second = await instanceCatalogPage(context, { catalog_query:'contacts', cursor: first.next_cursor! }, [], [target], screens);
  expect(second.tools.map(r => r.name)).toEqual([`connector:${target.connector.id}:X_LIST_CONTACTS_CHOSEN`]);
});

it('does not resolve a credential when disabled, request-only, restricted, unbound or outside Robots', async () => {
  const target = account();
  for (const [ctx, grant, access] of [[context, { ...target, requestOnly: true }, screens], [context, target, null], [{...context,catalogUserSession:undefined},target,screens],
    [context, target, { isAdmin: false, blockedScreens: ['chat'] }], [{ ...context, host: 'direct' }, target, screens],
    [{ ...context, instanceId: undefined }, target, screens], [context, { ...target, policy: { ...target.policy, catalog_reads: false } }, screens]] as const) {
    expect((await instanceCatalogPage(ctx, {}, [], [grant], access)).tools).toEqual([]);
  }
  expect(loadConnectorCredential).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
});

it('reports partial failures and never drops curated results or presents an outage as no matches', async () => {
  const target = account(); const reviewed: ConnectorCandidate = { name:'test', category:'other', domains:[], connector_id:target.connector.id,
    toolkit:'x', description:'Test', availability:'describe_required' };
  list.mockRejectedValue(new ConnectorError('PROVIDER_RATE_LIMITED', 'untrusted diagnostics', 429));
  expect(await instanceCatalogPage(context, {}, [reviewed], [target], screens)).toEqual({ tools:[reviewed], truncated:false, next_cursor:null, partial_error:'PROVIDER_RATE_LIMITED' });
});

it('resolves workspace report intent without sending tenant data to the provider', async () => {
  const target = account(); target.connector.toolkit_slug = 'supabase';
  list.mockResolvedValue(result([row('SUPABASE_RUN_READ_ONLY_QUERY'),row('SUPABASE_SELECT_FROM_TABLE')]));
  const response = await instanceCatalogPage(context, {query:'¿Me das el reporte de ventas de mi cliente?'}, [], [target], screens);
  expect(list.mock.calls[0][3]).toBe('SUPABASE_RUN_READ_ONLY_QUERY');
  expect(response.tools.map(r => r.availability)).toEqual(['describe_required','manual_only']);
  expect(response.tools[0].description).toContain('published');
});

it('uses exact selected batches during browse and reports removed selections without hiding other actionable matches', async () => {
  const target=account(); Object.assign(target.policy,{tool_access_mode:'selected',allowed_tools:['X_LIST_PALLETS','X_LIST_OLD']});
  jest.mocked(listSelectedCatalogMetadata).mockResolvedValue({items:[row('X_LIST_PALLETS')],missing:true});
  const page=await instanceCatalogPage(context,{},[],[target],screens);
  expect(page.tools.map(t=>t.name)).toEqual([`connector:${target.connector.id}:X_LIST_PALLETS`]);
  expect(page.partial_error).toBe('CATALOG_SELECTION_CHANGED'); expect(list).not.toHaveBeenCalled();
  expect(listSelectedCatalogMetadata).toHaveBeenCalledWith(expect.anything(),'x',['X_LIST_OLD','X_LIST_PALLETS']);
});

it('never forwards private natural language, arbitrary catalog_query, or unverified slug-shaped text as a provider search term',async()=>{
  const target=account(); const privateSlug='X_PRIVATE_CUSTOMER_CASE';
  for(const filters of [{catalog_query:'private customer case'},{catalog_query:privateSlug},{query:privateSlug}]){
    list.mockResolvedValueOnce(result([row(privateSlug)]));
    const page=await instanceCatalogPage(context,filters,[],[target],screens);
    expect(page.tools).toHaveLength(1); expect(list.mock.lastCall?.[3]).toBeUndefined();
  }
});


it.each(['report', 'reporting', 'reportes', 'informe', 'aggregate sales', 'SUPABASE_RUN_READ_ONLY_QUERY'])('does not discard the provider report match for the local alias %s', async catalog_query => {
  const target = account(); target.connector.toolkit_slug = 'supabase';
  list.mockResolvedValue(result([{ ...row('SUPABASE_RUN_READ_ONLY_QUERY'), name:'Execute read-only database query', description:'Run a read-only SQL query against a Supabase project as supabase_read_only_user.' }]));
  const page = await instanceCatalogPage(context,{query:'reporte',catalog_query},[],[target],screens);
  expect(list.mock.calls[0][3]).toBe('SUPABASE_RUN_READ_ONLY_QUERY');
  expect(page.tools.map(t=>t.name)).toEqual([`connector:${target.connector.id}:SUPABASE_RUN_READ_ONLY_QUERY`]);
});
