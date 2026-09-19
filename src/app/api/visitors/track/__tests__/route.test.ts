import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEnqueue: any = jest.fn();

jest.mock('@/lib/services/tracking-event-queue', () => ({
  enqueueTrackingEvents: mockEnqueue,
}));

import { POST } from '../route';

const siteId = '33333333-3333-4333-8333-333333333333';

describe('visitor tracking route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue('1-0');
  });

  it('preserves a client event id and acknowledges only after enqueue', async () => {
    const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = await POST(new Request(
      'http://localhost/api/visitors/track',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_id: eventId,
          site_id: siteId,
          event_type: 'pageview',
          url: 'https://example.com/',
          timestamp: 1000,
        }),
      },
    ) as never);

    expect(response.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith([
      expect.objectContaining({ id: eventId, timestamp: 1000 }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      event_id: eventId,
      queued: true,
    });
  });

  it('returns 503 when the durable queue is unavailable', async () => {
    mockEnqueue.mockRejectedValue(new Error('Redis unavailable'));

    const response = await POST(new Request(
      'http://localhost/api/visitors/track',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          site_id: siteId,
          event_type: 'pageview',
          url: 'https://example.com/',
        }),
      },
    ) as never);

    expect(response.status).toBe(503);
  });
});
