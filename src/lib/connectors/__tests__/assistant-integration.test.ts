import { randomUUID } from 'node:crypto';
import { instanceCatalog } from './instance-catalog-fixture';
import { buildToolExecutionContext, readToolExecutionContext } from '@/lib/services/tool-execution-context';
import { connectorGateway, withConnectorResolver } from '../tool-resolver';
import { createConnectorRuntime } from '../runtime';

jest.mock('../runtime', () => ({ createConnectorRuntime: jest.fn() }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ assertToolScreenAccess: jest.fn(async () => undefined) }));
const context = { siteId: randomUUID(), userId: randomUUID(), agentId: randomUUID(), instanceId: randomUUID(), host: 'assistant' as const };
const runtime = { search: jest.fn(async () => ({ tools: [], truncated: false })), describe: jest.fn(), call: jest.fn(async () => ({ success: true })) };

function catalog() {
  const resolve = jest.fn(async () => context);
  const hostContext = jest.fn(() => resolve);
  const privateInputs: unknown[] = [];
  const compatibility = jest.fn((resolver: any) => {
    const gateway = connectorGateway(resolver);
    return { ...gateway, execute: async (args: unknown, privateContext: unknown) => {
      privateInputs.push(privateContext);
      return gateway.execute(args);
    } };
  });
  const routeTools = jest.fn((tools: any[], scope: any) => [withConnectorResolver({ name: 'tools', description: '', parameters: {},
    execute: async () => ({ success: true, tools: [] }) }, tools, scope)]);
  return { ...instanceCatalog({
    '@/lib/connectors/host-context': { assistantConnectorContext: hostContext },
    '@/app/api/agents/tools/composio/assistantProtocol': { composioActionTool: compatibility },
    '@/app/api/agents/tools/router/assistantProtocol': { routeTools },
    '@/lib/services/tool-execution-context': { readToolExecutionContext },
  }),
    hostContext, resolve, privateInputs, routeTools };
}

beforeEach(() => { jest.clearAllMocks(); jest.mocked(createConnectorRuntime).mockReturnValue(runtime as any); });

test('assistant factory decorates gateway before closing router and preserves private tool context', async () => {
  const factory = catalog();
  const privateContext = buildToolExecutionContext({ site_id: context.siteId, intent: 'Inspect CRM contacts', source: { instance_id: context.instanceId } });
  const decoration = jest.fn((tools: any[]) => tools.map(tool => ({ ...tool, execute: async (...args: any[]) => tool.execute(...args) })));
  const tools = await factory.getInstanceAssistantTools(context.siteId, context.userId, context.instanceId, [],
    'not-an-agent-identity', undefined, undefined, undefined, undefined, privateContext, undefined, decoration, 'assistant');
  expect(factory.hostContext).toHaveBeenCalledWith({ siteId: context.siteId, userId: context.userId, instanceId: context.instanceId, host: 'assistant' });
  expect(factory.resolve).not.toHaveBeenCalled();
  expect(createConnectorRuntime).not.toHaveBeenCalled();
  expect(decoration.mock.calls[0][0].some((tool: any) => tool.name === 'use_composio_tools')).toBe(true);
  await tools[0].execute({ action: 'call', name: `connector:${randomUUID()}:HUBSPOT_LIST_CONTACTS`, args: '{}' });
  expect(factory.privateInputs).toEqual([privateContext]);
  expect(runtime.call).toHaveBeenCalledTimes(1);
});

test('host removal prevents alternate connector route; generic factory defaults background unavailable', async () => {
  const factory = catalog();
  const tools = await factory.getInstanceAssistantTools(context.siteId, context.userId, context.instanceId, [], undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, list => list.filter(tool => tool.name !== 'use_composio_tools'));
  expect(factory.hostContext).toHaveBeenCalledWith(expect.objectContaining({ host: 'workflow' }));
  expect(await tools[0].execute({ action: 'call', name: `connector:${randomUUID()}:HUBSPOT_LIST_CONTACTS`, args: '{}' }))
    .toMatchObject({ code: 'HOST_DISABLED' });
  expect(runtime.call).not.toHaveBeenCalled();
});