import { validateOutboundMedia } from '@/lib/services/channels/outbound-media';
import type { ResponseFormat } from '@/lib/services/channels/response-format';

/** Existing attachments are distinct from a request to synthesize speech. */
export type SupportResponseMedia = {
  message_type?: unknown;
  media_url?: unknown;
  mime_type?: unknown;
};

/** Empty fields are the plain-text model target defaults, not an attachment. */
export function normalizeSupportMedia(media: SupportResponseMedia | undefined): SupportResponseMedia | undefined {
  if (!media) return undefined;
  return {
    ...(media.message_type !== undefined ? { message_type: media.message_type } : {}),
    ...(media.media_url !== '' && media.media_url !== undefined ? { media_url: media.media_url } : {}),
    ...(media.mime_type !== '' && media.mime_type !== undefined ? { mime_type: media.mime_type } : {}),
  };
}

export async function validateSupportResponseMedia(
  media: SupportResponseMedia | undefined, channel: string, responseFormat: ResponseFormat,
  publicComment = false,
) {
  const payload = await validateOutboundMedia({ ...normalizeSupportMedia(media), response_format: responseFormat }, channel);
  if (!payload) return undefined;
  if (publicComment) throw new Error('CUSTOMER_SUPPORT_COMMENT_MEDIA_UNSUPPORTED');
  return {
    message_type: payload.messageType,
    media_url: payload.content.mediaUrl,
    ...(payload.content.mimeType ? { mime_type: payload.content.mimeType } : {}),
  };
}

export function supportMediaContext(): string {
  return '\n\nExisting response media: To select an existing attachment, set message.message_type to image, video, audio or document, message.media_url to its known public HTTPS URL, and message.mime_type to its known MIME type (or an empty string when unknown). Never invent URLs or create/upload media. For a plain text or synthesized speech response, set message_type="text" and leave media_url and mime_type empty. Existing audio uses message_type="audio" with response_format="text"; response_format="audio" means downstream speech synthesis from content and cannot be combined with any existing media. Content is an optional caption for existing media. Select media only when supported by the current channel, never for public comments. Never send or synthesize during support generation.\n';
}