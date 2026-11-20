import { randomUUID } from 'node:crypto';
import { routeTools, type RoutedTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { composioActionTool } from '@/app/api/agents/tools/composio/assistantProtocol';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { EmbeddingsService } from '@/lib/services/embeddings-service';
import { listUsableConnectors, loadConnectorCredential } from '../access';
import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';
import { instanceCatalog } from './instance-catalog-fixture';
import type { AuthorizedConnector } from '../types';

jest.mock('../access', () => ({ listUsableConnectors: jest.fn(), loadConnectorCredential: jest.fn() }));
jest.mock('../composio-sessions', () => ({ describeConnectorTool: jest.fn(), executeConnectorTool: jest.fn() }));
jest.mock('@/app/api/agents/tools/catalog_commerce/batch-admin-tool', () => ({ bindCatalogBatchActor: (t: unknown) => t }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ ...jest.requireActual('@/app/api/agents/tools/router/screen-access'),
  loadToolScreenAccess: jest.fn(), assertToolScreenAccess: jest.fn() }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: jest.fn(),
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0) } }));

const scope = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), agentId: randomUUID(), host: 'assistant' };
const accountLabel = `Private label ${randomUUID()}`;
const projectRef = 'abcdefghijklmnopqrst';
const ref = (account: AuthorizedConnector) => `connector:${account.connector.id}:SUPABASE_LIST_TABLES`;
const provider: AuthorizedConnector['provider'] = { id: randomUUID(), site_id: scope.siteId, provider: 'composio',
  project_id: randomUUID(), provider_user_id: randomUUID(), credential_revision: 'test', status: 'active' };
const table = (patch: Partial<AuthorizedConnector['connector']> = {}, policy: Partial<AuthorizedConnector['policy']> = {}): AuthorizedConnector => ({
  provider,
  connector: { id: randomUUID(), toolkit_slug: 'supabase', supabase_project_ref: projectRef, granted_scopes: [],
    display_name: accountLabel, site_id: scope.siteId, provider_id: provider.id, provider_project_id: provider.project_id,
    provider_account_id: randomUUID(), auth_config_id: randomUUID(), provider_status: 'ACTIVE', enabled: true,
    revocation_pending: false, created_by: scope.userId, revision: 1, verified_at: new Date().toISOString(), ...patch },
  policy: { tool_access_mode: 'all', allowed_tools: [], allowed_hosts: ['assistant'], require_approval: false, ...policy },
});
const privateNativeDescription = `Native CRM contacts ${randomUUID()}`;
async function build() {
  const decorated = jest.fn();
  const factory = instanceCatalog({
    '@/lib/connectors/host-context': { assistantConnectorContext: () => async () => scope },
    '@/app/api/agents/tools/composio/assistantProtocol': { composioActionTool },
    '@/app/api/agents/tools/router/assistantProtocol': { routeTools },
    '@/lib/services/tool-execution-context': { readToolExecutionContext: () => undefined },
  });
  const native = { name: 'leads', description: privateNativeDescription, parameters: { type: 'object', properties: {} }, execute: jest.fn() };
  const tools = await factory.getInstanceAssistantTools(scope.siteId, scope.userId, scope.instanceId, [native],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, list => list.map(t => t.name !== 'use_composio_tools' ? t :
      { ...t, execute: (args: unknown) => { decorated(args); return t.execute(args); } }), 'assistant', scope.agentId);
  return { router: tools.find((t: RoutedTool) => t.name === 'tools')!, decorated };
}
const generate = jest.mocked(EmbeddingsService.generateEmbeddings);
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: [] });
  generate.mockImplementation(async input => ({ model: 'offline-space', embeddings: (Array.isArray(input) ? input : [input]).map(text =>
    text.startsWith('HUBSPOT_') || text.startsWith('use_composio_tools') ? [0, 1] : [1, 0]) }));
});
afterEach(() => {
  expect(loadConnectorCredential).not.toHaveBeenCalled();
  expect(describeConnectorTool).not.toHaveBeenCalled();
  expect(executeConnectorTool).not.toHaveBeenCalled();
});

test('instance tools search sends the query once, ranks eligible reviewed actions without keyword overlap, and retains native tools', async () => {
  const rows = Array.from({ length: 7 }, () => table());
  const ineligible = [table({ supabase_project_ref: null }),
    table({}, { tool_access_mode: 'selected', allowed_tools: ['SUPABASE_ARBITRARY_SQL'] }),
    table({ toolkit_slug: 'gmail', granted_scopes: [] })];
  jest.mocked(listUsableConnectors).mockResolvedValue([...rows, ...ineligible]);
  const { router, decorated } = await build();
  expect(router.parameters.properties).toMatchObject({ connector_id: { type: 'string' }, connector_cursor: { type: 'string' } });
  const query = '¿Cómo está organizada mi aplicación?'; // no index words; vector is decisive
  const search = (extra = {}) => router.execute({ action: 'search', query, ...extra });
  const first = await search();
  expect(decorated).toHaveBeenCalledWith(expect.objectContaining({ action: 'search', search_intent: query }));
  expect(first.tools[0]).toMatchObject({ name: 'leads', parameters: expect.any(Object) });
  expect(first).toMatchObject({ connector_status: 'available', truncated: true, connector_next_cursor: expect.any(String) });
  const second = await search({ connector_cursor: first.connector_next_cursor });
  const actions = [...first.tools, ...second.tools].filter(t => t.connector_id);
  expect(actions.map(t => t.name)).toEqual(rows.map(ref).sort());
  expect(actions.every(t => t.availability === 'describe_required' && !t.parameters)).toBe(true);
  expect(second.connector_next_cursor).toBeNull();
  const inputs = generate.mock.calls.map(([input]) => input);
  expect(inputs.filter(input => typeof input === 'string')).toEqual([query, query]);
  const documents = inputs.filter(Array.isArray).flat();
  expect(documents.filter(t => t.startsWith('SUPABASE_LIST_TABLES'))).toHaveLength(1);
  for (const forbidden of [accountLabel, projectRef, privateNativeDescription, scope.siteId, provider.project_id, ...rows.map(r => r.connector.provider_account_id), ...rows.map(r => r.connector.id), 'GMAIL_FETCH_EMAILS', 'ARBITRARY_SQL']) {
    expect(documents.join('\n')).not.toContain(forbidden);
  }
  jest.mocked(listUsableConnectors).mockResolvedValue([]);
  expect(await search()).toMatchObject({ tools: [{ name: 'leads' }] });
  expect(await search({ connector_cursor: first.connector_next_cursor })).toMatchObject({ connector_status: 'unavailable', connector_error: 'STALE_CURSOR', tools: [{ name: 'leads' }] });
});

test('Spanish lexical search survives an unavailable action index; list and blocked screens never expand access', async () => {
  const allowed = table();
  const hubspot = table({ toolkit_slug: 'hubspot', granted_scopes: ['crm.objects.contacts.read'] });
  jest.mocked(listUsableConnectors).mockResolvedValue([allowed, hubspot]);
  generate.mockRejectedValue(new Error('Offline'));
  const { router } = await build();
  const query = '¿Qué tablas hay en mi base de datos?';
  const result = await router.execute({ action: 'search', query });
  expect(result.tools.map((t: RoutedTool) => t.name)).toEqual([ref(allowed)]);
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: ['applicationsDatabase'] });
  expect((await router.execute({ action: 'search', query })).tools).toEqual([]);
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: ['connectors'] });
  expect((await router.execute({ action: 'list' })).tools.some((t: RoutedTool) => t.name.startsWith('connector:'))).toBe(false);
});

test('an unavailable reviewed-document batch keeps lexical matches and retries the index without re-embedding the user request', async () => {
  const row = table();
  jest.mocked(listUsableConnectors).mockResolvedValue([row]);
  const generateNormally = generate.getMockImplementation()!;
  let attempts = 0;
  generate.mockImplementation(async (...args) => {
    if (Array.isArray(args[0]) && args[0].some(text => text.startsWith('SUPABASE_LIST_TABLES')) && ++attempts === 1) {
      throw new Error('Action index unavailable');
    }
    return generateNormally(...args);
  });
  const { router } = await build();
  for (const query of ['¿Qué tablas existen?', '¿Cómo está organizada mi aplicación?']) {
    const result = await router.execute({ action: 'search', query });
    expect(result.tools.map((t: RoutedTool) => t.name)).toContain(ref(row));
    expect(generate.mock.calls.filter(([input]) => input === query)).toHaveLength(1);
  }
  expect(attempts).toBe(2);
});
