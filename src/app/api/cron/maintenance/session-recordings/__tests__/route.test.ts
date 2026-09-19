import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { drainRecordingMetadataQueue } from '@/lib/services/session-recording-queue';
import {
  recordTelemetry,
  REDIS_TELEMETRY_KEYS,
} from '@/lib/status/telemetry';
import { GET } from '../route';

jest.mock('@/lib/services/session-recording-queue', () => ({
  drainRecordingMetadataQueue: jest.fn(),
}));
jest.mock('@/lib/status/telemetry', () => ({
  REDIS_TELEMETRY_KEYS: {
    tracking: 'redis_tracking_queue',
    recordings: 'redis_recording_queue',
  },
  recordTelemetry: jest.fn(),
}));

const mockedDrain = jest.mocked(drainRecordingMetadataQueue);
const mockedRecordTelemetry = jest.mocked(recordTelemetry);

describe('session recording metadata cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockedRecordTelemetry.mockResolvedValue(undefined);
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
    expect(mockedRecordTelemetry).toHaveBeenCalledWith(
      REDIS_TELEMETRY_KEYS.recordings,
      'up',
      expect.stringContaining('9 chunks'),
      expect.any(Number),
    );
  });

  it('records passive failure telemetry when the queue cannot drain', async () => {
    mockedDrain.mockRejectedValue(new Error('Redis unavailable'));

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(500);
    expect(mockedRecordTelemetry).toHaveBeenCalledWith(
      REDIS_TELEMETRY_KEYS.recordings,
      'down',
      'Recording queue drain failed',
      expect.any(Number),
    );
  });
});
