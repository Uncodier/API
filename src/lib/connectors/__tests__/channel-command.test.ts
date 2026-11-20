import { sourceDigest } from '../approval-source';
import { randomUUID } from 'node:crypto';
import { isAssignedChannelCommand } from '../channel-command-row';
import { emitBoundCommand, attachChannelRequestHost } from '../channel-command';
import { channelRequestReceipt, channelRequestTool } from '../channel-request';
import { executeTools } from '@/lib/agentbase/agents/toolEvaluator/executor/executeTools';
import { proposeConversationConnectorAction } from '../approval-proposals';
import { configureComposio, enrichWithComposioTools } from '@/lib/agentbase/utils/composioIntegration';

jest.mock('@/lib/connectors/channel-command-row', () => ({ isAssignedChannelCommand: jest.fn(async () => true) }));
jest.mock('../approval-proposals', () => ({ proposeConversationConnectorAction: jest.fn() }));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap', () => ({ hasCustomTool: () => false }));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/mcpNativeTools', () => ({}));
jest.mock('@/lib/services/workflow-service', () => ({}));
const scope = { siteId: randomUUID(), agentId: randomUUID(), conversationId: randomUUID(), idempotencyKey: randomUUID() };
const saved = { id: randomUUID(), site_id: scope.siteId, agent_id: scope.agentId };
const proposal = { tool_slug: 'HUBSPOT_LIST_CONTACTS', arguments: { limit: 1 } };
const forbidden = jest.fn();
const invoke = async (id = saved.id, args: object = proposal) => (await executeTools([
  { type: 'function', id: 'test', name: channelRequestTool.name, status: 'initialized', arguments: args },
], { [channelRequestTool.name]: forbidden }, { command_id: id, site_id: scope.siteId,
  metadata: { connector_scope: scope } }))[0].output;

it('only the exact persisted command inherits a request closure; serialized and nested jobs never inherit it', async () => {
  const source = { tools: [channelRequestTool], agent_role: 'Customer Support' };
  const host = { messageDigest: sourceDigest('Authenticated turn'), siteId: scope.siteId, agentId: scope.agentId, resolve: jest.fn(async () => scope) };
  attachChannelRequestHost(source, host);
  await emitBoundCommand(JSON.parse(JSON.stringify(source)), saved, invoke);
  await emitBoundCommand(source, saved, async () => {
    await invoke(randomUUID());
    await invoke(saved.id, { ...proposal, site_id: scope.siteId });
    await invoke(saved.id, { ...proposal, source: {kind:'command',id:saved.id,digest:host.messageDigest} });
    await emitBoundCommand({}, saved, invoke);
    jest.mocked(isAssignedChannelCommand).mockResolvedValueOnce(false);
    await invoke();
    expect(isAssignedChannelCommand).toHaveBeenCalledWith(saved.id, saved.site_id, saved.agent_id, undefined);
    expect(proposeConversationConnectorAction).not.toHaveBeenCalled();
    expect(await invoke()).toEqual(channelRequestReceipt);
    jest.mocked(proposeConversationConnectorAction).mockRejectedValueOnce(new Error('private account/token details'));
    expect(await invoke()).toEqual(channelRequestReceipt);
  });
  await emitBoundCommand(source, saved, invoke);
  expect(proposeConversationConnectorAction).toHaveBeenCalledTimes(2);
  expect(proposeConversationConnectorAction).toHaveBeenCalledWith({...scope, source:{kind:'command',id:saved.id,digest:host.messageDigest}}, proposal);
  expect(forbidden).not.toHaveBeenCalled();
});

it('never adds default-account SDK tools to a generic conversation command', async () => {
  const cmd = { tools: [] } as any;
  expect(() => configureComposio({ enabled: true, apps: ['gmail'] })).toThrow();
  expect(await enrichWithComposioTools(cmd, { enabled: true, apps: ['gmail'] })).toEqual({ tools: [] });
});
