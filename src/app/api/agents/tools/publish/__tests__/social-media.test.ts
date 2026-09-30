import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { prepareSocialMedia, type SocialMediaInput } from '../social-media';

const siteId = '00000000-0000-4000-8000-000000000001';
const image = `https://db.makinari.com/storage/v1/object/public/generative_images/${siteId}/launch.png`;
const video = `https://db.makinari.com/storage/v1/object/public/generative_videos/${siteId}/launch.mp4`;
const providerImage = 'https://media.outstand.so/org_example/file-id/launch.jpg';
const projectImage = 'https://current-project.supabase.co/storage/v1/object/public/assets/site/photo.jpg';
const getMedia = jest.fn<(id: string, tenantId: string) => Promise<unknown>>();
const client = { getMedia };
const originalSupabase = process.env.SUPABASE_URL;
const originalPublicSupabase = process.env.NEXT_PUBLIC_SUPABASE_URL;
let fetchSpy: jest.SpiedFunction<typeof fetch>;

function activeMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    status: 'active',
    url: providerImage,
    filename: 'launch.jpg',
    content_type: 'image/jpeg',
    expires_at: '2099-01-01T00:00:00.000Z',
    tenant_id: siteId,
    ...overrides,
  };
}

beforeEach(() => {
  getMedia.mockReset();
  process.env.SUPABASE_URL = 'https://current-project.supabase.co';
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Network calls are forbidden in media preparation tests.');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  if (originalSupabase === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalSupabase;
  if (originalPublicSupabase === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalPublicSupabase;
});

describe('prepareSocialMedia', () => {
  it('preserves text and attaches a generated image without a caption URL or network call', async () => {
    expect(await prepareSocialMedia(client, siteId, { text: 'A launch\n#news', urls: [image] })).toEqual({
      content: 'A launch\n#news', media: [{ url: image, filename: 'launch.png' }],
    });
    expect(getMedia).not.toHaveBeenCalled();
  });

  it('classifies pathname extensions case-insensitively, not query strings or fragments', async () => {
    const queriedImage = image.replace('launch.png', 'launch.PNG') + '?download=1&version=2#preview';
    const link = 'https://example.com/article?image=photo.jpg#clip.mp4';
    expect(await prepareSocialMedia(client, siteId, { urls: [queriedImage, video, link] })).toEqual({
      content: link,
      media: [
        { url: queriedImage.split('#')[0], filename: 'launch.PNG' },
        { url: video, filename: 'launch.mp4' },
      ],
    });
  });

  it('keeps ordinary external links in content without applying the storage allowlist', async () => {
    const links = ['https://example.com/blog', 'http://example.org/news', 'https://example.com/report.pdf'];
    expect(await prepareSocialMedia(client, siteId, { text: 'Read more', urls: [...links, links[0]] })).toEqual({
      content: ['Read more', ...links].join('\n\n'), media: [],
    });
    expect(getMedia).not.toHaveBeenCalled();
  });

  it('allows media-only posts and explicit trusted public media URLs', async () => {
    expect(await prepareSocialMedia(client, siteId, { media_urls: [projectImage, providerImage] })).toEqual({
      content: '',
      media: [{ url: projectImage, filename: 'photo.jpg' }, { url: providerImage, filename: 'launch.jpg' }],
    });
  });

  it('allows the configured NEXT_PUBLIC_SUPABASE_URL project when no server URL exists', async () => {
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://current-project.supabase.co';
    expect((await prepareSocialMedia(client, siteId, { media_urls: [projectImage] })).media).toHaveLength(1);
  });

  it('accepts documented Outstand organization paths and normalized video rendition paths', async () => {
    const rendition = 'https://media.outstand.so/renditions/org-example/568/master.mp4';
    expect((await prepareSocialMedia(client, siteId, { media_urls: [providerImage, rendition] })).media).toEqual([
      { url: providerImage, filename: 'launch.jpg' }, { url: rendition, filename: 'master.mp4' },
    ]);
  });

  it('deduplicates attachments across urls, media_urls, and resolved assets', async () => {
    getMedia.mockResolvedValue({ success: true, data: activeMedia({ filename: 'original.jpg' }) });
    expect(await prepareSocialMedia(client, siteId, {
      urls: [providerImage, `${providerImage}#preview`],
      media_urls: [providerImage], assets: ['media-1', 'media-1'],
    })).toEqual({ content: '', media: [{ url: providerImage, filename: 'original.jpg' }] });
    expect(getMedia).toHaveBeenCalledTimes(1);
    expect(getMedia).toHaveBeenCalledWith('media-1', siteId);
  });

  it('decodes and cleans filenames without carrying query parameters or fragments', async () => {
    const url = image.replace('launch.png', 'launch%20photo%20%281%29.png') + '?download=1';
    expect((await prepareSocialMedia(client, siteId, { media_urls: [url] })).media[0]).toEqual({
      url, filename: 'launch_photo__1_.png',
    });
  });

  it.each([
    'not a url', '//media.outstand.so/photo.jpg', 'ftp://media.outstand.so/photo.jpg',
    'data:image/png;base64,example', 'javascript:alert(1)',
    'http://media.outstand.so/photo.jpg',
    'https://user:secret@media.outstand.so/photo.jpg',
    'https://media.outstand.so:8443/photo.jpg',
    'https://media.outstand.so.evil.example/photo.jpg',
    'https://evil.example/media.outstand.so/photo.jpg',
    'https://api.outstand.so/photo.jpg',
    'https://org-example.media.outstand.so/photo.jpg',
    'https://org-example.outstand.so/photo.jpg',
    'https://media.outstand.so./photo.jpg',
    'https://127.0.0.1/photo.jpg', 'https://2130706433/photo.jpg',
    'https://[::1]/photo.jpg', 'https://[::ffff:127.0.0.1]/photo.jpg',
    'https://169.254.169.254/photo.jpg', 'https://10.0.0.1/photo.jpg',
    'https://localhost/photo.jpg', 'https://internal.local/photo.jpg',
    'https://other-project.supabase.co/storage/v1/object/public/assets/photo.jpg',
    'https://db.makinari.com/rest/v1/assets/photo.jpg',
    'https://db.makinari.com/storage/v1/object/sign/assets/photo.jpg?token=secret',
    'https://db.makinari.com/storage/v1/object/public/private-bucket/photo.jpg',
    'https://db.makinari.com/storage/v1/object/public/assets/',
    'https://db.makinari.com/storage/v1/object/public/assets/../photo.jpg',
    'https://db.makinari.com/storage/v1/object/public/assets/%2e%2e/photo.jpg',
    'https://db.makinari.com/storage/v1/object/public/assets/a%2fb/photo.jpg',
    'https://db.makinari.com/storage/v1/object/public/assets/%252e%252e/photo.jpg',
    'https://media.outstand.so/a%5cb/photo.jpg',
    'https://media.outstand.so/a%00b/photo.jpg',
    'https://media.outstand.so/bad%zz.jpg',
    'https://media.outstand.so/photo\n.jpg',
    'https://media.outstand.so\\@evil.example/photo.jpg',
  ])('rejects unsafe or non-allowlisted media URL %s', async (url) => {
    await expect(prepareSocialMedia(client, siteId, { media_urls: [url] })).rejects.toThrow();
    expect(getMedia).not.toHaveBeenCalled();
  });

  it.each([
    'https://127.0.0.1', 'https://localhost', 'https://internal.local',
    'https://current-project.supabase.co.evil.example',
    'https://user:password@current-project.supabase.co',
    'https://current-project.supabase.co:8443',
    'http://current-project.supabase.co', 'not a URL',
  ])('does not trust unsafe Supabase configuration %s', async (origin) => {
    process.env.SUPABASE_URL = origin;
    await expect(prepareSocialMedia(client, siteId, { media_urls: [projectImage] })).rejects.toThrow();
  });

  it('rejects untrusted legacy media urls rather than publishing them as caption links', async () => {
    await expect(prepareSocialMedia(client, siteId, { urls: ['https://evil.example/photo.jpg'] }))
      .rejects.toThrow('trusted public HTTPS storage');
  });

  it.each(['https://example.com', 'https://media.outstand.so/file', 'https://media.outstand.so/file.pdf']) (
    'does not invent an image filename for explicit non-media URL %s', async (url) => {
      await expect(prepareSocialMedia(client, siteId, { media_urls: [url] })).rejects.toThrow();
    },
  );

  it.each([null, {}, 1, 'one', [1], [''], ['  '], [null], [{ url: image }], Array(1)])(
    'validates runtime list shape and entries: %j', async (value) => {
      for (const key of ['urls', 'media_urls', 'assets']) {
        await expect(prepareSocialMedia(client, siteId, { text: 'caption', [key]: value } as SocialMediaInput))
          .rejects.toThrow();
      }
      expect(getMedia).not.toHaveBeenCalled();
    },
  );

  it('validates URL, asset ID, list, and content length bounds before asset lookup', async () => {
    const cases: SocialMediaInput[] = [
      { urls: Array(51).fill('https://example.com') },
      { media_urls: Array(21).fill(image) }, { assets: Array(21).fill('media-1') },
      { media_urls: [image + '?x=' + 'x'.repeat(8192)] },
      { assets: ['x'.repeat(201)] }, { text: 'x'.repeat(100_001) },
      { text: 'x'.repeat(99_999), urls: ['https://example.com'], assets: ['media-1'] },
      { urls: Array.from({ length: 21 }, (_, i) => image.replace('launch', `launch-${i}`)) },
    ];
    for (const input of cases) await expect(prepareSocialMedia(client, siteId, input)).rejects.toThrow();
    expect(getMedia).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '../other', 'media/id', 'media?tenant=other', 'https://example.com', 'media#fragment']) (
    'rejects unsafe asset IDs %s before lookup', async (id) => {
      await expect(prepareSocialMedia(client, siteId, { assets: [id] })).rejects.toThrow();
      expect(getMedia).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, '', ' ', 'site\nother', '../site']) (
    'requires a trusted nonempty siteId %j', async (id) => {
      await expect(prepareSocialMedia(client, id as string, { text: 'caption' })).rejects.toThrow();
      expect(getMedia).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, [], 'text', {}, { text: '  ' }, { text: 1 }, { text: null }]) (
    'rejects invalid or empty input %j', async (input) => {
      await expect(prepareSocialMedia(client, siteId, input as SocialMediaInput)).rejects.toThrow();
    },
  );
});

describe('uploaded Outstand media', () => {
  it('resolves an active tenant-scoped uploaded asset to the provider URL/filename, never just an ID', async () => {
    getMedia.mockResolvedValue({ success: true, data: activeMedia() });
    const result = await prepareSocialMedia(client, siteId, { text: 'caption', assets: ['media-1'] });
    expect(getMedia).toHaveBeenCalledWith('media-1', siteId);
    expect(result).toEqual({ content: 'caption', media: [{ url: providerImage, filename: 'launch.jpg' }] });
    expect(result.media[0]).not.toHaveProperty('id');
  });

  it('supports a successful top-level media envelope and header-scoped responses without tenant metadata', async () => {
    const { tenant_id: _tenantId, ...data } = activeMedia();
    getMedia.mockResolvedValue({ success: true, ...data });
    expect((await prepareSocialMedia(client, siteId, { assets: ['media-1'] })).media).toHaveLength(1);
    expect(getMedia).toHaveBeenCalledWith('media-1', siteId);
  });

  it('uses a verified uploaded filename when the provider URL has no extension', async () => {
    getMedia.mockResolvedValue({ success: true, data: activeMedia({ url: 'https://media.outstand.so/org/file-id' }) });
    expect((await prepareSocialMedia(client, siteId, { assets: ['media-1'] })).media).toEqual([
      { url: 'https://media.outstand.so/org/file-id', filename: 'launch.jpg' },
    ]);
  });

  it('accepts ready uploaded video and rejects a total attachment count over the bound', async () => {
    getMedia.mockResolvedValue({ success: true, data: activeMedia({
      url: video, filename: 'launch.mp4', content_type: 'video/mp4', video: { status: 'ready' },
    }) });
    expect((await prepareSocialMedia(client, siteId, { assets: ['media-1'] })).media[0].filename).toBe('launch.mp4');
    await expect(prepareSocialMedia(client, siteId, {
      media_urls: Array.from({ length: 20 }, (_, i) => image.replace('launch', `launch-${i}`)), assets: ['media-1'],
    })).rejects.toThrow('At most 20');
  });

  it.each([
    null, [], {}, { success: false, data: activeMedia() }, { success: 'true', data: activeMedia() },
    { data: activeMedia() }, { success: true, data: null }, { success: true, data: [] },
    { success: true, error: 'failed', data: activeMedia() },
    { success: true, tenant_id: 'other-site', data: activeMedia() },
  ])('rejects failed, malformed, or foreign tenant envelopes %j', async (response) => {
    getMedia.mockResolvedValue(response);
    await expect(prepareSocialMedia(client, siteId, { assets: ['media-1'] })).rejects.toThrow();
  });

  it.each([
    { id: 'other-id' }, { id: undefined }, { url: undefined }, { url: 'https://evil.example/photo.jpg' },
    { filename: undefined }, { filename: '../photo.jpg' }, { filename: 'photo.jpg?secret=1' },
    { filename: 'photo.jpg#fragment' }, { filename: 'not-media.pdf' },
    { filename: 'x'.repeat(256) + '.jpg' }, { filename: 'bad\nname.jpg' },
    { tenant_id: 'other-site' }, { tenantId: 'other-site' }, { siteId: 'other-site' },
    { site_id: 'other-site' }, { tenant_id: null },
    { status: undefined }, { status: 'pending' }, { status: 'deleted' }, { status: 'failed' },
    { video: { status: 'pending' } }, { video: { status: 'processing' } }, { video: { status: 'failed' } },
    { video: {} }, { video: [] },
    { expires_at: '2020-01-01T00:00:00Z' }, { expires_at: 'invalid' }, { expires_at: null },
    { content_type: 'application/pdf' }, { content_type: 3 }, { error: 'failed' },
  ])('rejects malformed, foreign, unsafe, or unready media %j', async (overrides) => {
    getMedia.mockResolvedValue({ success: true, data: activeMedia(overrides) });
    await expect(prepareSocialMedia(client, siteId, { assets: ['media-1'] })).rejects.toThrow();
  });

  it('sanitizes lookup failures instead of exposing upstream secrets or URLs', async () => {
    getMedia.mockRejectedValue(new Error('upstream secret and private URL'));
    await expect(prepareSocialMedia(client, siteId, { assets: ['media-1'] }))
      .rejects.toThrow('Unable to resolve uploaded Outstand media for this site.');
  });

  it('validates all direct input before the first provider lookup', async () => {
    await expect(prepareSocialMedia(client, siteId, { assets: ['media-1'], media_urls: ['https://evil.example/a.jpg'] }))
      .rejects.toThrow();
    expect(getMedia).not.toHaveBeenCalled();
  });
});