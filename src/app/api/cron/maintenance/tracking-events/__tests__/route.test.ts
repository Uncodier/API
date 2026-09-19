import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { drainTrackingEventQueue } from '@/lib/services/tracking-event-queue';
import { GET } from '../route';

jest.mock('@/lib/services/tracking-event-queue', () => ({
  drainTrackingEventQueue: jest.fn(),
}));

const mockedDrain = jest.mocked(drainTrackingEventQueue);

describe('tracking event queue cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
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
  });
});
