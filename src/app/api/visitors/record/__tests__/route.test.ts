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
      'append_session_recording_chunk',
      expect.objectContaining({
        p_session_id: sessionId,
        p_storage_path: storagePath,
        p_chunk_id: chunkId,
        p_content_hash: contentHash,
        p_event_count: 2,
      }),
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

    expect(response.status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
