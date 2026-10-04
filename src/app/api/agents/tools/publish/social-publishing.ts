import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { resolveSocialAccounts, SocialAccountResolutionError } from '@/lib/integrations/outstand/accounts';
import { randomUUID } from 'node:crypto';
import { getContentById } from '@/lib/database/content-db';
import { createContentCore } from '../content/create/core';
import { updateContentCore } from '../content/update/core';
import { prepareSocialMedia } from './social-media';
import { claimSocialContent } from './content-attempt';
import { ensureOutstandMedia, type MediaUploadReceipt } from './outstand-media-upload';
import { validateTikTokOptions } from './tiktok-options';
import type { PublishToolParams } from './assistantProtocol';

type DeliveryStatus = 'pending' | 'scheduled' | 'published' | 'inbox_draft' | 'failed' | 'partial_failure' | 'unknown';
type Delivery = {
  success: boolean;
  status: DeliveryStatus;
  account_ids: string[];
  post_id?: string;
  published_at?: string;
  error?: string;
  retry_safe: boolean;
  tiktok_post_mode?: 'DIRECT_POST' | 'MEDIA_UPLOAD';
  requires_creator_action?: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Acceptance is not delivery. Also detect Outstand's silently dropped targets. */
export function socialDeliveryResult(value: unknown, accountIds: string[]): Delivery {
  const response = record(value);
  const post = record(response?.post);
  const base = { account_ids: accountIds, retry_safe: false };
  const postId = typeof post?.id === 'string' && post.id ? post.id : undefined;
  if (response?.success !== true || response.error || !postId || post?.isDraft === true) {
    return { ...base, success: false, status: 'unknown', ...(postId ? { post_id: postId } : {}),
      error: 'Social publishing was not confirmed. Inspect provider delivery before retrying; do not reconnect accounts based on this error.' };
  }
  const accounts = Array.isArray(post?.socialAccounts) ? post.socialAccounts.map(record) : [];
  const returnedIds = accounts.map((account) => account?.id);
  if (accounts.length !== accountIds.length || !accountIds.every((id) => returnedIds.includes(id))) {
    return { ...base, success: false, post_id: postId, status: 'partial_failure',
      error: 'The provider did not confirm every requested account. Inspect the existing post; do not resend all destinations.' };
  }
  if (accounts.some((account) => account?.status === 'failed' || account?.error)) {
    return { ...base, success: false, post_id: postId, status: 'partial_failure',
      error: 'At least one destination failed. Inspect per-account delivery on the existing post before retrying.' };
  }
  if (accounts.some((account) => account?.status !== undefined
    && !['pending', 'processing', 'scheduled', 'published'].includes(String(account.status)))) {
    return { ...base, success: false, post_id: postId, status: 'unknown',
      error: 'The provider returned an unrecognized delivery state. Inspect the existing post before retrying.' };
  }
  const published = accounts.every((account) => account?.status === 'published');
  const timestamps = accounts.map((account) => account?.publishedAt).concat(post?.publishedAt)
    .filter((date): date is string => typeof date === 'string' && Number.isFinite(Date.parse(date)));
  if (published && timestamps.length) {
    return { ...base, success: true, post_id: postId, status: 'published',
      published_at: new Date(Math.max(...timestamps.map(Date.parse))).toISOString() };
  }
  return { ...base, success: true, post_id: postId, status: post?.scheduledAt ? 'scheduled' : 'pending' };
}

/** The caller supplies the authorized execution site, never a model-provided tenant. */
export async function publishSocialContent(
  siteId: string, userId: string | undefined, input: PublishToolParams,
  metadata: Record<string, unknown>,
) {
  let contentId = input.content_id;
  let savedContent: { success: boolean; id?: string; status?: string; error?: string } | undefined;
  const actions: string[] = [];
  let existing;
  let safeValidationError = false;
  try {
    if (contentId) {
      existing = await getContentById(contentId);
      if (!existing || existing.site_id !== siteId) throw new Error('Content is not accessible in this site.');
      const previous = record(existing.metadata?.social_publication);
      if (existing.metadata?.outstand_post_id || (previous && (previous.post_id || previous.retry_safe === false))) {
        return { success: false, actions_attempted: actions,
          content: { success: true, id: contentId }, social: {
            success: false, status: 'unknown', post_id: previous?.post_id || existing.metadata?.outstand_post_id, retry_safe: false,
            error: 'This content already has a social publishing attempt. Inspect its provider status before sending again.',
          } };
      }
    }
    if (input.scheduledAt !== undefined && (typeof input.scheduledAt !== 'string'
      || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.scheduledAt)
      || !Number.isFinite(Date.parse(input.scheduledAt)) || Date.parse(input.scheduledAt) <= Date.now()
      || Date.parse(input.scheduledAt) > Date.now() + 30 * 24 * 60 * 60 * 1000)) {
      return { success: false, actions_attempted: actions, social: { success: false, status: 'failed',
        retry_safe: true, error: 'scheduledAt must be an ISO 8601 timestamp within the next 30 days.' } };
    }
    const client = getOutstandClient();
    // All validation and read-only discovery happen before any content write/send.
    const accounts = await resolveSocialAccounts(client, siteId, input.social_accounts || []);
    safeValidationError = true;
    const hasTikTok = accounts.some((account) => account.network === 'tiktok');
    const tiktok = validateTikTokOptions(input.tiktok, hasTikTok);
    const media = await prepareSocialMedia(client, siteId, input);
    if (accounts.some((account) => ['instagram', 'tiktok'].includes(account.network)) && !media.media.length) {
      throw new Error('Instagram and TikTok require attached media. Supply media_urls or uploaded assets, not a link-only caption.');
    }
    safeValidationError = false;
    const accountIds = accounts.map((account) => account.id);
    const mergedMetadata = { ...existing?.metadata, ...metadata };
    // Blog visibility is a local action, independent of social delivery status.
    const preserveBlogPublication = existing?.type === 'blog_post' || (!existing && input.type === 'blog_post');
    const attempt = { attempt_id: randomUUID(), status: 'unknown', account_ids: accountIds, retry_safe: false,
      ...(tiktok ? { tiktok_post_mode: tiktok.postMode } : {}) };
    if (contentId || (input.title && input.type)) {
      actions.push('content');
      const saved = existing
        ? await claimSocialContent(existing, siteId, { text: input.text,
          ...(preserveBlogPublication ? { status: 'published' } : { status: 'draft', published_at: null }),
          metadata: { ...mergedMetadata, social_publication: attempt } })
        : await createContentCore({ title: input.title, type: input.type, site_id: siteId,
          user_id: userId, text: input.text, status: preserveBlogPublication ? 'published' : 'draft',
          metadata: { ...mergedMetadata, social_publication: attempt } });
      contentId = saved.id;
      savedContent = { success: true, id: contentId, status: saved.status };
    }

    let delivery: Delivery;
    const uploadReceipts: MediaUploadReceipt[] = [];
    let postAttempted = false;
    try {
      let postMedia = media.media;
      if (hasTikTok) {
        actions.push('media_upload');
        const uploaded = await ensureOutstandMedia(client, siteId, media.media, {
          cached: existing?.metadata?.outstand_media_uploads,
          scheduledAt: input.scheduledAt,
          onUploaded: async (receipt) => {
            uploadReceipts.push(receipt);
            mergedMetadata.outstand_media_uploads = uploadReceipts;
            if (contentId) await updateContentCore({ content_id: contentId, site_id: siteId,
              metadata: { ...mergedMetadata, social_publication: attempt } });
          },
        });
        postMedia = uploaded.media;
        mergedMetadata.outstand_media_uploads = uploaded.uploads;
      }
      actions.push('social');
      postAttempted = true;
      const response = await client.createPost({
        accounts: accountIds,
        containers: [{ content: media.content, ...(postMedia.length ? { media: postMedia } : {}) }],
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        ...(tiktok ? { tiktok } : {}),
      }, siteId);
      delivery = socialDeliveryResult(response, accountIds);
      if (tiktok) {
        delivery.tiktok_post_mode = tiktok.postMode;
        if (tiktok.postMode === 'MEDIA_UPLOAD') {
          delivery.requires_creator_action = true;
          if (delivery.status === 'published') delivery.status = 'inbox_draft';
        }
      }
    } catch (error) {
      const status = (error as { upstreamStatus?: number })?.upstreamStatus;
      const rejected = typeof status === 'number' && [400, 401, 403, 404, 422, 429].includes(status);
      delivery = { success: false, status: !postAttempted || rejected ? 'failed' : 'unknown',
        account_ids: accountIds, retry_safe: !postAttempted || rejected,
        ...(tiktok ? { tiktok_post_mode: tiktok.postMode } : {}),
        error: !postAttempted ? 'Media upload to Outstand did not complete. Check media readiness, MIME type, and the 64 MiB limit. No post was sent; reuse this content_id when retrying.'
          : rejected ? 'The provider rejected the social post. Verify account permissions and media; this is not proof of disconnected accounts.'
          : 'Social delivery is unconfirmed. Inspect provider status before retrying to avoid duplicates.' };
    }
    if (contentId && savedContent) {
      try {
        const published = delivery.status === 'published';
        await updateContentCore({ content_id: contentId, site_id: siteId,
          ...(preserveBlogPublication ? {} : { status: published ? 'published' : 'draft',
            published_at: published ? delivery.published_at : null }),
          metadata: { ...mergedMetadata, social_publication: { ...delivery, attempt_id: attempt.attempt_id },
            ...(delivery.post_id ? { outstand_post_id: delivery.post_id } : {}) } });
        savedContent.status = preserveBlogPublication || published ? 'published' : 'draft';
      } catch {
        // The provider may already have accepted the post. Never turn this into a resend.
        return { success: false, actions_attempted: actions,
          content: { success: false, id: contentId, error: 'Delivery status could not be saved. Do not resend the post.' },
          social: delivery };
      }
    }
    return { success: delivery.success, actions_attempted: actions,
      ...(savedContent ? { content: savedContent } : {}), social: delivery };
  } catch (error) {
    return { success: false, actions_attempted: actions,
      ...(savedContent ? { content: savedContent } : {}),
      social: { success: false, status: actions.includes('content') ? 'unknown' : 'failed',
        retry_safe: !actions.includes('content'),
        error: error instanceof Error && (safeValidationError || error instanceof SocialAccountResolutionError)
          ? error.message : 'Social publishing could not be prepared safely. Check the content and site configuration before retrying.' } };
  }
}