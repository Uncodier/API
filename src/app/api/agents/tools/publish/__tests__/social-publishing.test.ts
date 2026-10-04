import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PublishToolParams } from '../assistantProtocol';

const createContent = jest.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const updateContent = jest.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const getContent = jest.fn<() => Promise<Record<string, unknown> | null>>();
const claimContent = jest.fn<(...args: unknown[]) => Promise<{ id: string; status: string }>>();
const listAccounts = jest.fn<() => Promise<unknown>>();
const createPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getMedia = jest.fn<() => Promise<unknown>>();
const getUploadUrl = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const confirmUpload = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const downloadMedia = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const putMedia = jest.fn<(...args: unknown[]) => Promise<void>>();
const bulkSend = jest.fn();
const client = { listAccounts, createPost, getMedia, getUploadUrl, confirmUpload };

jest.unstable_mockModule('../../content/create/core', () => ({ createContentCore: createContent }));
jest.unstable_mockModule('../../content/update/core', () => ({ updateContentCore: updateContent }));
jest.unstable_mockModule('@/lib/database/content-db', () => ({ getContentById: getContent }));
jest.unstable_mockModule('../content-attempt', () => ({ claimSocialContent: claimContent }));
jest.unstable_mockModule('../media-transfer-http', () => ({ downloadMedia, putMedia }));
jest.unstable_mockModule('@/lib/integrations/outstand/client', () => ({ getOutstandClient: () => client }));
jest.unstable_mockModule('../../sendBulkMessages/assistantProtocol', () => ({ sendBulkMessagesTool: bulkSend }));
jest.unstable_mockModule('../../sendEmail/core', () => ({ sendEmailCore: jest.fn() }));
jest.unstable_mockModule('@/lib/services/whatsapp/WhatsAppSendService', () => ({ WhatsAppSendService: {} }));
jest.unstable_mockModule('@/lib/database/lead-db', () => ({ getLeadById: jest.fn() }));
jest.unstable_mockModule('@/lib/messaging/lead-merge-fields', () => ({
  fetchSiteNameForMerge: jest.fn(), personalizeMergeTemplate: jest.fn(), placeholderPolicyToMergePolicy: jest.fn(),
}));
jest.unstable_mockModule('../instagram-dm', () => ({
  validateInstagramDirectMessage: () => null, publishInstagramDirectMessage: jest.fn(),
}));

let publishTool: typeof import('../assistantProtocol').publishTool;
let socialDeliveryResult: typeof import('../social-publishing').socialDeliveryResult;
beforeAll(async () => {
  ({ publishTool } = await import('../assistantProtocol'));
  ({ socialDeliveryResult } = await import('../social-publishing'));
});
const site = '00000000-0000-4000-8000-000000000001';
const video = `https://db.makinari.com/storage/v1/object/public/generative_videos/${site}/clip.mp4`;
const hostedVideo = 'https://media.outstand.so/org/upload/clip.mp4';
const directPost = { postMode: 'DIRECT_POST', privacyLevel: 'PUBLIC_TO_EVERYONE' } as const;
const accountRows = [
  { id: 'ig-one', network: 'instagram', username: 'demo.ig', isActive: 1, tenant_id: site },
  { id: 'tt-one', network: 'tiktok', username: 'demo.tt', isActive: 1, tenant_id: site },
];
const input: PublishToolParams = {
  title: 'Video', type: 'social_post', text: 'Caption', urls: [video], social_accounts: ['tiktok', 'instagram'],
  tiktok: directPost,
};
const acceptedPost = () => ({ success: true, post: {
  id: 'post-one', publishedAt: null, scheduledAt: null,
  socialAccounts: [{ id: 'tt-one', status: 'pending' }, { id: 'ig-one', status: 'pending' }],
} });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected live request'));
  listAccounts.mockResolvedValue({ success: true, data: accountRows, total: 2 });
  createPost.mockResolvedValue(acceptedPost());
  createContent.mockResolvedValue({ id: 'content-one', status: 'draft' });
  updateContent.mockResolvedValue({ id: 'content-one', status: 'draft' });
  claimContent.mockResolvedValue({ id: 'content-one', status: 'draft' });
  getContent.mockResolvedValue(null);
  downloadMedia.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' });
  putMedia.mockResolvedValue();
  getUploadUrl.mockResolvedValue({ success: true, data: { id: 'media-one', expires_in: 3600,
    upload_url: 'https://bucket.r2.cloudflarestorage.com/org/clip.mp4?X-Amz-Signature=test' } });
  confirmUpload.mockResolvedValue({ success: true, data: { id: 'media-one', status: 'active', filename: 'clip.mp4',
    url: hostedVideo, size: 3, content_type: 'video/mp4', expires_at: new Date(Date.now() + 86400000).toISOString() } });
});
afterEach(() => { jest.restoreAllMocks(); });

describe('social publish end-to-end contract without external side effects', () => {
  it('resolves legacy network overrides, attaches the video, and keeps accepted content unpublished', async () => {
    const result = await publishTool(site).execute(input);
    expect(result.social.error).toBeUndefined();
    expect(result).toMatchObject({ success: true, social: { post_id: 'post-one', status: 'pending' } });
    expect(listAccounts).toHaveBeenCalledWith(site, expect.objectContaining({ tenantId: site }));
    expect(createPost).toHaveBeenCalledWith({ accounts: ['tt-one', 'ig-one'], containers: [{
      content: 'Caption', media: [{ url: hostedVideo, filename: 'clip.mp4' }],
    }], tiktok: directPost }, site);
    expect(getUploadUrl).toHaveBeenCalledWith('clip.mp4', 'video/mp4', site, expect.any(AbortSignal));
    expect(confirmUpload).toHaveBeenCalledWith('media-one', 3, site, expect.any(AbortSignal));
    expect(createContent).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
    expect(updateContent).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft', published_at: null,
      metadata: expect.objectContaining({ outstand_post_id: 'post-one' }) }));
  });

  it('rejects all targets before writing or posting if one identifier is unknown', async () => {
    const result = await publishTool(site).execute({ ...input, social_accounts: ['ig-one', 'missing'] });
    expect(result.success).toBe(false);
    expect(createContent).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('distinguishes a failed lookup from disconnected accounts', async () => {
    listAccounts.mockResolvedValue({ success: false, error: 'Provider unavailable' });
    const result = await publishTool(site).execute(input);
    expect(result.success).toBe(false);
    expect(createPost).not.toHaveBeenCalled();
    expect(createContent).not.toHaveBeenCalled();
  });

  it('keeps a confirmed rejection as draft, returns its content ID, and does not send other channels', async () => {
    createPost.mockRejectedValue(Object.assign(new Error('Invalid identifiers'), { upstreamStatus: 400 }));
    const result = await publishTool(site).execute({ ...input, audience_id: 'audience', channel: 'email', subject: 'Caption' });
    expect(result).toMatchObject({ success: false, content: { id: 'content-one' },
      social: { status: 'failed', retry_safe: true } });
    expect(updateContent).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft', published_at: null }));
    expect(bulkSend).not.toHaveBeenCalled();
  });

  it('does not create another record when retrying confirmed rejection by content_id', async () => {
    getContent.mockResolvedValue({ id: 'content-one', site_id: site, type: 'social_post', status: 'draft',
      metadata: { preserved: 'yes', social_publication: { status: 'failed', retry_safe: true } } });
    await publishTool(site).execute({ ...input, content_id: 'content-one' });
    expect(createContent).not.toHaveBeenCalled();
    expect(claimContent).toHaveBeenCalledWith(expect.objectContaining({ id: 'content-one' }), site,
      expect.objectContaining({ metadata: expect.objectContaining({ social_publication: expect.objectContaining({
        attempt_id: expect.any(String), retry_safe: false,
      }) }) }));
    expect(updateContent).toHaveBeenLastCalledWith(expect.objectContaining({ content_id: 'content-one',
      metadata: expect.objectContaining({ preserved: 'yes' }) }));
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it.each([{ post_id: 'post-one', status: 'pending' }, { status: 'unknown', retry_safe: false }])(
    'refuses to resend content with an accepted or ambiguous attempt: %j', async (previous) => {
      getContent.mockResolvedValue({ site_id: site, metadata: { social_publication: previous } });
      const result = await publishTool(site).execute({ ...input, content_id: 'content-one' });
      expect(result).toMatchObject({ success: false, social: { retry_safe: false } });
      expect(createPost).not.toHaveBeenCalled();
      expect(updateContent).not.toHaveBeenCalled();
    },
  );

  it('does not send or modify content owned by another site', async () => {
    getContent.mockResolvedValue({ id: 'content-one', site_id: 'another-site' });
    const result = await publishTool(site).execute({ ...input, content_id: 'content-one' });
    expect(result.success).toBe(false);
    expect(listAccounts).not.toHaveBeenCalled();
    expect(updateContent).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('stops before sending if the content save fails', async () => {
    createContent.mockRejectedValue(new Error('Database unavailable'));
    expect((await publishTool(site).execute(input)).success).toBe(false);
    expect(createPost).not.toHaveBeenCalled();
  });

  it('does not send when another execution already claimed the content', async () => {
    getContent.mockResolvedValue({ id: 'content-one', site_id: site, metadata: {} });
    claimContent.mockRejectedValue(new Error('Content changed; do not publish.'));
    const result = await publishTool(site).execute({ ...input, content_id: 'content-one' });
    expect(result.success).toBe(false);
    expect(createPost).not.toHaveBeenCalled();
  });

  it('preserves blog visibility independently of failed social delivery', async () => {
    createPost.mockRejectedValue(Object.assign(new Error('Invalid media'), { upstreamStatus: 400 }));
    const result = await publishTool(site).execute({ ...input, type: 'blog_post' });
    expect(result.social.success).toBe(false);
    expect(createContent).toHaveBeenCalledWith(expect.objectContaining({ status: 'published' }));
    expect(updateContent.mock.calls.every(([call]) => !Object.hasOwn(call, 'status'))).toBe(true);
  });

  it('blocks retries when a legacy record already has an Outstand post ID', async () => {
    getContent.mockResolvedValue({ site_id: site, metadata: { outstand_post_id: 'post-existing' } });
    const result = await publishTool(site).execute({ ...input, content_id: 'content-one' });
    expect(result.social).toMatchObject({ post_id: 'post-existing', retry_safe: false });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('does not retry a timeout or hide the existing post when delivery persistence fails', async () => {
    createPost.mockRejectedValue(new Error('Timed out'));
    const result = await publishTool(site).execute(input);
    expect(result).toMatchObject({ success: false, social: { status: 'unknown', retry_safe: false } });
    expect(createPost).toHaveBeenCalledTimes(1);
    createPost.mockResolvedValue(acceptedPost());
    updateContent.mockResolvedValueOnce({ id: 'content-one' }).mockRejectedValue(new Error('Database unavailable'));
    const accepted = await publishTool(site).execute(input);
    expect(accepted).toMatchObject({ success: false, content: { id: 'content-one', success: false },
      social: { post_id: 'post-one', status: 'pending', retry_safe: false } });
  });

  it('marks content published only on explicit per-account delivery confirmation', async () => {
    const date = '2026-09-29T10:00:00.000Z';
    createPost.mockResolvedValue({ success: true, post: { id: 'post-one', publishedAt: date,
      socialAccounts: [{ id: 'tt-one', status: 'published' }, { id: 'ig-one', status: 'published' }] } });
    const result = await publishTool(site).execute(input);
    expect(result.social.status).toBe('published');
    expect(updateContent).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'published', published_at: date }));
  });

  it('keeps scheduled publication distinct from delivery', async () => {
    const scheduledAt = new Date(Date.now() + 600_000).toISOString();
    const response = acceptedPost();
    createPost.mockResolvedValue({ ...response, post: { ...response.post, scheduledAt } });
    const result = await publishTool(site).execute({ ...input, scheduledAt });
    expect(result.social.status).toBe('scheduled');
    expect(updateContent).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('rejects link-only Instagram/TikTok posts and invalid scheduling before content writes', async () => {
    expect((await publishTool(site).execute({ ...input, urls: ['https://example.com/menu'] })).success).toBe(false);
    expect((await publishTool(site).execute({ ...input, scheduledAt: 'yesterday' })).success).toBe(false);
    expect(createContent).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('supports explicit media_urls and no-caption video posts', async () => {
    const result = await publishTool(site).execute({ social_accounts: ['ig-one', 'tt-one'], media_urls: [video], tiktok: directPost });
    expect(result.success).toBe(true);
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ containers: [{
      content: '', media: [{ url: hostedVideo, filename: 'clip.mp4' }],
    }] }), site);
  });

  it('never calls discovery, persistence, or provider operations in preview mode', async () => {
    const result = await publishTool(site).execute({ ...input, is_test: true });
    expect(result.social).toMatchObject({ simulated: true, connectivity_verified: false });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(getMedia).not.toHaveBeenCalled();
    expect(createContent).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { postMode: 'DIRECT_POST' }])('publishes directly and publicly when options are omitted: %j', async (tiktok) => {
    const result = await publishTool(site).execute({ ...input, tiktok } as PublishToolParams);
    expect(result.success).toBe(true);
    expect(result.social.tiktok_post_mode).toBe('DIRECT_POST');
    expect(confirmUpload).toHaveBeenCalled();
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({
      tiktok: directPost,
      containers: [{ content: 'Caption', media: [{ url: hostedVideo, filename: 'clip.mp4' }] }],
    }), site);
  });

  it('preserves a private override with the default direct mode', async () => {
    const result = await publishTool(site).execute({ ...input, tiktok: { privacyLevel: 'SELF_ONLY' } } as PublishToolParams);
    expect(result.success).toBe(true);
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({
      tiktok: { postMode: 'DIRECT_POST', privacyLevel: 'SELF_ONLY' },
    }), site);
  });

  it('rejects invalid TikTok options before side effects instead of falling back to public', async () => {
    const result = await publishTool(site).execute({ ...input, tiktok: { privacyLevel: 'invalid' } } as unknown as PublishToolParams);
    expect(result.success).toBe(false);
    expect(createContent).not.toHaveBeenCalled();
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('reports a rejected public default without retrying a different privacy or mode', async () => {
    createPost.mockRejectedValueOnce(Object.assign(new Error('privacy_level_option_mismatch'), { upstreamStatus: 400 }));
    const result = await publishTool(site).execute({ ...input, tiktok: undefined });
    expect(result).toMatchObject({ success: false, social: { status: 'failed', tiktok_post_mode: 'DIRECT_POST' } });
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ tiktok: directPost }), site);
  });

  it('never posts after upload or confirmation failure', async () => {
    confirmUpload.mockResolvedValue({ success: false, error: 'Storage not ready' });
    const result = await publishTool(site).execute(input);
    expect(result).toMatchObject({ success: false, content: { id: 'content-one' }, social: { status: 'failed', retry_safe: true } });
    expect(createPost).not.toHaveBeenCalled();
    expect(updateContent).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('checkpoints confirmed upload receipts and reuses them on a confirmed-rejection retry', async () => {
    createPost.mockRejectedValueOnce(Object.assign(new Error('Rejected'), { upstreamStatus: 400 }));
    await publishTool(site).execute(input);
    const saved = updateContent.mock.calls[updateContent.mock.calls.length - 1][0].metadata as Record<string, unknown>;
    expect(saved.outstand_media_uploads).toEqual([expect.objectContaining({ media_id: 'media-one', url: hostedVideo })]);
    expect(JSON.stringify(saved)).not.toContain('X-Amz-Signature');
    getContent.mockResolvedValue({ id: 'content-one', site_id: site, type: 'social_post', status: 'draft', metadata: saved });
    getMedia.mockResolvedValue({ success: true, data: { id: 'media-one', status: 'active', filename: 'clip.mp4',
      url: hostedVideo, content_type: 'video/mp4', expires_at: new Date(Date.now() + 86400000).toISOString() } });
    const result = await publishTool(site).execute({ ...input, content_id: 'content-one' });
    expect(result.success).toBe(true);
    expect(getUploadUrl).toHaveBeenCalledTimes(1);
    expect(downloadMedia).toHaveBeenCalledTimes(1);
    expect(createPost).toHaveBeenCalledTimes(2);
  });

  it('does not resend Instagram when the request selects only TikTok', async () => {
    createPost.mockResolvedValue({ success: true, post: { id: 'tt-post', socialAccounts: [{ id: 'tt-one' }] } });
    const result = await publishTool(site).execute({ ...input, social_accounts: ['tt-one'] });
    expect(result.success).toBe(true);
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ accounts: ['tt-one'], tiktok: directPost }), site);
  });

  it('leaves Instagram-only uploads unchanged and does not transfer media', async () => {
    await publishTool(site).execute({ ...input, social_accounts: ['ig-one'], tiktok: undefined });
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(createPost).toHaveBeenCalledWith({ accounts: ['ig-one'], containers: [{ content: 'Caption',
      media: [{ url: video, filename: 'clip.mp4' }],
    }] }, site);
  });

  it('does not describe a MEDIA_UPLOAD inbox delivery as a published profile post', async () => {
    createPost.mockResolvedValue({ success: true, post: { id: 'post-one', publishedAt: new Date().toISOString(),
      socialAccounts: [{ id: 'tt-one', status: 'published' }, { id: 'ig-one', status: 'published' }] } });
    const result = await publishTool(site).execute({ ...input, tiktok: { postMode: 'MEDIA_UPLOAD' } });
    expect(result.social).toMatchObject({ status: 'inbox_draft', requires_creator_action: true, tiktok_post_mode: 'MEDIA_UPLOAD' });
    expect(updateContent).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it.each([
    { value: 'instagram' }, { value: [null] }, { value: [''] }, { value: [] },
    { value: Array(101).fill('ig-one') }, { value: new Array(2) },
  ])('validates selectors at runtime: %j', async ({ value }) => {
    const result = await publishTool(site).execute({ ...input, social_accounts: value as string[] });
    expect(result.success).toBe(false);
    expect(listAccounts).not.toHaveBeenCalled();
  });
});

describe('provider result integrity', () => {
  it.each([null, {}, { success: false, error: 'Unavailable' }, { success: true, post: {} }])(
    'does not report malformed/HTTP-200 failure envelopes as success: %j', (value) => {
      expect(socialDeliveryResult(value, ['ig-one'])).toMatchObject({ success: false, status: 'unknown', retry_safe: false });
    },
  );
  it('detects silently dropped destinations', () => {
    expect(socialDeliveryResult({ success: true, post: { id: 'post-one', socialAccounts: [{ id: 'ig-one' }] } },
      ['ig-one', 'tt-one'])).toMatchObject({ success: false, status: 'partial_failure', post_id: 'post-one' });
  });
  it('detects individual platform failure even when the provider accepted the post', () => {
    expect(socialDeliveryResult({ success: true, post: { id: 'post-one', socialAccounts: [
      { id: 'ig-one', status: 'failed', error: 'Invalid media' },
    ] } }, ['ig-one'])).toMatchObject({ success: false, status: 'partial_failure', retry_safe: false });
  });

  it.each(['deleted', 'unexpected'])('never treats explicit %s status as accepted delivery', (status) => {
    expect(socialDeliveryResult({ success: true, post: { id: 'post-one', socialAccounts: [
      { id: 'ig-one', status },
    ] } }, ['ig-one'])).toMatchObject({ success: false, status: 'unknown', retry_safe: false });
  });

  it('does not treat a provider draft as an accepted publication', () => {
    expect(socialDeliveryResult({ success: true, post: { id: 'post-one', isDraft: true,
      socialAccounts: [{ id: 'ig-one' }],
    } }, ['ig-one'])).toMatchObject({ success: false, status: 'unknown', post_id: 'post-one' });
  });
});