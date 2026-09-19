import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';

const mockUpload: any = jest.fn();
const mockRpc: any = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn(() => ({ upload: mockUpload })),
    },
    rpc: mockRpc,
  },
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
    mockRpc.mockResolvedValue({
      data: { state: 'updated', event_id: 'event-1' },
      error: null,
    });
  });

  it('uses a stable storage path and atomically records chunk metadata', async () => {
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
    expect(mockRpc).toHaveBeenCalledWith(
      'append_session_recording_chunks',
      {
        p_chunks: [
          expect.objectContaining({
            session_id: sessionId,
            storage_path: storagePath,
            chunk_id: chunkId,
            content_hash: contentHash,
            event_count: 2,
          }),
        ],
      },
    );
  });

  it('uploads three chunks but persists their metadata with one RPC', async () => {
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
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      'append_session_recording_chunks',
      {
        p_chunks: expect.arrayContaining(
          chunkIds.map((id) => expect.objectContaining({ chunk_id: id })),
        ),
      },
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
    expect(mockRpc).toHaveBeenCalledTimes(1);
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
    const firstChunkId = mockRpc.mock.calls[0][1].p_chunks[0].chunk_id;
    const secondChunkId = mockRpc.mock.calls[1][1].p_chunks[0].chunk_id;
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
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns 400 for null chunk entries', async () => {
    const response = await POST(new Request('http://localhost/api/visitors/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: [null] }),
    }) as never);

    expect(response.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
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
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns Retry-After when PostgreSQL cancels the metadata query', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'statement timeout' },
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

    expect(response.status).toBe(503);
    const retryAfter = Number(response.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(10);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });
});
