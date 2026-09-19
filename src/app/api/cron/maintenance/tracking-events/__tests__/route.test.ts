import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { drainTrackingEventQueue } from '@/lib/services/tracking-event-queue';
import {
  recordTelemetry,
  REDIS_TELEMETRY_KEYS,
} from '@/lib/status/telemetry';
import { GET } from '../route';

jest.mock('@/lib/services/tracking-event-queue', () => ({
  drainTrackingEventQueue: jest.fn(),
}));
jest.mock('@/lib/status/telemetry', () => ({
  REDIS_TELEMETRY_KEYS: {
    tracking: 'redis_tracking_queue',
    recordings: 'redis_recording_queue',
  },
  recordTelemetry: jest.fn(),
}));

const mockedDrain = jest.mocked(drainTrackingEventQueue);
const mockedRecordTelemetry = jest.mocked(recordTelemetry);

describe('tracking event queue cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockedRecordTelemetry.mockResolvedValue(undefined);
  });

  it('rejects requests without the configured secret', async () => {
    const response = await GET(new Request('http://localhost'));

    expect(response.status).toBe(401);
    expect(mockedDrain).not.toHaveBeenCalled();
  });

  it('drains the queue for an authenticated request', async () => {
    mockedDrain.mockResolvedValue({
      state: 'processed',
      messages: 2,
      events: 50,
      deadLetters: 0,
      remaining: 0,
    });

    const response = await GET(new Request('http://localhost', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      result: { messages: 2, events: 50 },
    });
    expect(mockedRecordTelemetry).toHaveBeenCalledWith(
      REDIS_TELEMETRY_KEYS.tracking,
      'up',
      expect.stringContaining('50 events'),
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
      REDIS_TELEMETRY_KEYS.tracking,
      'down',
      'Tracking queue drain failed',
      expect.any(Number),
    );
  });
});
