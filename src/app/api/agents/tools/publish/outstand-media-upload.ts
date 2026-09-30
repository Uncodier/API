import type { OutstandClient } from '@/lib/integrations/outstand/client';
import { prepareSocialMedia, validateSocialMediaAttachment, type PreparedSocialMedia } from './social-media';
import { downloadMedia, putMedia } from './media-transfer-http';

type UploadClient = Pick<OutstandClient, 'getUploadUrl' | 'confirmUpload' | 'getMedia'>;
type Attachment = PreparedSocialMedia['media'][number];
export interface MediaUploadReceipt {
  source_url: string;
  filename: string;
  media_id: string;
  url: string;
  expires_at: string;
}

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 120_000;
const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
}
function validateTenant(value: Record<string, unknown>, siteId: string) {
  for (const key of ['tenant_id', 'tenantId', 'site_id', 'siteId']) {
    if (key in value && value[key] !== siteId) throw new Error('Media response is outside this site.');
  }
}

/** Presigned R2 URLs come only from Outstand, never from model arguments. */
export function validateOutstandUploadUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 16_384 || /[\s\\]/.test(value)) throw new Error('Invalid upload URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname)
    || url.pathname === '/' || !url.searchParams.get('X-Amz-Signature')) {
    throw new Error('Untrusted upload target returned by Outstand.');
  }
  return url;
}

function uploadEnvelope(value: unknown, siteId: string): Record<string, unknown> {
  if (!record(value) || value.success !== true || value.error || !record(value.data)) {
    throw new Error('Invalid media upload response.');
  }
  validateTenant(value, siteId);
  validateTenant(value.data, siteId);
  return value.data;
}

function cacheReceipt(value: unknown, source: Attachment, requiredUntil: number): MediaUploadReceipt | undefined {
  if (!record(value) || value.source_url !== source.url || value.filename !== source.filename
    || !opaqueId(value.media_id) || typeof value.url !== 'string' || typeof value.expires_at !== 'string'
    || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= requiredUntil) return undefined;
  return { source_url: source.url, filename: source.filename, media_id: value.media_id,
    url: value.url, expires_at: value.expires_at };
}

/** Upload before publishing. This function never creates a post or falls back to the original URL. */
export async function ensureOutstandMedia(
  client: UploadClient, siteId: string, attachments: Attachment[],
  options: { cached?: unknown; scheduledAt?: string; onUploaded?: (receipt: MediaUploadReceipt) => Promise<void> } = {},
): Promise<{ media: Attachment[]; uploads: MediaUploadReceipt[] }> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(siteId) || !Array.isArray(attachments) || attachments.length > 20) {
    throw new Error('Invalid site or media upload request.');
  }
  // Validate the complete batch before downloading or requesting upload URLs.
  const sources = attachments.map((item) => validateSocialMediaAttachment(item.url, item.filename));
  const requiredUntil = options.scheduledAt ? Date.parse(options.scheduledAt) : Date.now();
  if (!Number.isFinite(requiredUntil)) throw new Error('Invalid media publication schedule.');
  const media: Attachment[] = [];
  const uploads: MediaUploadReceipt[] = [];
  const seen = new Map<string, Attachment>();
  const cached = Array.isArray(options.cached) ? options.cached.slice(0, 20) : [];
  const signal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
  for (const source of sources) {
    if (new URL(source.url).hostname === 'media.outstand.so') {
      media.push(source);
      continue;
    }
    const previous = seen.get(source.url);
    if (previous) { media.push(previous); continue; }
    try {
      const receipt = cached.map((value) => cacheReceipt(value, source, requiredUntil)).find(Boolean);
      if (receipt) {
        // Never trust an expired/foreign cached media ID; resolve it in the current tenant.
        const resolved = await prepareSocialMedia({ getMedia: (id, tenant) => client.getMedia(id, tenant, signal) },
          siteId, { assets: [receipt.media_id] });
        if (resolved.media.length !== 1 || resolved.media[0].url !== receipt.url
          || new URL(resolved.media[0].url).hostname !== 'media.outstand.so') {
          throw new Error('Cached media could not be verified.');
        }
        media.push(resolved.media[0]);
        seen.set(source.url, resolved.media[0]);
        uploads.push(receipt);
        await options.onUploaded?.(receipt);
        continue;
      }
      const extension = source.filename.split('.').pop()?.toLowerCase() || '';
      const contentType = MIME_BY_EXTENSION[extension];
      if (!contentType) throw new Error('Unsupported media format for managed upload.');
      const downloaded = await downloadMedia(new URL(source.url), MAX_UPLOAD_BYTES, signal);
      if (downloaded.contentType.toLowerCase().split(';')[0].trim() !== contentType) {
        throw new Error('Media content type does not match its filename.');
      }
      const init = uploadEnvelope(await client.getUploadUrl(source.filename, contentType, siteId, signal), siteId);
      if (!opaqueId(init.id) || typeof init.expires_in !== 'number' || init.expires_in <= 0) {
        throw new Error('Invalid upload session.');
      }
      await putMedia(validateOutstandUploadUrl(init.upload_url), downloaded.bytes, contentType, signal);
      const confirmed = uploadEnvelope(await client.confirmUpload(init.id, downloaded.bytes.byteLength, siteId, signal), siteId);
      if (confirmed.id !== init.id || confirmed.status !== 'active' || confirmed.filename !== source.filename
        || typeof confirmed.url !== 'string' || typeof confirmed.expires_at !== 'string'
        || !Number.isFinite(Date.parse(confirmed.expires_at)) || Date.parse(confirmed.expires_at) <= requiredUntil
        || confirmed.content_type !== contentType || confirmed.size !== downloaded.bytes.byteLength
        || (confirmed.video != null && (!record(confirmed.video) || confirmed.video.status !== 'ready'))) {
        throw new Error('Outstand has not confirmed an active, ready media file.');
      }
      const uploaded = validateSocialMediaAttachment(confirmed.url, confirmed.filename);
      if (new URL(uploaded.url).hostname !== 'media.outstand.so') throw new Error('Confirmed media is not hosted by Outstand.');
      const saved: MediaUploadReceipt = { source_url: source.url, filename: source.filename,
        media_id: init.id, url: uploaded.url, expires_at: confirmed.expires_at };
      uploads.push(saved);
      await options.onUploaded?.(saved);
      media.push(uploaded);
      seen.set(source.url, uploaded);
    } catch {
      throw new Error('Media could not be uploaded and confirmed by Outstand. No social post was sent. Check the file, upload availability, and the 64 MiB transfer limit before retrying.');
    }
  }
  return { media, uploads };
}