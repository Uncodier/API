import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExec = jest.fn<() => Promise<unknown>>();
const mockHset = jest.fn(() => pipeline);
const mockExpire = jest.fn(() => pipeline);
const pipeline = {
  hset: mockHset,
  expire: mockExpire,
  exec: mockExec,
};
const mockHdel = jest.fn<() => Promise<number>>();
const mockHvals = jest.fn<() => Promise<string[]>>();
const mockUpdateEq: any = jest.fn();
const mockUpdate: any = jest.fn(() => ({ eq: mockUpdateEq }));
const mockSingle = jest.fn<() => Promise<{
  data: { id: string };
  error: null;
}>>();

jest.mock('@/lib/utils/redis-client', () => ({
  getRedisClient: () => ({
    multi: () => pipeline,
    hdel: mockHdel,
    hvals: mockHvals,
  }),
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      insert: jest.fn(() => ({
        select: jest.fn(() => ({ single: mockSingle })),
      })),
      update: mockUpdate,
    })),
  },
}));

import {
  createStreamingLogCallbacks,
  readLiveInstanceLogSnapshots,
} from '../assistant-streaming-logs';

describe('assistant streaming Redis snapshots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = 'redis://example.test:6379';
    mockExec.mockResolvedValue([]);
    mockHdel.mockResolvedValue(1);
    mockUpdateEq.mockResolvedValue({ error: null });
    mockSingle.mockResolvedValue({ data: { id: 'log-1' }, error: null });
  });

  it('checkpoints the first chunk and always persists the final chunk', async () => {
    const callbacks = createStreamingLogCallbacks(
      'instance-1',
      'site-1',
      'user-1',
      'openai',
    );
    const id = await callbacks.onStreamStart();
    await callbacks.onStreamChunk(id, 'one');
    await callbacks.onStreamChunk(id, 'one two');
    await callbacks.onStreamChunk(id, 'one two three', true);

    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'one two three', details: expect.objectContaining({ streaming: false }),
    }));
    expect(mockHdel).toHaveBeenCalledWith(
      'live:ai-stream:instance:instance-1',
      'log:log-1',
    );
  });

  it('returns only log snapshots from an instance hash', async () => {
    mockHvals.mockResolvedValue([
      JSON.stringify({
        id: 'log-1',
        instance_id: 'instance-1',
        kind: 'log',
        message: 'live',
        updated_at: '2026-09-21T00:00:00.000Z',
      }),
      JSON.stringify({
        id: 'node-1',
        instance_id: 'instance-1',
        kind: 'node',
        message: 'node',
        updated_at: '2026-09-21T00:00:00.000Z',
      }),
    ]);

    await expect(
      readLiveInstanceLogSnapshots('instance-1'),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'log-1', message: 'live' }),
    ]);
  });

  it('keeps the final snapshot when the durable checkpoint fails', async () => {
    mockUpdateEq.mockResolvedValue({
      error: { message: 'database unavailable' },
    });
    const callbacks = createStreamingLogCallbacks(
      'instance-1',
      'site-1',
      'user-1',
      'openai',
    );
    const id = await callbacks.onStreamStart();

    await callbacks.onStreamChunk(id, 'complete text', true);

    expect(mockHdel).not.toHaveBeenCalled();
  });
});
