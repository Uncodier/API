import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { drainRecordingMetadataQueue } from '@/lib/services/session-recording-queue';
import { GET } from '../route';

jest.mock('@/lib/services/session-recording-queue', () => ({
  drainRecordingMetadataQueue: jest.fn(),
}));

const mockedDrain = jest.mocked(drainRecordingMetadataQueue);

describe('session recording metadata cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('rejects requests when the cron secret is missing', async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer undefined' },
    }));

    expect(response.status).toBe(401);
    expect(mockedDrain).not.toHaveBeenCalled();
  });

  it('drains recording metadata for an authenticated request', async () => {
    mockedDrain.mockResolvedValue({
      state: 'processed',
      messages: 3,
      chunks: 9,
      rpcCalls: 1,
      deadLetters: 0,
      remaining: 0,
    });

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      result: { messages: 3, rpcCalls: 1 },
    });
  });
});
