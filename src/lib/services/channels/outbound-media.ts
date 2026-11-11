import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';

export type OutboundMediaType = 'image' | 'video' | 'audio' | 'document';
export interface OutboundMediaInput {
  message_type?: unknown;
  media_url?: unknown;
  mime_type?: unknown;
  response_format?: unknown;
}
export interface OutboundMedia {
  messageType: OutboundMediaType;
  content: { mediaUrl: string; mimeType?: string };
}

export class OutboundMediaError extends Error {
  readonly status = 400;
}

/** Explicit metadata only: ordinary links in text must never become attachments. */
export function validateOutboundMediaShape(input: OutboundMediaInput, channel: string): OutboundMedia | undefined {
  const { message_type: type, media_url: url, mime_type: mime } = input;
  if (type === undefined && url === undefined && mime === undefined) return undefined;
  if (type === 'text' && url === undefined && mime === undefined) return undefined;
  if (!['image', 'video', 'audio', 'document'].includes(type as string)
    || typeof url !== 'string' || !url.trim() || url.length > 8192) {
    throw new OutboundMediaError('Media requires message_type (image, video, audio or document) and media_url');
  }
  if (input.response_format === 'audio') {
    throw new OutboundMediaError('Existing media cannot be combined with generated audio response_format');
  }
  const normalizedChannel = channel.toLowerCase();
  if (['sms', 'voice', 'facebook', 'threads', 'linkedin', 'x', 'twitter', 'youtube'].includes(normalizedChannel)) {
    throw new OutboundMediaError(`Media attachments are not supported by the ${normalizedChannel} reply adapter`);
  }
  if (normalizedChannel === 'instagram' && !['image', 'video'].includes(type as string)) {
    throw new OutboundMediaError('Instagram direct messages support image and video attachments only');
  }
  if (mime !== undefined && (typeof mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime))) {
    throw new OutboundMediaError('Invalid media MIME type');
  }
  if (typeof mime === 'string' && type !== 'document' && !mime.toLowerCase().startsWith(`${type}/`)) {
    throw new OutboundMediaError('Media MIME type does not match message_type');
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new OutboundMediaError('Invalid media URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new OutboundMediaError('Media requires a public HTTPS URL without credentials');
  }
  return { messageType: type as OutboundMediaType, content: {
    mediaUrl: url, ...(typeof mime === 'string' ? { mimeType: mime } : {}),
  } };
}

/** The provider downloads media; this API validates public DNS but never fetches it. */
export async function validateOutboundMedia(input: OutboundMediaInput, channel: string): Promise<OutboundMedia | undefined> {
  const media = validateOutboundMediaShape(input, channel);
  if (media) {
    try { await assertSafeRemoteUrl(media.content.mediaUrl); }
    catch { throw new OutboundMediaError('Media URL must resolve to a public HTTPS resource'); }
  }
  return media;
}

/** Legacy WhatsApp accepts one media item per message, not a multi-file MMS. */
export async function validateWhatsAppMedia(input: OutboundMediaInput & { media_urls?: unknown }): Promise<string[]> {
  const media = await validateOutboundMedia(input, 'whatsapp');
  const urls = input.media_urls;
  if (urls !== undefined && (!Array.isArray(urls) || urls.length > 1
    || urls.some(url => typeof url !== 'string' || !url.trim()))) {
    throw new OutboundMediaError('WhatsApp media_urls must contain at most one public HTTPS URL');
  }
  if (media && Array.isArray(urls) && urls.length) {
    throw new OutboundMediaError('Use media_url or media_urls, not both');
  }
  if (input.response_format === 'audio' && Array.isArray(urls) && urls.length) {
    throw new OutboundMediaError('Existing media cannot be combined with generated audio response_format');
  }
  const legacy = (urls || []) as string[];
  for (const url of legacy) {
    // Reuse syntax checks even when callers mock/replace the DNS validator.
    validateOutboundMediaShape({ message_type: 'document', media_url: url }, 'whatsapp');
    try { await assertSafeRemoteUrl(url); }
    catch { throw new OutboundMediaError('Media URL must resolve to a public HTTPS resource'); }
  }
  return media ? [media.content.mediaUrl] : [...legacy];
}