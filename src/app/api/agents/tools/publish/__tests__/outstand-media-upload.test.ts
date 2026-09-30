import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { OutstandClient } from '@/lib/integrations/outstand/client';

const downloadMedia = jest.fn<(...args: unknown[]) => Promise<{ bytes: Uint8Array; contentType: string }>>();
const putMedia = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../media-transfer-http', () => ({ downloadMedia, putMedia }));
let ensureOutstandMedia: typeof import('../outstand-media-upload').ensureOutstandMedia;
let validateOutstandUploadUrl: typeof import('../outstand-media-upload').validateOutstandUploadUrl;
beforeAll(async () => { ({ ensureOutstandMedia, validateOutstandUploadUrl } = await import('../outstand-media-upload')); });

const getUploadUrl = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const confirmUpload = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getMedia = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const client = { getUploadUrl, confirmUpload, getMedia } as unknown as OutstandClient;
const source = { url: 'https://db.makinari.com/storage/v1/object/public/generative_videos/site-one/clip.mp4', filename: 'clip.mp4' };
const hosted = { url: 'https://media.outstand.so/org/file/clip.mp4', filename: 'clip.mp4' };
const signed = 'https://account.r2.cloudflarestorage.com/media/clip.mp4?X-Amz-Signature=secret';
const expires = () => new Date(Date.now() + 60 * 86400000).toISOString();
const confirm = () => ({ success: true, data: { id: 'media-one', ...hosted,
  status: 'active', content_type: 'video/mp4', size: 3, expires_at: expires() } });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected live request'));
  downloadMedia.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' });
  putMedia.mockResolvedValue();
  getUploadUrl.mockResolvedValue({ success: true, data: { id: 'media-one', expires_in: 3600, upload_url: signed } });
  confirmUpload.mockResolvedValue(confirm());
  getMedia.mockResolvedValue(confirm());
});
afterEach(() => { jest.restoreAllMocks(); });

describe('Outstand managed media upload', () => {
  it('downloads bytes, requests upload URL, PUTs, confirms, then emits only hosted media', async () => {
    const onUploaded = jest.fn<(receipt: unknown) => Promise<void>>().mockResolvedValue();
    const result = await ensureOutstandMedia(client, 'site-one', [source], { onUploaded });
    expect(result.media).toEqual([hosted]);
    expect(result.uploads).toEqual([expect.objectContaining({ source_url: source.url, media_id: 'media-one', ...hosted })]);
    expect(downloadMedia).toHaveBeenCalledWith(new URL(source.url), 64 * 1024 * 1024, expect.any(AbortSignal));
    const signal = downloadMedia.mock.calls[0][2];
    expect(getUploadUrl).toHaveBeenCalledWith('clip.mp4', 'video/mp4', 'site-one', signal);
    expect(putMedia).toHaveBeenCalledWith(new URL(signed), new Uint8Array([1, 2, 3]), 'video/mp4', signal);
    expect(confirmUpload).toHaveBeenCalledWith('media-one', 3, 'site-one', signal);
    expect(onUploaded).toHaveBeenCalledWith(result.uploads[0]);
    expect(getUploadUrl.mock.invocationCallOrder[0]).toBeGreaterThan(downloadMedia.mock.invocationCallOrder[0]);
    expect(confirmUpload.mock.invocationCallOrder[0]).toBeGreaterThan(putMedia.mock.invocationCallOrder[0]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('X-Amz-Signature');
  });

  it('reuses confirmed Outstand media and deduplicates source transfers', async () => {
    const result = await ensureOutstandMedia(client, 'site-one', [source, source, hosted]);
    expect(result.media).toEqual([hosted, hosted, hosted]);
    expect(downloadMedia).toHaveBeenCalledTimes(1);
    expect(confirmUpload).toHaveBeenCalledTimes(1);
  });

  it('checks the entire batch before any upload or download', async () => {
    await expect(ensureOutstandMedia(client, 'site-one', [source, { ...source, url: 'https://attacker.example/clip.mp4' }]))
      .rejects.toThrow('trusted');
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(getUploadUrl).not.toHaveBeenCalled();
  });

  it('validates MIME against extension before requesting a presigned URL', async () => {
    downloadMedia.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: 'text/html' });
    await expect(ensureOutstandMedia(client, 'site-one', [source])).rejects.toThrow('No social post was sent');
    expect(getUploadUrl).not.toHaveBeenCalled();
  });

  it.each(['download', 'init', 'put', 'confirm'])('never proceeds past failed %s and sanitizes secrets', async (stage) => {
    const failing = { download: downloadMedia, init: getUploadUrl, put: putMedia, confirm: confirmUpload }[stage]!;
    failing.mockRejectedValueOnce(new Error(`Sensitive ${signed}`));
    const outcome = ensureOutstandMedia(client, 'site-one', [source]);
    await expect(outcome).rejects.toThrow('could not be uploaded');
    await expect(outcome).rejects.not.toThrow('secret');
    if (stage !== 'confirm') expect(confirmUpload).not.toHaveBeenCalled();
  });

  it.each([
    { success: false }, { success: true, data: {} },
    { success: true, data: { id: '../media', expires_in: 3600, upload_url: signed } },
    { success: true, data: { id: 'media-one', expires_in: 0, upload_url: signed } },
    { success: true, data: { id: 'media-one', expires_in: 3600, upload_url: signed, tenant_id: 'other' } },
  ])('rejects invalid upload sessions before PUT: %j', async (response) => {
    getUploadUrl.mockResolvedValue(response);
    await expect(ensureOutstandMedia(client, 'site-one', [source])).rejects.toThrow();
    expect(putMedia).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'pending' }, { id: 'other' }, { filename: 'other.mp4' }, { size: 4 },
    { content_type: 'image/png' }, { expires_at: '2001-01-01T00:00:00Z' },
    { url: source.url }, { tenant_id: 'other' }, { video: { status: 'processing' } },
  ])('does not return unconfirmed/inconsistent media: %j', async (override) => {
    const original = confirm();
    confirmUpload.mockResolvedValue({ ...original, data: { ...original.data, ...override } });
    await expect(ensureOutstandMedia(client, 'site-one', [source])).rejects.toThrow('No social post was sent');
  });

  it('reuses a stored receipt only after a tenant-scoped active media lookup', async () => {
    const receipt = { source_url: source.url, ...hosted, media_id: 'media-one', expires_at: expires(), upload_url: signed };
    const result = await ensureOutstandMedia(client, 'site-one', [source], { cached: [receipt] });
    expect(result.media).toEqual([hosted]);
    expect(getMedia).toHaveBeenCalledWith('media-one', 'site-one', expect.any(AbortSignal));
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('X-Amz-Signature');
  });

  it('ignores expired receipts and uploads again', async () => {
    await ensureOutstandMedia(client, 'site-one', [source], { cached: [
      { source_url: source.url, ...hosted, media_id: 'media-one', expires_at: '2001-01-01T00:00:00Z' },
    ] });
    expect(getUploadUrl).toHaveBeenCalledTimes(1);
  });

  it('does not reuse media that expires before the scheduled post', async () => {
    await ensureOutstandMedia(client, 'site-one', [source], {
      scheduledAt: new Date(Date.now() + 86400000 * 2).toISOString(),
      cached: [{ source_url: source.url, ...hosted, media_id: 'media-one', expires_at: new Date(Date.now() + 86400000).toISOString() }],
    });
    expect(getUploadUrl).toHaveBeenCalledTimes(1);
    expect(getMedia).not.toHaveBeenCalled();
  });

  it('fails closed if a cached media receipt is foreign or unavailable', async () => {
    const receipt = { source_url: source.url, ...hosted, media_id: 'media-one', expires_at: expires() };
    const media = confirm();
    getMedia.mockResolvedValue({ ...media, data: { ...media.data, tenant_id: 'other' } });
    await expect(ensureOutstandMedia(client, 'site-one', [source], { cached: [receipt] })).rejects.toThrow();
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('stops if the receipt cannot be checkpointed', async () => {
    const onUploaded = jest.fn<(receipt: unknown) => Promise<void>>().mockRejectedValue(new Error('Database unavailable'));
    await expect(ensureOutstandMedia(client, 'site-one', [source], { onUploaded })).rejects.toThrow('No social post was sent');
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });
});

describe('presigned upload allowlist', () => {
  it('accepts the provider R2 upload URL', () => {
    expect(validateOutstandUploadUrl(signed).hostname).toBe('account.r2.cloudflarestorage.com');
  });
  it.each([
    'http://account.r2.cloudflarestorage.com/file?X-Amz-Signature=x',
    'https://user:pass@account.r2.cloudflarestorage.com/file?X-Amz-Signature=x',
    'https://account.r2.cloudflarestorage.com:8443/file?X-Amz-Signature=x',
    'https://account.r2.cloudflarestorage.com.evil.example/file?X-Amz-Signature=x',
    'https://127.0.0.1/file?X-Amz-Signature=x', 'https://169.254.169.254/file?X-Amz-Signature=x',
    'https://account.r2.cloudflarestorage.com/file', signed + '#fragment',
    'https://evil.example/file?X-Amz-Signature=x',
  ])('rejects unsafe upload URLs: %s', (url) => {
    expect(() => validateOutstandUploadUrl(url)).toThrow();
  });
});