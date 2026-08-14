import { insertUserActionLog, markRemoteInstanceError, withRetries } from '../user-message-log';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

function createChain(result: { data?: any; error?: any } = {}) {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.eq = jest.fn().mockReturnValue(chain);
  chain.gte = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(result);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.single = jest.fn().mockResolvedValue(result);
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

describe('insertUserActionLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the existing log id when a recent duplicate exists', async () => {
    const lookup = createChain({ data: [{ id: 'existing-1' }], error: null });
    (supabaseAdmin.from as jest.Mock).mockReturnValue(lookup);

    const result = await insertUserActionLog({
      instanceId: 'inst-1',
      siteId: 'site-1',
      userId: 'user-1',
      message: 'hello',
    });

    expect(result).toEqual({ id: 'existing-1' });
    expect(lookup.insert).not.toHaveBeenCalled();
  });

  it('inserts a user_action log and throws when the insert fails', async () => {
    const lookup = createChain({ data: [], error: null });
    const insertChain = createChain({ data: null, error: { message: 'db down' } });
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(insertChain);

    await expect(
      insertUserActionLog({
        instanceId: 'inst-1',
        siteId: 'site-1',
        message: 'hello',
      })
    ).rejects.toThrow('Failed to persist user message: db down');
  });

  it('inserts a user_action log when none exists', async () => {
    const lookup = createChain({ data: [], error: null });
    const insertChain = createChain({ data: { id: 'new-1' }, error: null });
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(insertChain);

    const result = await insertUserActionLog({
      instanceId: 'inst-1',
      siteId: 'site-1',
      userId: 'user-1',
      message: 'hello',
    });

    expect(result).toEqual({ id: 'new-1' });
    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        log_type: 'user_action',
        message: 'hello',
        instance_id: 'inst-1',
        site_id: 'site-1',
      })
    );
  });
});

describe('markRemoteInstanceError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sets remote_instances status to error and writes an error log', async () => {
    const updateChain = createChain({ error: null });
    const insertChain = createChain({ error: null });
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(insertChain);

    await markRemoteInstanceError({
      instanceId: 'inst-1',
      siteId: 'site-1',
      userId: 'user-1',
      errorMessage: 'timeout',
    });

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' })
    );
    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        log_type: 'error',
        instance_id: 'inst-1',
      })
    );
  });

  it('throws when the instance status update fails', async () => {
    const updateChain = createChain({ error: { message: 'cannot update' } });
    (supabaseAdmin.from as jest.Mock).mockReturnValueOnce(updateChain);

    await expect(
      markRemoteInstanceError({
        instanceId: 'inst-1',
        siteId: 'site-1',
        errorMessage: 'timeout',
      })
    ).rejects.toThrow('Failed to mark robot as error: cannot update');
  });
});

describe('withRetries', () => {
  it('retries a failing function and then succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockResolvedValueOnce('ok');

    await expect(withRetries(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always'));
    await expect(withRetries(fn, 3, 1)).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
