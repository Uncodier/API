import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  getLatestTelemetry,
  REDIS_TELEMETRY_KEYS,
  type TelemetryRecord,
} from '@/lib/status/telemetry';
import { redisHandler } from '@/lib/status/handlers/redis';

jest.mock('@/lib/status/telemetry', () => ({
  REDIS_TELEMETRY_KEYS: {
    tracking: 'redis_tracking_queue',
    recordings: 'redis_recording_queue',
  },
  getLatestTelemetry: jest.fn(),
}));

const mockedGetLatestTelemetry = jest.mocked(getLatestTelemetry);

function telemetry(
  status: TelemetryRecord['status'],
  message: string,
  createdAt = new Date().toISOString(),
): TelemetryRecord {
  return {
    status,
    message,
    latency_ms: 25,
    created_at: createdAt,
  };
}

describe('Redis passive telemetry handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = 'rediss://example.test:6379';
  });

  it('reports healthy when both queue signals are recent and healthy', async () => {
    mockedGetLatestTelemetry.mockImplementation(async (key) => (
      key === REDIS_TELEMETRY_KEYS.tracking
        ? telemetry('up', 'Tracking queue empty')
        : telemetry('up', 'Recording queue empty')
    ));

    const result = await redisHandler.runCheck();

    expect(result.status).toBe('up');
    expect(result.checks).toMatchObject({
      configured: true,
      tracking: { found: true, stale: false },
      recordings: { found: true, stale: false },
    });
  });

  it('reports down when either queue reports a failure', async () => {
    mockedGetLatestTelemetry.mockImplementation(async (key) => (
      key === REDIS_TELEMETRY_KEYS.tracking
        ? telemetry('down', 'Tracking queue drain failed')
        : telemetry('up', 'Recording queue empty')
    ));

    await expect(redisHandler.runCheck()).resolves.toMatchObject({
      status: 'down',
      summary: 'A Redis-backed queue reported a failure',
    });
  });

  it('reports degraded when queue telemetry is stale or incomplete', async () => {
    mockedGetLatestTelemetry.mockImplementation(async (key) => (
      key === REDIS_TELEMETRY_KEYS.tracking
        ? telemetry(
            'up',
            'Tracking queue empty',
            new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          )
        : null
    ));

    await expect(redisHandler.runCheck()).resolves.toMatchObject({
      status: 'degraded',
    });
  });

  it('reports skipped while waiting for the first passive signals', async () => {
    mockedGetLatestTelemetry.mockResolvedValue(null);

    await expect(redisHandler.runCheck()).resolves.toMatchObject({
      status: 'skipped',
    });
  });
});
