import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEval: any = jest.fn();
const mockDel: any = jest.fn();
const mockMget: any = jest.fn();

jest.mock('@/lib/utils/redis-client', () => ({
  getRedisClient: () => ({
    eval: mockEval,
    del: mockDel,
    mget: mockMget,
  }),
}));

import {
  cacheVisitorSession,
  clearVisitorLiveState,
  readCachedVisitorSession,
  recordVisitorHeartbeat,
} from '../visitor-session-live-state';

describe('visitor session live state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = 'redis://example.test:6379';
  });

  it('merges a heartbeat and requests a periodic database flush', async () => {
    mockEval.mockResolvedValue([
      JSON.stringify({ page_views: 3, active_time: 10 }),
      1,
    ]);

    await expect(recordVisitorHeartbeat(
      'site-1',
      'session-1',
      { page_views: 3 },
    )).resolves.toEqual({
      state: { page_views: 3, active_time: 10 },
      shouldPersist: true,
      closed: false,
    });
  });

  it('clears cache, heartbeat, and flush keys together', async () => {
    mockDel.mockResolvedValue(3);

    await clearVisitorLiveState('site-1', 'session-1');

    expect(mockDel).toHaveBeenCalledWith(
      'cache:visitor-session:site-1:session-1',
      'visitor:heartbeat:site-1:session-1',
      'visitor:heartbeat-flush:site-1:session-1',
    );
  });

  it('does not return a cached session after its tombstone is set', async () => {
    mockMget.mockResolvedValue([
      '1',
      JSON.stringify({ id: 'session-1', is_active: true }),
    ]);

    await expect(
      readCachedVisitorSession('site-1', 'session-1'),
    ).resolves.toBeNull();
  });

  it('writes session cache through the tombstone-aware script', async () => {
    mockEval.mockResolvedValue(0);

    await cacheVisitorSession('site-1', 'session-1', {
      id: 'session-1',
      is_active: true,
    });

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("EXISTS', KEYS[2]"),
      2,
      'cache:visitor-session:site-1:session-1',
      'visitor:session-closed:site-1:session-1',
      expect.any(String),
      60,
    );
  });
});
