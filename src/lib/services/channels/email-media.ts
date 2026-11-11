import { downloadDocument } from '@/app/api/agents/tools/read_document/source';
import { OutboundMediaError, type OutboundMedia } from './outbound-media';

export interface EmailMediaAttachment {
  filename: string;
  content: string;
  content_type: string;
}

/** Reuses the DNS-pinned, bounded downloader; never forwards provider credentials. */
export async function resolveEmailMediaAttachment(media: OutboundMedia): Promise<EmailMediaAttachment> {
  const loaded = await downloadDocument(media.content.mediaUrl, { httpsOnly: true });
  if (!loaded.buffer.length || loaded.buffer.length > 20 * 1024 * 1024) {
    throw new OutboundMediaError('Email media must be non-empty and no larger than 20 MiB');
  }
  const actualMime = loaded.mimeType.toLowerCase();
  const claimedMime = media.content.mimeType?.toLowerCase();
  if (claimedMime && actualMime && actualMime !== claimedMime) {
    throw new OutboundMediaError('Downloaded media MIME type does not match the requested MIME type');
  }
  const mime = actualMime || claimedMime || 'application/octet-stream';
  if (media.messageType !== 'document' && !mime.startsWith(`${media.messageType}/`)) {
    throw new OutboundMediaError('Downloaded media MIME type does not match message_type');
  }
  const filename = loaded.filename.replace(/[\x00-\x1f\x7f\\/]/g, '_').slice(0, 200) || 'attachment';
  return { filename, content: loaded.buffer.toString('base64'), content_type: mime };
}