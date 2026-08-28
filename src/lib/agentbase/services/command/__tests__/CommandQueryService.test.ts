import { CommandQueryService } from '../CommandQueryService';
import { CommandCache } from '../CommandCache';
import { CommandStore } from '../CommandStore';
import { DatabaseAdapter } from '../../../adapters/DatabaseAdapter';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

jest.mock('../../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    getCommandById: jest.fn(),
    isValidUUID: jest.fn(() => true),
  },
}));

describe('CommandQueryService getCommandById', () => {
  const service = new CommandQueryService();

  beforeEach(() => {
    CommandCache.clearAll();
    CommandStore.clearAll();
    jest.clearAllMocks();
  });

  it('does not let a running cache hide a completed command in Postgres', async () => {
    CommandCache.cacheCommand('cmd-1', {
      id: 'cmd-1',
      status: 'running',
      agent_background: 'cached-bg',
    } as any);
    (DatabaseAdapter.getCommandById as jest.Mock).mockResolvedValue({
      id: 'cmd-1',
      status: 'completed',
      functions: [{ name: 'calendars', status: 'completed' }],
    });

    const result = await service.getCommandById('cmd-1');

    expect(DatabaseAdapter.getCommandById).toHaveBeenCalled();
    expect(result?.status).toBe('completed');
    expect(result?.agent_background).toBe('cached-bg');
  });

  it('always reads Postgres when fresh is true even if cache is completed', async () => {
    CommandCache.cacheCommand('cmd-1', {
      id: 'cmd-1',
      status: 'completed',
    } as any);
    (DatabaseAdapter.getCommandById as jest.Mock).mockResolvedValue({
      id: 'cmd-1',
      status: 'failed',
      error: 'from-db',
    });

    const result = await service.getCommandById('cmd-1', { fresh: true });

    expect(DatabaseAdapter.getCommandById).toHaveBeenCalled();
    expect(result?.status).toBe('failed');
    expect(result?.error).toBe('from-db');
  });

  it('returns completed cache without hitting the database', async () => {
    CommandCache.cacheCommand('cmd-1', {
      id: 'cmd-1',
      status: 'completed',
      results: [{ ok: true }],
    } as any);

    const result = await service.getCommandById('cmd-1');

    expect(DatabaseAdapter.getCommandById).not.toHaveBeenCalled();
    expect(result?.status).toBe('completed');
  });
});
