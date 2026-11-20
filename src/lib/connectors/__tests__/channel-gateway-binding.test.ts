import { randomUUID } from 'node:crypto';
import { attachSupportConnectorHost, emitBoundCommand } from '../channel-command';
import { isAssignedChannelCommand } from '../channel-command-row';
import { executeSupportConnectorTool } from '../support-runtime';
import { supportConnectorTool, type SupportConnectorHost } from '../support-runtime-contract';
import { executeTools } from '@/lib/agentbase/agents/toolEvaluator/executor/executeTools';

jest.mock('../channel-command-row', () => ({ isAssignedChannelCommand: jest.fn(async () => true) }));
jest.mock('../support-runtime', () => ({ executeSupportConnectorTool: jest.fn() }));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap', () => ({}));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/mcpNativeTools', () => ({}));
jest.mock('@/lib/services/workflow-service', () => ({}));

const siteId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
const scope = { siteId, agentId, userId, audience: 'member' as const, conversationId: randomUUID(), idempotencyKey: randomUUID() };
const source = { tools: [{ type: 'function', function: supportConnectorTool }] };
const saved = { id: randomUUID(), site_id: siteId, agent_id: agentId };
const fakeMap = jest.fn();
const name = supportConnectorTool.name;
const args = { action: 'list' };
const run = async (command_id = saved.id, site_id = siteId) => (await executeTools([
  { type: 'function', name, arguments: JSON.stringify(args), id: 'test', status: 'initialized' },
], { [name]: fakeMap }, { command_id, site_id, metadata: { connector_scope: scope } }))[0];
const invoke = async (commandId = saved.id, site = siteId) => (await run(commandId, site)).output;

it('routes only the live persisted command to the reserved handler without injected arguments', async () => {
  const resolve = jest.fn(async () => scope);
  const runtime = jest.mocked(executeSupportConnectorTool);
  runtime.mockImplementation(async (host: SupportConnectorHost) => ({ success: Boolean(await host.resolve()), status: 'checked' }));
  attachSupportConnectorHost(source, { siteId, agentId, resolve });
  const denied = { success: false, status: 'unavailable' };
  expect(await emitBoundCommand(JSON.parse(JSON.stringify(source)), saved, invoke)).toEqual(denied);
  await emitBoundCommand(source, saved, async () => {
    expect(await run(randomUUID())).toMatchObject({ status: 'error', output: denied });
    expect(await invoke(saved.id, randomUUID())).toEqual(denied);
    expect(await emitBoundCommand({}, saved, invoke)).toEqual(denied);
    expect(runtime).not.toHaveBeenCalled();
    expect(await invoke()).toEqual({ success: true, status: 'checked' });
    expect(runtime).toHaveBeenCalledWith(expect.objectContaining({ siteId, agentId }), name, args);
    expect(isAssignedChannelCommand).toHaveBeenCalledWith(saved.id, siteId, agentId, userId);
    jest.mocked(isAssignedChannelCommand).mockResolvedValueOnce(false);
    expect(await invoke()).toEqual({ success: false, status: 'checked' });
    runtime.mockRejectedValueOnce(new Error('provider secret'));
    expect(await invoke()).toEqual(denied);
  });
  expect(await emitBoundCommand(source, saved, invoke)).toEqual(denied);
  expect(fakeMap).not.toHaveBeenCalled();
});
