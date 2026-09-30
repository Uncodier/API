import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OutstandClient } from '../client';

describe('Outstand media API scoped requests', () => {
  let request: jest.SpiedFunction<typeof fetch>;
  const client = new OutstandClient('synthetic-key');
  beforeEach(() => {
    request = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('requests and confirms an upload with the trusted tenant and the same deadline', async () => {
    const controller = new AbortController();
    const init = { success: true, data: { id: 'media-one', upload_url: 'https://account.r2.cloudflarestorage.com/file', expires_in: 3600 } };
    const confirmed = { success: true, data: { id: 'media-one', status: 'active', url: 'https://media.outstand.so/org/file/clip.mp4' } };
    request.mockResolvedValueOnce(new Response(JSON.stringify(init)))
      .mockResolvedValueOnce(new Response(JSON.stringify(confirmed)));
    expect(await client.getUploadUrl('clip.mp4', 'video/mp4', 'site-one', controller.signal)).toEqual(init);
    expect(await client.confirmUpload('media-one', 42, 'site-one', controller.signal)).toEqual(confirmed);
    expect(request).toHaveBeenNthCalledWith(1, 'https://api.outstand.so/v1/media/upload', {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-key', 'X-Tenant-ID': 'site-one', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'clip.mp4', content_type: 'video/mp4' }),
    });
    expect(request).toHaveBeenNthCalledWith(2, 'https://api.outstand.so/v1/media/media-one/confirm', {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-key', 'X-Tenant-ID': 'site-one', 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 42 }),
    });
  });

  it('bounds a cached media lookup without changing the existing optional-signal contract', async () => {
    const signal = new AbortController().signal;
    request.mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} })));
    await client.getMedia('media-one', 'site-one', signal);
    expect(request).toHaveBeenCalledWith('https://api.outstand.so/v1/media/media-one', {
      method: 'GET', signal, redirect: 'error', headers: { Authorization: 'Bearer synthetic-key', 'X-Tenant-ID': 'site-one' },
    });
  });

  it('propagates aborted upload initialization without retrying', async () => {
    const controller = new AbortController();
    controller.abort();
    request.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(client.getUploadUrl('clip.mp4', 'video/mp4', 'site-one', controller.signal)).rejects.toThrow('Aborted');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([200, 400])('bounds actual media API response bytes for HTTP %i without trusting Content-Length', async (status) => {
    request.mockResolvedValue(new Response('x'.repeat(64 * 1024 + 1), { status }));
    await expect(client.getUploadUrl('clip.mp4', 'video/mp4', 'site-one')).rejects.toThrow('media response exceeded');
    expect(request).toHaveBeenCalledTimes(1);
  });
});