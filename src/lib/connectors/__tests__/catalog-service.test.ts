import { randomBytes } from 'node:crypto';
import { getConnectorCatalog, getConnectorDetail, getConnectorDomainCounts } from '../catalog-service';
import { ConnectorError } from '../types';

const access = jest.fn();
const credential = jest.fn();
const visible = jest.fn();
const toolkits = jest.fn();
const toolkit = jest.fn();
const configs = jest.fn();
const project = jest.fn();
const client = jest.fn();
jest.mock('../access', () => ({ requireConnectorSiteAccess: (...args: unknown[]) => access(...args), loadConnectorCredential: (...args: unknown[]) => credential(...args), listVisibleConnectors: (...args: unknown[]) => visible(...args) }));
jest.mock('../composio-transport', () => ({ ...jest.requireActual('../composio-transport'), createComposioClient: (...args: unknown[]) => client(...args) }));
jest.mock('../composio-catalog', () => ({ listToolkits: (...args: unknown[]) => toolkits(...args), getToolkit: (...args: unknown[]) => toolkit(...args), listAuthConfigs: (...args: unknown[]) => configs(...args) }));
jest.mock('../connection-service', () => ({ projectConnections: (...args: unknown[]) => project(...args) }));

const site = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const key = randomBytes(32).toString('hex');
const gmail = { slug: 'gmail', name: 'Gmail', description: 'Email.', logo_url: 'https://images.example.test/gmail.svg', categories: [{ slug: 'email', name: 'Email' }], tools_count: 20, auth_schemes: ['OAUTH2'], version: 'v1', type: 'native', providerSecret: key };
const input = { site_id: site, tab: 'all' as const };
beforeEach(() => {
  jest.clearAllMocks();
  access.mockResolvedValue({ can_view: true, can_manage: false });
  credential.mockResolvedValue({ apiKey: key, revision: 'rev' });
  visible.mockResolvedValue([{ id: 'visible', toolkit_slug: 'gmail' }]);
  client.mockReturnValue({ request: jest.fn() });
  toolkits.mockResolvedValue({ items: [gmail], next_cursor: 'next', total_items: 3 });
  toolkit.mockResolvedValue(gmail);
  configs.mockResolvedValue({ items: [{ id: 'ac_config', name: 'Gmail auth', toolkitSlug: 'gmail', authScheme: 'OAUTH2', status: 'ENABLED' }], next_cursor: null });
  project.mockResolvedValue([{ id: 'visible', toolkit_slug: 'gmail', access_mode: 'workspace', can_use: true }]);
});

it('returns explicit unconfigured state, not fake provider metadata', async () => {
  credential.mockRejectedValue(new ConnectorError('NOT_CONFIGURED', 'Missing.', 422));
  expect(await getConnectorCatalog(user, input)).toMatchObject({ items: [], configured: false, total: null, can_manage: false });
  expect(visible).not.toHaveBeenCalled(); expect(toolkits).not.toHaveBeenCalled();
});

it('does not turn missing migrations, credential errors or forbidden access into an empty success', async () => {
  credential.mockRejectedValue(new ConnectorError('STORAGE_UNAVAILABLE', 'Migration required.', 503));
  await expect(getConnectorCatalog(user, input)).rejects.toMatchObject({ status: 503 });
  access.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied.', 403));
  await expect(getConnectorCatalog(user, input)).rejects.toMatchObject({ status: 403 });
  expect(toolkits).not.toHaveBeenCalled();
});

it('projects only safe metadata and authorized counts with shared domains/skills', async () => {
  const result = await getConnectorCatalog(user, input);
  expect(result.items[0]).toMatchObject({ slug: 'gmail', logo: gmail.logo_url, connection_count: 1, domains: ['communication'] });
  expect(result.items[0].skills).toContain('makinari-outbound-campaign');
  expect(result.next_cursor).toBe('next'); expect(result.total).toBe(3);
  expect(JSON.stringify(result)).not.toContain(key);
  expect(JSON.stringify(result)).not.toContain('visible');
});

it('connected tab reads only visible existing toolkit definitions, never provider account lists', async () => {
  visible.mockResolvedValue([{ id: 'visible', toolkit_slug: 'gmail' }, { id: 'other-visible', toolkit_slug: 'gmail' }]);
  const result = await getConnectorCatalog(user, { ...input, tab: 'connected' });
  expect(toolkits).not.toHaveBeenCalled(); expect(toolkit).toHaveBeenCalledTimes(1);
  expect(result.items[0].connection_count).toBe(2); expect(result.total).toBe(1);
  await expect(getConnectorCatalog(user, { ...input, tab: 'connected', cursor: 'foreign-provider-cursor' })).rejects.toMatchObject({ status: 400 });
});

it.each([['support', 'zendesk'], ['finance', 'quickbooks']])(
  'finds %s matches beyond the first provider page despite unrelated provider categories', async (category, slug) => {
    const cursor = Buffer.from('2-100').toString('base64');
    const secondPage = { items: [{ ...gmail, slug, categories: [] }], next_cursor: null, total_items: 101 };
    toolkits.mockResolvedValueOnce({
      items: Array.from({ length: 100 }, (_, i) => ({ ...gmail, slug: `other-${i}` })), next_cursor: cursor, total_items: 101,
    }).mockResolvedValueOnce(secondPage);
    const result = await getConnectorCatalog(user, { ...input, category, page: 1 });
    expect(result).toMatchObject({ total: 1, current_page: 1, total_pages: 1, next_cursor: null });
    expect(result.items.map(item => item.slug)).toEqual([slug]);
    expect(toolkits).toHaveBeenLastCalledWith(expect.anything(), { query: undefined, cursor, limit: 100 });
  },
);

it('paginates matching toolkits, passing the search through every opaque provider page', async () => {
  const matches = Array.from({ length: 51 }, (_, i) => ({
    ...gmail, slug: `support-${i}`, categories: [{ slug: 'helpdesk', name: 'Helpdesk' }],
  }));
  toolkits.mockImplementation((_client, { cursor }) => Promise.resolve(cursor
    ? { items: matches.slice(10), next_cursor: null, total_items: null }
    : { items: [gmail, ...matches.slice(0, 10)], next_cursor: 'opaque', total_items: null }));
  const search = { ...input, category: 'support', q: 'help' };
  const first = await getConnectorCatalog(user, { ...search, page: 1 });
  const second = await getConnectorCatalog(user, { ...search, cursor: first.next_cursor! });
  expect(first).toMatchObject({ total: 51, current_page: 1, total_pages: 2, next_cursor: 'filtered:2' });
  expect(first.items.map(item => item.slug)).toEqual(matches.slice(0, 50).map(item => item.slug));
  expect(second).toMatchObject({ total: 51, current_page: 2, total_pages: 2, next_cursor: null });
  expect(second.items.map(item => item.slug)).toEqual(['support-50']);
  expect(toolkits.mock.calls.map(([, options]) => options.query)).toEqual(['help', 'help', 'help', 'help']);
});

it('fails an incomplete provider scan rather than displaying partial domain results', async () => {
  toolkits.mockResolvedValue({ items: [gmail], next_cursor: 'repeated', total_items: null });
  await expect(getConnectorCatalog(user, { ...input, category: 'support', page: 1 }))
    .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  expect(toolkits).toHaveBeenCalledTimes(2);
});

it('filters the connected catalogue before paginating without consulting other toolkits', async () => {
  const slugs = [...Array.from({ length: 20 }, (_, i) => `other-${i}`), 'zendesk'];
  visible.mockResolvedValue(slugs.map(toolkit_slug => ({ toolkit_slug })));
  toolkit.mockImplementation((_client, slug) => Promise.resolve({ ...gmail, slug, name: slug }));
  const result = await getConnectorCatalog(user, { ...input, tab: 'connected', category: 'support', q: 'Zendesk', page: 1 });
  expect(result).toMatchObject({ total: 1, current_page: 1, total_pages: 1, next_cursor: null });
  expect(result.items).toMatchObject([{ slug: 'zendesk', connection_count: 1 }]);
  expect(toolkit.mock.calls.map(([, slug]) => slug).sort()).toEqual(slugs.sort());
  expect(toolkits).not.toHaveBeenCalled();
});

it('counts the full search inventory before category selection or pagination', async () => {
  const outlook = { ...gmail, slug: 'outlook' };
  const unmapped = { ...gmail, slug: 'unmapped', categories: [] };
  toolkits.mockResolvedValueOnce({ items: [gmail], next_cursor: 'more', total_items: 3 })
    .mockResolvedValueOnce({ items: [outlook, unmapped], next_cursor: null, total_items: 3 });
  const result = await getConnectorDomainCounts(user, { ...input, q: 'mail' });
  expect(result).toMatchObject({ total: 3, counts: { communication: 2, calendar: 1, support: 0 } });
  expect(toolkits.mock.calls.map(([, options]) => options.query)).toEqual(['mail', 'mail']);
});

it('counts matching visible connected toolkits once, not their individual accounts', async () => {
  visible.mockResolvedValue([{ toolkit_slug: 'gmail' }, { toolkit_slug: 'gmail' }, { toolkit_slug: 'zendesk' }]);
  toolkit.mockImplementation((_client, slug) => Promise.resolve({ ...gmail, slug, name: slug, description: '' }));
  const result = await getConnectorDomainCounts(user, { ...input, tab: 'connected', q: 'GMAIL' });
  expect(result).toMatchObject({ total: 1, counts: { communication: 1, support: 0 } });
  expect(toolkit).toHaveBeenCalledTimes(2);
  expect(toolkits).not.toHaveBeenCalled();
});

it('does not scan domain counts without workspace access', async () => {
  access.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied.', 403));
  await expect(getConnectorDomainCounts(user, input)).rejects.toMatchObject({ status: 403 });
  expect(credential).not.toHaveBeenCalled();
  expect(toolkits).not.toHaveBeenCalled();
});

it('detail hides auth configuration identity from members and uses visible connectors only', async () => {
  const result = await getConnectorDetail(site, user, 'gmail');
  expect(result.auth_configs).toEqual([]); expect(configs).not.toHaveBeenCalled();
  expect(result.connections).toEqual([{ id: 'visible', toolkit_slug: 'gmail', access_mode: 'workspace', can_use: true }]);
  expect(result.toolkit.connection_count).toBe(1);
  expect(result).not.toHaveProperty('connection_setup');
});

it('detail counts the connections that still pass grant projection', async () => {
  project.mockResolvedValueOnce([]);
  const result = await getConnectorDetail(site, user, 'gmail');
  expect(result.connections).toEqual([]);
  expect(result.toolkit.connection_count).toBe(0);
});

it('jumps directly to numbered provider pages without walking preceding pages', async () => {
  toolkits.mockResolvedValueOnce({ items: [gmail], next_cursor: null, total_items: 1829 });
  const result = await getConnectorCatalog(user, { ...input, page: 37 });
  expect(result).toMatchObject({ current_page: 37, total_pages: 37 });
  expect(toolkits).toHaveBeenCalledTimes(1);
  expect(toolkits).toHaveBeenCalledWith(expect.anything(), { query: undefined, cursor: Buffer.from('37-50').toString('base64'), limit: 50 });
});

it('manager detail collects bounded configuration pages and refuses repeated/partial results', async () => {
  access.mockResolvedValue({ can_view: true, can_manage: true });
  configs.mockResolvedValueOnce({ items: [{ id: 'first', name: 'First', toolkitSlug: 'gmail', authScheme: 'OAUTH2', status: 'ENABLED' }], next_cursor: 'next-config' })
    .mockResolvedValueOnce({ items: [{ id: 'second', name: 'Second', authScheme: null, status: 'ENABLED' },
      { id: 'not-visible', name: 'Disabled', toolkitSlug: 'gmail', authScheme: 'OAUTH2', status: 'DISABLED' }], next_cursor: null });
  const result = await getConnectorDetail(site, user, 'gmail');
  expect(result.auth_configs).toEqual([{ id: 'first', name: 'First', auth_scheme: 'OAUTH2', setup_key: expect.stringMatching(/^[a-f0-9]{64}$/) }, { id: 'second', name: 'Second', auth_scheme: 'Unknown' }]);
  expect(result.connection_setup).toEqual({ kind: 'existing', config_ids: ['first'] });
  expect(configs).toHaveBeenCalledWith(expect.anything(), 'gmail', undefined, true);
  configs.mockResolvedValueOnce({ items: [], next_cursor: 'same' }).mockResolvedValueOnce({ items: [], next_cursor: 'same' });
  await expect(getConnectorDetail(site, user, 'gmail')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
});

it('shows no-account guidance to members without exposing project configurations', async () => {
  toolkit.mockResolvedValueOnce({ ...gmail, slug: 'public_toolkit', auth_schemes: ['NO_AUTH'] });
  expect(await getConnectorDetail(site, user, 'public_toolkit')).toMatchObject({ connection_setup: { kind: 'no_auth' }, auth_configs: [] });
  expect(configs).not.toHaveBeenCalled();
});