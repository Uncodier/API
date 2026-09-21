import { afterEach, describe, expect, it, jest } from '@jest/globals';

const getPublicUrl = jest.fn(() => ({
  data: {
    publicUrl: 'https://db.example/storage/v1/object/public/generative_images/prompt_cache/hash',
  },
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({ getPublicUrl }),
    },
  },
}));

import { downloadFromCache } from '../promptImageCache';

describe('prompt image cache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('downloads cached images through the public bucket URL', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('image'), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const cached = await downloadFromCache('hash');

    expect(getPublicUrl).toHaveBeenCalledWith('prompt_cache/hash');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://db.example/storage/v1/object/public/generative_images/prompt_cache/hash',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(cached?.buffer.toString()).toBe('image');
    expect(cached?.mimeType).toBe('image/png');
  });

  it('treats Supabase NoSuchKey responses as cache misses', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      Response.json(
        {
          statusCode: '404',
          error: 'not_found',
          message: 'Object not found',
          code: 'NoSuchKey',
        },
        { status: 400 },
      ),
    );

    await expect(downloadFromCache('missing')).resolves.toBeNull();
  });

  it('preserves real storage failures as errors', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      Response.json(
        { message: 'Storage unavailable', code: 'InternalError' },
        { status: 500 },
      ),
    );

    await expect(downloadFromCache('hash')).rejects.toThrow(
      'Image cache lookup failed: Storage returned 500: Storage unavailable',
    );
  });
});
