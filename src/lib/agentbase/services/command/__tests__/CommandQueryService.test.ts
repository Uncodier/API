import { CommandQueryService } from '../CommandQueryService';
import { CommandCache } from '../CommandCache';
import { CommandStore } from '../CommandStore';
import { DatabaseAdapter } from '../../../adapters/DatabaseAdapter';
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

jest.mock('../../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    getCommandById: jest.fn(),
  },
}));

describe('CommandQueryService getCommandById', () => {
  const service = new CommandQueryService();
  const commandId = randomUUID();
  const legacyId = 'cmd_1790992220939_ox8hy6z';

  beforeEach(() => {
    CommandCache.clearAll();
    CommandStore.clearAll();
    jest.clearAllMocks();
  });

  it('does not let a running cache hide a completed command in Postgres', async () => {
    CommandCache.cacheCommand(commandId, {
      id: commandId,
      status: 'running',
      agent_background: 'cached-bg',
    } as any);
    (DatabaseAdapter.getCommandById as jest.Mock).mockResolvedValue({
      id: commandId,
      status: 'completed',
      functions: [{ name: 'calendars', status: 'completed' }],
    });

    const result = await service.getCommandById(commandId);

    expect(DatabaseAdapter.getCommandById).toHaveBeenCalled();
    expect(result?.status).toBe('completed');
    expect(result?.agent_background).toBe('cached-bg');
  });

  it('always reads Postgres when fresh is true even if cache is completed', async () => {
    CommandCache.cacheCommand(commandId, {
      id: commandId,
      status: 'completed',
    } as any);
    (DatabaseAdapter.getCommandById as jest.Mock).mockResolvedValue({
      id: commandId,
      status: 'failed',
      error: 'from-db',
    });

    const result = await service.getCommandById(commandId, { fresh: true });

    expect(DatabaseAdapter.getCommandById).toHaveBeenCalled();
    expect(result?.status).toBe('failed');
    expect(result?.error).toBe('from-db');
  });

  it('returns completed cache without hitting the database', async () => {
    CommandCache.cacheCommand(commandId, {
      id: commandId,
      status: 'completed',
      results: [{ ok: true }],
    } as any);

    const result = await service.getCommandById(commandId);

    expect(DatabaseAdapter.getCommandById).not.toHaveBeenCalled();
    expect(result?.status).toBe('completed');
  });

  it.each([legacyId, 'invalid-id', ''])('never sends unresolved ID %s to the database', async (id) => {
    expect(await service.getCommandById(id, { fresh: true })).toBeNull();
    expect(DatabaseAdapter.getCommandById).not.toHaveBeenCalled();
  });

  it.each(['cache', 'store'])('keeps memory-only commands in %s out of Postgres on repeated fresh reads', async (storage) => {
    const command = { id: legacyId, status: 'running' } as any;
    if (storage === 'cache') CommandCache.cacheCommand(legacyId, command);
    else CommandStore.setCommand(legacyId, command);

    for (let i = 0; i < 10; i++) {
      expect(await service.getCommandById(legacyId, { fresh: true })).toBe(command);
    }
    expect(DatabaseAdapter.getCommandById).not.toHaveBeenCalled();
  });

  it.each(['store-mapping', 'cache-mapping', 'metadata'])('resolves existing legacy commands through %s', async (source) => {
    if (source === 'store-mapping') CommandStore.setIdMapping(legacyId, commandId);
    if (source === 'cache-mapping') CommandCache.syncIds(legacyId, commandId);
    if (source === 'metadata') {
      CommandStore.setCommand(legacyId, {
        id: legacyId, status: 'running', metadata: { dbUuid: commandId, agent_role: 'analyst' },
      } as any);
    }
    (DatabaseAdapter.getCommandById as jest.Mock).mockResolvedValue({ id: commandId, status: 'completed' });

    const result = await service.getCommandById(legacyId, { fresh: true });

    expect(DatabaseAdapter.getCommandById).toHaveBeenCalledWith(commandId);
    expect(result?.id).toBe(legacyId);
    expect(result?.metadata?.dbUuid).toBe(commandId);
    expect(CommandStore.getMappedId(legacyId)).toBe(commandId);
    expect(result?.status).toBe('completed');
    if (source === 'metadata') expect(result?.metadata?.agent_role).toBe('analyst');
  });

  it('does not trust malformed legacy mappings or metadata', async () => {
    CommandStore.setIdMapping(legacyId, 'invalid-mapping');
    CommandStore.setCommand(legacyId, {
      id: legacyId, status: 'running', metadata: { dbUuid: 'invalid-metadata' },
    } as any);
    expect((await service.getCommandById(legacyId, { fresh: true }))?.id).toBe(legacyId);
    expect(DatabaseAdapter.getCommandById).not.toHaveBeenCalled();
  });
});
