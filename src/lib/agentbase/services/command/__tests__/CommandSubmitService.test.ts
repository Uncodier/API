import { randomUUID } from 'node:crypto';
import { attachChannelRequestHost, requestBoundCommandReview } from '@/lib/connectors/channel-command';
import { proposeConversationConnectorAction } from '@/lib/connectors/approval-proposals';
import { EventEmitter } from 'events';
import { CommandSubmitService } from '../CommandSubmitService';
import { CommandQueryService } from '../CommandQueryService';
import { CommandStore } from '../CommandStore';
import { CommandCache } from '../CommandCache';
import { DatabaseAdapter } from '../../../adapters/DatabaseAdapter';
import type { CreateCommandParams } from '../../../models/types';

jest.mock('@/lib/connectors/channel-command-row', () => ({ isAssignedChannelCommand: jest.fn(async () => true) }));
jest.mock('@/lib/connectors/approval-proposals', () => ({ proposeConversationConnectorAction: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('../../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    createCommand: jest.fn(),
    getCommandById: jest.fn(),
    updateCommand: jest.fn(),
  },
}));

describe('CommandSubmitService identity', () => {
  const emitter = new EventEmitter();
  const service = new CommandSubmitService(emitter);
  const query = new CommandQueryService();
  const params: CreateCommandParams = {
    task: 'generate contact email addresses for lead',
    status: 'pending',
    user_id: randomUUID(),
    model_type: 'openai',
    model_id: 'gpt-4o',
    tools_model_type: 'openai',
    tools_model_id: 'gpt-4o',
    agent_role: 'Data Analyst',
    agent_background: 'Synthetic agent background',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    CommandStore.clearAll();
    CommandCache.clearAll();
    emitter.removeAllListeners();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns, stores and emits the same persisted UUID while preserving execution fields', async () => {
    const id = randomUUID();
    (DatabaseAdapter.createCommand as jest.Mock).mockResolvedValue({
      id, task: params.task, status: 'pending', user_id: params.user_id,
      agent_background: params.agent_background,
    });
    const listener = jest.fn();
    emitter.on('commandCreated', listener);

    expect(await service.submitCommand(params)).toBe(id);
    expect(CommandStore.getMappedId(id)).toBe(id);
    expect(CommandStore.getCommand(id)).toMatchObject({
      id, model_type: 'openai', model_id: 'gpt-4o',
      tools_model_type: 'openai', tools_model_id: 'gpt-4o',
      agent_background: params.agent_background,
      metadata: { dbUuid: id, agent_role: 'Data Analyst' },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(CommandStore.getCommand(id));

    // Simulate polling from another isolate with no process-local ID map.
    CommandStore.clearAll();
    CommandCache.clearAll();
    (DatabaseAdapter.getCommandById as jest.Mock).mockResolvedValue({ id, status: 'completed' });
    expect((await query.getCommandById(id, { fresh: true }))?.status).toBe('completed');
    expect(DatabaseAdapter.getCommandById).toHaveBeenCalledWith(id);
  });

  it('emits request authority only for the initiating capability, not serialized command metadata', async () => {
    const id = randomUUID(), siteId = randomUUID(), agentId = randomUUID();
    const cmd = { ...params, site_id: siteId, agent_id: agentId };
    const action = { tool_slug: 'HUBSPOT_LIST_CONTACTS', arguments: {} };
    const scope = { siteId, agentId, conversationId: randomUUID(), idempotencyKey: randomUUID() };
    attachChannelRequestHost(cmd, { siteId, agentId, resolve: async () => scope });
    (DatabaseAdapter.createCommand as jest.Mock).mockResolvedValue({ ...JSON.parse(JSON.stringify(cmd)), id });
    let done: Promise<unknown> | undefined;
    emitter.on('commandCreated', (saved) => { done = requestBoundCommandReview(saved.id, saved.site_id, action); });
    await service.submitCommand(cmd);
    await done;
    expect(proposeConversationConnectorAction).toHaveBeenCalledWith(scope, action);
    await service.submitCommand(JSON.parse(JSON.stringify(cmd)));
    await done;
    expect(proposeConversationConnectorAction).toHaveBeenCalledTimes(1);
  });

  it('retains a local fallback on insert failure without querying Postgres for its legacy ID', async () => {
    (DatabaseAdapter.createCommand as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
    const listener = jest.fn();
    emitter.on('commandCreated', listener);

    const id = await service.submitCommand(params);

    expect(id).toMatch(/^cmd_/);
    expect(CommandStore.getMappedId(id)).toBeUndefined();
    const command = await query.getCommandById(id, { fresh: true });
    expect(command).toMatchObject({ id, agent_background: params.agent_background });
    expect(listener).toHaveBeenCalledWith(command);
    expect(DatabaseAdapter.getCommandById).not.toHaveBeenCalled();
  });
});