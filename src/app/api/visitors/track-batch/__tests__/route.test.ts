import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEnqueue: any = jest.fn();

jest.mock('@/lib/services/tracking-event-queue', () => ({
  enqueueTrackingEvents: mockEnqueue,
}));

import { POST } from '../route';

const sessionId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';
const siteId = '33333333-3333-4333-8333-333333333333';

describe('visitor tracking batch route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue('1-0');
  });

  it('queues validated events without touching Supabase', async () => {
    const response = await POST(new Request(
      'http://localhost/api/visitors/track-batch',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'test-agent',
          'x-forwarded-for': '203.0.113.10, 10.0.0.1',
        },
        body: JSON.stringify([
          {
            event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            site_id: siteId,
            visitor_id: visitorId,
            session_id: sessionId,
            event_type: 'pageview',
            url: 'https://example.com/',
            timestamp: 1000,
          },
          {
            event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            site_id: siteId,
            visitor_id: visitorId,
            session_id: sessionId,
            event_type: 'click',
            url: 'https://example.com/',
            timestamp: 1001,
            properties: { x: 10, y: 20 },
          },
        ]),
      },
    ) as never);

    expect(response.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        event_type: 'pageview',
        ip: '203.0.113.10',
      }),
      expect.objectContaining({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        properties: { x: 10, y: 20 },
      }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      accepted: 2,
      queued: true,
      queue_message_id: '1-0',
    });
  });

  it('rejects an empty batch without enqueueing', async () => {
    const response = await POST(new Request(
      'http://localhost/api/visitors/track-batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([]),
      },
    ) as never);

    expect(response.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('uses the supported id alias as the visitor id', async () => {
    const response = await POST(new Request(
      'http://localhost/api/visitors/track-batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{
          site_id: siteId,
          id: visitorId,
          session_id: sessionId,
          event_type: 'pageview',
          url: 'https://example.com/',
        }]),
      },
    ) as never);

    expect(response.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith([
      expect.objectContaining({ visitor_id: visitorId }),
    ]);
  });

  it('returns 503 so the client can retry when Redis is unavailable', async () => {
    mockEnqueue.mockRejectedValue(new Error('Redis unavailable'));

    const response = await POST(new Request(
      'http://localhost/api/visitors/track-batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{
          site_id: siteId,
          event_type: 'pageview',
          url: 'https://example.com/',
        }]),
      },
    ) as never);

    expect(response.status).toBe(503);
  });

  it('rejects malformed event-specific payloads as one batch', async () => {
    const response = await POST(new Request(
      'http://localhost/api/visitors/track-batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{
          site_id: siteId,
          event_type: 'purchase',
          url: 'https://example.com/',
          properties: { order_id: 'order-1' },
        }]),
      },
    ) as never);

    expect(response.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
