import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';

const mockUpload: any = jest.fn();
const mockRemove: any = jest.fn();
const mockAdmission: any = jest.fn();
const mockEnqueue: any = jest.fn();
const mockMaybeSingle: any = jest.fn();
const mockEq: any = jest.fn(() => ({
  eq: mockEq,
  maybeSingle: mockMaybeSingle,
}));
const mockSelect: any = jest.fn(() => ({ eq: mockEq }));
const mockFrom: any = jest.fn(() => ({ select: mockSelect }));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: mockFrom,
    storage: {
      from: jest.fn(() => ({ upload: mockUpload, remove: mockRemove })),
    },
  },
}));
jest.mock('@/lib/services/session-recording-admission', () => ({
  admitRecordingRequest: mockAdmission,
}));
jest.mock('@/lib/services/session-recording-queue', () => ({
  enqueueRecordingMetadata: mockEnqueue,
}));
jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: jest.fn(async () => true),
  originBelongsToSite: jest.fn(async () => true),
}));
jest.mock('@/lib/security/visitor-session-token', () => ({
  verifyVisitorSessionToken: jest.fn(async () => true),
  visitorSessionTokenFromRequest: jest.fn(() => 'session-token'),
}));

import { POST } from '../route';

const siteId = '33333333-3333-4333-8333-333333333333';
const sessionId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';
const chunkId = '44444444-4444-4444-8444-444444444444';

describe('visitor recording route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpload.mockResolvedValue({ error: null });
    mockRemove.mockResolvedValue({ error: null });
    mockAdmission.mockResolvedValue({ accepted: true, reason: 'accepted' });
    mockEnqueue.mockResolvedValue('1-0');
    mockMaybeSingle.mockResolvedValue({
      data: { id: sessionId, visitor_id: visitorId, is_active: true },
      error: null,
    });
  });

  it('uses a stable storage path and queues chunk metadata', async () => {
    const serializedEvents = JSON.stringify([
      { timestamp: 900 },
      { timestamp: 1000 },
    ]);
    const contentHash = createHash('sha256')
      .update(serializedEvents)
      .digest('hex');
    const storagePath =
      `${siteId}/${sessionId}/1000_${chunkId}_${contentHash}.json`;
    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        visitor_id: visitorId,
        chunk_id: chunkId,
        chunk_timestamp: 1000,
        url: 'https://example.com/',
        events: [{ timestamp: 900 }, { timestamp: 1000 }],
        metadata: { device_type: 'desktop' },
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledWith(
      storagePath,
      serializedEvents,
      { contentType: 'application/json', upsert: false },
    );
    expect(mockEnqueue).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          session_id: sessionId,
          storage_path: storagePath,
          chunk_id: chunkId,
          content_hash: contentHash,
          event_count: 2,
          metadata: { device_type: 'desktop' },
        }),
      ],
    );
  });

  it('keeps only bounded known metadata fields', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        events: [{ timestamp: 1000 }],
        metadata: {
          device_type: 'mobile',
          screen_size: '390x844',
          arbitrary: 'x'.repeat(10_000),
        },
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledWith([
      expect.objectContaining({
        metadata: { device_type: 'mobile', screen_size: '390x844' },
      }),
    ]);
  });

  it('uploads three chunks but queues their metadata once', async () => {
    const chunkIds = [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chunks: chunkIds.map((id, index) => ({
          site_id: siteId,
          session_id: sessionId,
          visitor_id: visitorId,
          chunk_id: id,
          chunk_timestamp: 1000 + index,
          events: [{ timestamp: 1000 + index }],
        })),
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledTimes(3);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.arrayContaining(
        chunkIds.map((id) => expect.objectContaining({ chunk_id: id })),
      ),
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ success: true, accepted: 3 }),
    );
  });

  it('continues an idempotent retry when the immutable object exists', async () => {
    mockUpload.mockResolvedValue({
      error: { statusCode: 409, error: 'Duplicate' },
    });

    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        chunk_id: chunkId,
        chunk_timestamp: 1000,
        events: [{ timestamp: 1000 }],
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('derives a stable identity for legacy retries without a chunk ID', async () => {
    const body = JSON.stringify({
      site_id: siteId,
      session_id: sessionId,
      timestamp: 1000,
      events: [{ timestamp: 1000 }],
    });

    await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }) as never);
    await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }) as never);

    expect(mockUpload.mock.calls[0][0]).toBe(mockUpload.mock.calls[1][0]);
    const firstChunkId = mockEnqueue.mock.calls[0][0][0].chunk_id;
    const secondChunkId = mockEnqueue.mock.calls[1][0][0].chunk_id;
    expect(firstChunkId).toBe(secondChunkId);
  });

  it('rejects batches larger than three chunks', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chunks: Array.from({ length: 4 }, (_, index) => ({
          site_id: siteId,
          session_id: sessionId,
          events: [{ timestamp: 1000 + index }],
        })),
      }),
    }) as never);

    expect(response.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('returns 400 for null chunk entries', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: [null] }),
    }) as never);

    expect(response.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does not persist metadata when the storage upload fails', async () => {
    mockUpload.mockResolvedValue({
      error: { message: 'Storage unavailable' },
    });

    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        events: [{ timestamp: 1000 }],
      }),
    }) as never);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).not.toBeNull();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('drops sampled-out sessions before calling Supabase', async () => {
    mockAdmission.mockResolvedValue({
      accepted: false,
      reason: 'sampled_out',
    });

    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        chunk_id: chunkId,
        chunk_timestamp: 1000,
        events: [{ timestamp: 1000 }],
      }),
    }) as never);

    expect(response.status).toBe(202);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      accepted: 0,
      reason: 'sampled_out',
    });
  });

  it('rejects a session that does not belong to the supplied site before upload', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        events: [{ timestamp: 1000 }],
      }),
    }) as never);

    expect(response.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockAdmission).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('drops uploaded chunks if the queue fills after admission', async () => {
    mockEnqueue.mockResolvedValue(null);

    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        events: [{ timestamp: 1000 }],
      }),
    }) as never);

    expect(response.status).toBe(202);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      accepted: 0,
      reason: 'queue_backlog',
    });
  });

  it('removes newly uploaded objects when metadata cannot be queued', async () => {
    mockEnqueue.mockRejectedValue(new Error('Redis unavailable'));

    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: siteId,
        session_id: sessionId,
        chunk_id: chunkId,
        chunk_timestamp: 1000,
        events: [{ timestamp: 1000 }],
      }),
    }) as never);

    expect(response.status).toBe(503);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(response.headers.get('Retry-After')).not.toBeNull();
  });
});
