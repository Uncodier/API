import { randomUUID } from 'node:crypto';
import { connectorGateway, withConnectorResolver } from '../tool-resolver';
import { composioActionTool } from '@/app/api/agents/tools/composio/assistantProtocol';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { createConnectorRuntime } from '../runtime';
import { ConnectorError } from '../types';
import { loadToolScreenAccess, assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';
import { SkillsService } from '@/lib/services/skills-service';
import { listUsableConnectors } from '../access';

jest.mock('../runtime', () => ({ createConnectorRuntime: jest.fn() }));
jest.mock('../access', () => ({ listUsableConnectors: jest.fn() }));
jest.mock('@/lib/services/skills-service', () => ({ SkillsService: { getSkillBySlugForSite: jest.fn(), listSkillsForSite: jest.fn() } }));
jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol', () => ({ deductSandboxToolCredits: jest.fn(async () => ({ success: true })) }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: jest.fn(async () => { throw new Error('Offline'); }) } }));
jest.mock('@/app/api/agents/tools/catalog_commerce/batch-admin-tool', () => ({ bindCatalogBatchActor: (tool: unknown) => tool }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'), loadToolScreenAccess: jest.fn(), assertToolScreenAccess: jest.fn(),
}));

const scope = { siteId: randomUUID(), userId: randomUUID() };
const context = { ...scope, agentId: randomUUID(), instanceId: randomUUID(), host: 'assistant' as const };
const name = `connector:${randomUUID()}:HUBSPOT_LIST_CONTACTS`;
const candidate = { name, description: 'External CRM contacts', category: 'crm', domains: ['crm'], availability: 'describe_required' };
const runtime = { search: jest.fn(), describe: jest.fn(), call: jest.fn() };
const native = { name: 'leads', description: 'Native CRM contacts', parameters: { type: 'object', properties: {} }, execute: jest.fn(async () => ({ success: true })) };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: [] });
  jest.mocked(assertToolScreenAccess).mockResolvedValue();
  jest.mocked(createConnectorRuntime).mockReturnValue(runtime as any);
  runtime.search.mockResolvedValue({ tools: [candidate], truncated: false });
  runtime.describe.mockResolvedValue({ name, parameters: { type: 'object' } });
  runtime.call.mockResolvedValue({ success: true, receipt: { status: 'completed' } });
  jest.mocked(listUsableConnectors).mockResolvedValue([]);
});

test('actual normal tools search merges native and concrete connector candidates without schemas', async () => {
  const gateway = connectorGateway(async () => context);
  expect(createConnectorRuntime).not.toHaveBeenCalled();
  const router = toolsRouterTool([native, gateway], scope);
  const result = await router.execute({ action: 'search', query: 'CRM contacts' });
  expect(result.tools.map((tool: any) => tool.name)).toEqual(['leads', name]);
  expect(result.tools[1].parameters).toBeUndefined();
  expect(runtime.describe).not.toHaveBeenCalled();
  await router.execute({ action: 'describe', name });
  await router.execute({ action: 'call', name, args: '{"arguments":{},"version":"v1","schema_hash":"test"}' });
  expect(runtime.describe).toHaveBeenCalledWith(name);
  expect(runtime.call).toHaveBeenCalledWith(name, { arguments: {}, version: 'v1', schema_hash: 'test' });
});

test('the exact decorated gateway retains host context/dry-run guards for concrete calls', async () => {
  const gateway = connectorGateway(async () => context);
  const decorate = jest.fn(async (_args: unknown) => ({ success: false, executed: false, code: 'HOST_DRY_RUN' }));
  const decorated = { ...gateway, execute: decorate };
  const router = toolsRouterTool([native, decorated], scope);
  expect(await router.execute({ action: 'call', name, args: '{}' })).toMatchObject({ code: 'HOST_DRY_RUN', executed: false });
  expect(decorate).toHaveBeenCalledWith(expect.objectContaining({ action: 'execute', action_name: name }));
  expect(runtime.call).not.toHaveBeenCalled();
});

test('host removal, fake gateway names, and blocked connector screen cannot bypass native screen policy', async () => {
  const fake = { ...native, name: 'use_composio_tools' };
  const router = withConnectorResolver({ ...native, name: 'tools' }, [fake], scope);
  expect(await router.execute({ action: 'call', name, args: '{}' })).toMatchObject({ code: 'HOST_DISABLED' });
  jest.mocked(assertToolScreenAccess).mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Denied', 403));
  const blocked = toolsRouterTool([native, connectorGateway(async () => context)], scope);
  expect(await blocked.execute({ action: 'describe', name })).toMatchObject({ success: false, code: 'ACCESS_DENIED' });
  expect(runtime.describe).not.toHaveBeenCalled();
  expect(await toolsRouterTool([native], scope).execute({ action: 'call', name: 'unknown_tool', args: '{}' })).toMatchObject({ success: false });
});

test('provider/connector outage preserves native results and never exposes raw details', async () => {
  runtime.search.mockRejectedValue(new Error('private upstream URL and credential'));
  const result = await toolsRouterTool([native, connectorGateway(async () => context)], scope).execute({ action: 'search', query: 'CRM' });
  expect(result.tools.map((tool: any) => tool.name)).toEqual(['leads']);
  expect(result.connector_status).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('private upstream');
});

test('fatal host recovery exceptions still escape connector routing', async () => {
  const error = Object.assign(new Error('Recovery stopped'), { name: 'RecoveryError' });
  const gateway = { ...connectorGateway(async () => context), execute: jest.fn(async () => { throw error; }) };
  await expect(toolsRouterTool([gateway], scope).execute({ action: 'call', name, args: '{}' })).rejects.toBe(error);
});

test('legacy api-key facade does not revive SDK/global-account execution', async () => {
  const result = await composioActionTool(scope.siteId, 'unused').execute({ action: 'execute', action_name: 'HUBSPOT_LIST_CONTACTS' });
  expect(result).toMatchObject({ success: false, code: 'HOST_DISABLED' });
  expect(createConnectorRuntime).not.toHaveBeenCalled();
});

test.each(['selected', 'all'] as const)('skill get bounds the authorized local appendix without remote schemas (%s)', async mode => {
  const skill = { slug: 'makinari-outbound-campaign', name: 'Outbound', description: 'Native procedure', content: '# Original procedure', types: ['marketing_campaign'] };
  jest.mocked(SkillsService.getSkillBySlugForSite).mockResolvedValue(skill as any);
  jest.mocked(SkillsService.listSkillsForSite).mockResolvedValue([skill] as any);
  jest.mocked(listUsableConnectors).mockResolvedValue(Array.from({ length: 7 }, () => ({
    connector: { id: randomUUID(), toolkit_slug: 'hubspot', granted_scopes: ['crm.objects.contacts.read'] },
    policy: { tool_access_mode: mode, allowed_tools: mode === 'all' ? [] : ['HUBSPOT_LIST_CONTACTS'] },
  })) as any);
  const result = await skillLookupTool({ siteId: scope.siteId, connectorContext: async () => context }).execute({ action: 'get', skill_name: skill.slug });
  expect(result).toMatchObject({ content: skill.content, types: skill.types,
    connector_capabilities: { status: 'available', truncated: true, capabilities: expect.any(Array) } });
  expect((result as any).connector_capabilities.capabilities).toHaveLength(5);
  expect(runtime.search).not.toHaveBeenCalled();
  expect(runtime.describe).not.toHaveBeenCalled();
  expect(runtime.call).not.toHaveBeenCalled();
});

test('blocked business screen or failed grants hide skill account references', async () => {
  const skill = { slug: 'makinari-outbound-campaign', name: 'Outbound', content: 'Original', types: [] };
  jest.mocked(SkillsService.getSkillBySlugForSite).mockResolvedValue(skill as any);
  jest.mocked(SkillsService.listSkillsForSite).mockResolvedValue([skill] as any);
  jest.mocked(listUsableConnectors).mockRejectedValue(new Error('Private database error'));
  const result = await skillLookupTool({ siteId: scope.siteId, connectorContext: async () => context }).execute({ action: 'get', skill_name: skill.slug });
  expect(result).toMatchObject({ content: 'Original', connector_capabilities: { status: 'unavailable', capabilities: [] } });
  expect(JSON.stringify(result)).not.toContain('Private database error');
});
test('partial external discovery retains native tools, continuation and scoped recovery; never forwards raw failure text', async () => {
  runtime.search.mockResolvedValue({tools:[], partial_error:'PROVIDER_RATE_LIMITED', truncated:true, next_cursor:'cursor'});
  const router=toolsRouterTool([native,connectorGateway(async () => context)],scope);
  const response=await router.execute({action:'search',query:'CRM contacts',catalog_query:'list contacts'});
  expect(runtime.search).toHaveBeenCalledWith(expect.objectContaining({catalog_query:'list contacts'}));
  expect(response.tools.map((t:any) => t.name)).toContain('leads');
  expect(response).toMatchObject({connector_status:'partial', connector_error:'PROVIDER_RATE_LIMITED', connector_recovery:{action:'retry_later'}, connector_next_cursor:'cursor'});
});
