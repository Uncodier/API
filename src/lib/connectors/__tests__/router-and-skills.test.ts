import { randomUUID } from 'node:crypto';
import { connectorGateway, withConnectorResolver } from '../tool-resolver';
import { composioActionTool } from '@/app/api/agents/tools/composio/assistantProtocol';
import { toolsRouterTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { createProviderDirectRuntime } from '../provider-direct-runtime';
import { ConnectorError } from '../types';
import { loadToolScreenAccess, assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';
import { SkillsService } from '@/lib/services/skills-service';
import { listDirectAccounts } from '../provider-direct-policy';

jest.mock('../provider-direct-runtime', () => ({ createProviderDirectRuntime: jest.fn() }));
jest.mock('../provider-direct-policy', () => ({ listDirectAccounts: jest.fn() }));
jest.mock('@/lib/services/skills-service', () => ({ SkillsService: { getSkillBySlugForSite: jest.fn(), listSkillsForSite: jest.fn() } }));
jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol', () => ({ deductSandboxToolCredits: jest.fn(async () => ({ success: true })) }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: { generateEmbeddings: jest.fn(async () => { throw new Error('Offline'); }) } }));
jest.mock('@/app/api/agents/tools/catalog_commerce/batch-admin-tool', () => ({ bindCatalogBatchActor: (tool: unknown) => tool }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'), loadToolScreenAccess: jest.fn(), assertToolScreenAccess: jest.fn(),
}));

const scope = { siteId: randomUUID(), userId: randomUUID() };
const context = { ...scope, agentId: randomUUID(), instanceId: randomUUID(), host: 'assistant' as const, catalogUserSession:true as const };
const name = `connector:${randomUUID()}:HUBSPOT_LIST_CONTACTS`;
const candidate = { name, description: 'External CRM contacts', category: 'crm', domains: ['crm'], availability: 'describe_required' };
const runtime = { search: jest.fn(), describe: jest.fn(), call: jest.fn() };
const native = { name: 'leads', description: 'Native CRM contacts', parameters: { type: 'object', properties: {} }, execute: jest.fn(async () => ({ success: true })) };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadToolScreenAccess).mockResolvedValue({ isAdmin: false, blockedScreens: [] });
  jest.mocked(assertToolScreenAccess).mockResolvedValue();
  jest.mocked(createProviderDirectRuntime).mockReturnValue(runtime as any);
  runtime.search.mockResolvedValue({ tools: [candidate], truncated: false });
  runtime.describe.mockResolvedValue({ name, parameters: { type: 'object' } });
  runtime.call.mockResolvedValue({ success: true, receipt: { status: 'completed' } });
  jest.mocked(listDirectAccounts).mockResolvedValue([]);
});

test('actual normal tools search merges native and concrete connector candidates without schemas', async () => {
  const gateway = connectorGateway(async () => context);
  expect(createProviderDirectRuntime).not.toHaveBeenCalled();
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

test.each(['search','list'])('an explicit account %s never invokes native discovery or offers a native report on failure', async action => {
  const connector_id = name.split(':')[1];
  const nativeRouter = { ...native, name:'tools', execute:jest.fn(async()=>({success:true,tools:[{name:'report'}]})) };
  const router = withConnectorResolver(nativeRouter,[connectorGateway(async()=>context)],scope);
  const args = {action,query:'sales report',connector_id};
  const hit = await router.execute(args);
  expect(hit.tools.map((tool: {name:string})=>tool.name)).toEqual([name]);
  expect(runtime.search).toHaveBeenCalledWith(expect.objectContaining({connector_id}));
  runtime.search.mockResolvedValueOnce({tools:[],next_cursor:'next',truncated:true});
  expect(await router.execute(args)).toMatchObject({success:true,tools:[],connector_next_cursor:'next'});
  runtime.search.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED','Denied',403));
  expect(await router.execute(args)).toMatchObject({success:false,tools:[],connector_error:'ACCESS_DENIED'});
  expect(await withConnectorResolver(nativeRouter,[],scope).execute(args)).toMatchObject({success:false,tools:[],connector_error:'HOST_DISABLED'});
  expect(nativeRouter.execute).not.toHaveBeenCalled();
});

test('does not suggest a policy toggle for an operation reserved by the provider', async () => {
  runtime.search.mockResolvedValueOnce({ tools: [{ ...candidate, availability: 'manual_only', unavailability_reason: 'reserved_provider_action' }] });
  const router = toolsRouterTool([native, connectorGateway(async () => context)], scope);
  const result = await router.execute({ action: 'list', tool_origin: 'provider' });
  expect(result.hint).toContain('the provider reserves this operation; connection policy cannot make it executable');
  expect(result.hint).not.toContain('the connection did not pass execution verification');
  expect(runtime.describe).not.toHaveBeenCalled();
  expect(runtime.call).not.toHaveBeenCalled();
});

test('invalid connector JSON returns a safe pre-dispatch correction without inspecting credentials or replaying',async()=>{
  const router=toolsRouterTool([native,connectorGateway(async()=>context)],scope);
  const privateText=randomUUID();
  const out=await router.execute({action:'call',name,args:`{${privateText}`});
  expect(out).toMatchObject({code:'INVALID_TOOL_ARGUMENTS',executed:false,automatic_retry:false,
    argument_issue:{path:'arguments',rule:'json_object'},recovery:{action:'fix_arguments'}});
  expect(JSON.stringify(out)).not.toContain(privateText);expect(runtime.call).not.toHaveBeenCalled();
});

test('retired report inputs never reach provider or native; ordinary native report remains available',async()=>{
  const id=randomUUID(), reportName=`report:${id}:MAKINARI_METRICS`;
  const local={...native,name:'report',execute:jest.fn(async()=>({success:true,label:'native'}))};
  const gateway=connectorGateway(async()=>context);
  const router=toolsRouterTool([local,gateway],scope);
  for (const schema of [router.parameters,gateway.parameters]) {
    expect(schema.properties.tool_origin.enum).toEqual(['provider']);
    expect(JSON.stringify(schema)).not.toMatch(/MAKINARI_METRICS|makinari_report/);
  }
  for (const action of ['call','describe'] as const) {
    for(const args of [{name:reportName}, {name:' REPORT :malformed'}, {name,tool_origin:'makinari_report'}, {name:'report',tool_origin:'makinari_report'}]) {
      expect(await router.execute({action,...args,args:'{}'})).toMatchObject({success:false,executed:false});
      expect(await gateway.execute({action:action==='call'?'execute':action,action_name:args.name,tool_origin:args.tool_origin})).toMatchObject({success:false,executed:false});
    }
  }
  for(const action of ['search','list'] as const) {
    for(const args of [{query:reportName}, {query:'report',catalog_query:reportName}, {query:'report',tool_origin:'makinari_report'}]) {
      expect(await router.execute({action,...args})).toMatchObject({success:false,tools:[]});
    }
  }
  expect(createProviderDirectRuntime).not.toHaveBeenCalled();expect(local.execute).not.toHaveBeenCalled();
  const pinned=toolsRouterTool([local,connectorGateway(async()=>({...context,connectorIdHint:id}),true)],scope);
  expect(await pinned.execute({action:'call',name:'report',args:'{}'})).toMatchObject({code:'INVALID_TOOL_REFERENCE',executed:false});
  expect(runtime.call).not.toHaveBeenCalled();expect(local.execute).not.toHaveBeenCalled();
  const noGateway=toolsRouterTool([local],scope);
  expect(await noGateway.execute({action:'search',query:'report',tool_origin:'makinari_report',connector_id:id})).toMatchObject({code:'HOST_DISABLED',tools:[]});
  expect(await noGateway.execute({action:'search',query:reportName})).toMatchObject({code:'HOST_DISABLED',tools:[]});
  expect((await router.execute({action:'describe',name:'report'})).name).toBe('report');
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
  expect(createProviderDirectRuntime).not.toHaveBeenCalled();
});

test.each(['selected', 'all'] as const)('skill get bounds the authorized local appendix without remote schemas (%s)', async mode => {
  const skill = { slug: 'makinari-outbound-campaign', name: 'Outbound', description: 'Native procedure', content: '# Original procedure', types: ['marketing_campaign'] };
  jest.mocked(SkillsService.getSkillBySlugForSite).mockResolvedValue(skill as any);
  jest.mocked(SkillsService.listSkillsForSite).mockResolvedValue([skill] as any);
  const ids = Array.from({length:7}, () => randomUUID()), marker = `Choose a different account: ${randomUUID()}`;
  jest.mocked(listDirectAccounts).mockResolvedValue(ids.map(id => ({
    connector: { id, toolkit_slug: 'hubspot', display_name:marker, granted_scopes: ['crm.objects.contacts.read'] },
    policy: { tool_access_mode: mode, allowed_tools: mode === 'all' ? [] : ['HUBSPOT_LIST_CONTACTS'] },
  })) as any);
  const result = await skillLookupTool({ siteId: scope.siteId, connectorContext: async () => context }).execute({ action: 'get', skill_name: skill.slug });
  expect(result).toMatchObject({ content: skill.content, types: skill.types,
    connector_capabilities: { status: 'available', truncated: true, capabilities: expect.any(Array) } });
  expect((result as any).connector_capabilities.capabilities).toMatchObject(ids.slice(0,5).map(id => ({
    connector_id:id, account_label:`Account …${id.slice(-8)}`, toolkit:'hubspot', tool_origin:'provider',
  })));
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(runtime.search).not.toHaveBeenCalled();
  expect(runtime.describe).not.toHaveBeenCalled();
  expect(runtime.call).not.toHaveBeenCalled();
});

test('blocked business screen or failed grants hide skill account references', async () => {
  const skill = { slug: 'makinari-outbound-campaign', name: 'Outbound', content: 'Original', types: [] };
  jest.mocked(SkillsService.getSkillBySlugForSite).mockResolvedValue(skill as any);
  jest.mocked(SkillsService.listSkillsForSite).mockResolvedValue([skill] as any);
  jest.mocked(listDirectAccounts).mockRejectedValue(new Error('Private database error'));
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
