import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const mockEval: any = jest.fn();
const mockXlen: any = jest.fn();

jest.mock('@/lib/utils/redis-client', () => ({
  getRedisClient: () => ({ eval: mockEval, xlen: mockXlen }),
}));

import {
  admitRecordingRequest,
  shouldSampleRecording,
} from '../session-recording-admission';

const originalRedisUrl = process.env.REDIS_URL;

describe('session recording admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = 'redis://example.test:6379';
    mockXlen.mockResolvedValue(0);
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('makes a deterministic session-level sampling decision', () => {
    const first = shouldSampleRecording('site-a', 'session-a', 50);
    const second = shouldSampleRecording('site-a', 'session-a', 50);

    expect(first).toBe(second);
    expect(shouldSampleRecording('site-a', 'session-a', 0)).toBe(false);
    expect(shouldSampleRecording('site-a', 'session-a', 100)).toBe(true);
  });

  it('returns the atomic Redis admission decision', async () => {
    mockEval.mockResolvedValue([1, 'accepted']);

    await expect(admitRecordingRequest({
      siteId: 'site-a',
      sessionId: 'session-a',
      requestBytes: 1024,
      now: 1_000,
    })).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it('rejects admission when the metadata queue backlog is full', async () => {
    mockXlen.mockResolvedValue(300);

    await expect(admitRecordingRequest({
      siteId: 'site-a',
      sessionId: 'session-a',
      requestBytes: 1024,
    })).resolves.toEqual({ accepted: false, reason: 'queue_backlog' });
    expect(mockEval).not.toHaveBeenCalled();
  });

  it('fails closed without Redis so Supabase remains protected', async () => {
    delete process.env.REDIS_URL;

    await expect(admitRecordingRequest({
      siteId: 'site-a',
      sessionId: 'session-a',
      requestBytes: 1024,
    })).resolves.toEqual({
      accepted: false,
      reason: 'admission_unavailable',
    });
    expect(mockEval).not.toHaveBeenCalled();
  });
});
