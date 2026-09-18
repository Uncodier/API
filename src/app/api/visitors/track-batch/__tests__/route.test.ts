import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSessionUpsert: any = jest.fn();
const mockEventInsert: any = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table === 'visitor_sessions') {
        return { upsert: mockSessionUpsert };
      }
      if (table === 'session_events') {
        return { insert: mockEventInsert };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  },
}));

import { POST } from '../route';

const sessionId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';
const siteId = '33333333-3333-4333-8333-333333333333';

describe('visitor tracking batch route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionUpsert.mockResolvedValue({ error: null });
    mockEventInsert.mockResolvedValue({ error: null });
  });

  it('initializes each session once and inserts all events in one batch', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/track-batch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'test-agent',
        'x-forwarded-for': '203.0.113.10, 10.0.0.1',
      },
      body: JSON.stringify([
        {
          site_id: siteId,
          visitor_id: visitorId,
          session_id: sessionId,
          event_type: 'pageview',
          url: 'https://example.com/',
          timestamp: 1000,
        },
        {
          site_id: siteId,
          visitor_id: visitorId,
          session_id: sessionId,
          event_type: 'click',
          url: 'https://example.com/',
          timestamp: 1001,
          properties: { x: 10, y: 20 },
        },
      ]),
    }) as never);

    expect(response.status).toBe(200);
    expect(mockSessionUpsert).toHaveBeenCalledWith(
      [expect.objectContaining({ id: sessionId, visitor_id: visitorId })],
      { onConflict: 'id', ignoreDuplicates: true },
    );
    expect(mockEventInsert).toHaveBeenCalledWith([
      expect.objectContaining({ event_type: 'pageview', ip: '203.0.113.10' }),
      expect.objectContaining({ event_type: 'click', properties: { x: 10, y: 20 } }),
    ]);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      accepted: 2,
    });
  });

  it('rejects an empty batch without touching the database', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/track-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    }) as never);

    expect(response.status).toBe(400);
    expect(mockSessionUpsert).not.toHaveBeenCalled();
    expect(mockEventInsert).not.toHaveBeenCalled();
  });

  it('uses the supported id alias when initializing a visitor session', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/track-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{
        site_id: siteId,
        id: visitorId,
        session_id: sessionId,
        event_type: 'pageview',
        url: 'https://example.com/',
      }]),
    }) as never);

    expect(response.status).toBe(200);
    expect(mockSessionUpsert).toHaveBeenCalledWith(
      [expect.objectContaining({ visitor_id: visitorId })],
      expect.anything(),
    );
  });

  it('rejects malformed event-specific payloads as one batch', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/track-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{
        site_id: siteId,
        event_type: 'purchase',
        url: 'https://example.com/',
        properties: { order_id: 'order-1' },
      }]),
    }) as never);

    expect(response.status).toBe(400);
    expect(mockEventInsert).not.toHaveBeenCalled();
  });
});
