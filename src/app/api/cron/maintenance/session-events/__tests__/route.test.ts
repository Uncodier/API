import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runSessionEventRetention } from '@/lib/services/session-event-retention';
import { GET } from '../route';

jest.mock('@/lib/services/session-event-retention', () => ({
  runSessionEventRetention: jest.fn(),
}));

const mockedRetention = jest.mocked(runSessionEventRetention);

describe('session event retention cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('rejects requests when the cron secret is missing', async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request('http://localhost/api/cron/maintenance/session-events', {
      headers: { authorization: 'Bearer undefined' },
    }));

    expect(response.status).toBe(401);
    expect(mockedRetention).not.toHaveBeenCalled();
  });

  it('runs retention for an authenticated cron request', async () => {
    mockedRetention.mockResolvedValue({
      cutoff: '2026-08-18T00:00:00.000Z',
      protectedSites: 2,
      scannedEvents: 15,
      deletedEvents: 15,
      deletedRecordingObjects: 3,
      storageErrors: 0,
      hasMore: false,
    });

    const response = await GET(new Request('http://localhost/api/cron/maintenance/session-events', {
      headers: { authorization: 'Bearer test-secret' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      result: { deletedEvents: 15, protectedSites: 2 },
    });
    expect(mockedRetention).toHaveBeenCalledTimes(1);
  });
});
