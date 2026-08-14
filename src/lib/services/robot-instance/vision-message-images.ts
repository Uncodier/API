/**
 * Hydrate/dehydrate multimodal image_url parts for the assistant LLM step.
 * Keeps large data URLs out of Vercel Workflow step serialization.
 */

import { fetchTwilioMedia, isTwilioMediaUrl } from '@/lib/services/twilio/fetchTwilioMedia';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

function mimeFromHint(fileTypeHint?: string): string {
  return MIME_BY_EXT[(fileTypeHint || 'png').toLowerCase()] || 'image/png';
}

function toDataImage(arrayBuffer: ArrayBuffer, headerMime?: string | null, fileTypeHint?: string): string {
  if (arrayBuffer.byteLength === 0) {
    throw new Error('Downloaded image is empty');
  }
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds 20MB limit');
  }

  const mimeType =
    headerMime && headerMime.startsWith('image/')
      ? headerMime.split(';')[0]!.trim()
      : mimeFromHint(fileTypeHint);
  const base64Content = Buffer.from(arrayBuffer).toString('base64');
  return `data:${mimeType};base64,${base64Content}`;
}

export async function downloadUrlAsDataImage(
  url: string,
  fileTypeHint?: string
): Promise<string> {
  if (isTwilioMediaUrl(url)) {
    const downloaded = await fetchTwilioMedia(url);
    return toDataImage(downloaded.buffer, downloaded.contentType, fileTypeHint);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error ${response.status} when downloading image`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return toDataImage(arrayBuffer, response.headers.get('content-type'), fileTypeHint);
}

function imagePartUrl(part: any): string | undefined {
  const raw = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  return typeof raw === 'string' ? raw : undefined;
}

function withImageUrl(part: any, dataUrl: string): any {
  if (typeof part.image_url === 'string') {
    return { ...part, image_url: dataUrl };
  }
  return { ...part, image_url: { ...part.image_url, url: dataUrl } };
}

export async function hydrateMessageImages(messages: any[]): Promise<any[]> {
  if (!Array.isArray(messages)) return messages;

  const cache = new Map<string, string>();

  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;

    const nextContent: any[] = [];
    for (const part of msg.content) {
      if (part?.type !== 'image_url') {
        nextContent.push(part);
        continue;
      }

      const raw = imagePartUrl(part);
      if (typeof raw !== 'string' || (!raw.startsWith('http://') && !raw.startsWith('https://'))) {
        nextContent.push(part);
        continue;
      }

      try {
        let dataUrl = cache.get(raw);
        if (!dataUrl) {
          dataUrl = await downloadUrlAsDataImage(raw);
          cache.set(raw, dataUrl);
        }
        nextContent.push(withImageUrl(part, dataUrl));
      } catch (error) {
        // Leave auth-protected URLs out of the Azure payload. Azure fetches
        // image_url itself and cannot send Twilio Basic Auth.
        console.error(`❌ [vision-message-images] Failed to hydrate ${raw}:`, error);
      }
    }
    msg.content = nextContent;
  }

  if (cache.size > 0) {
    console.log(`[vision-message-images] Hydrated ${cache.size} HTTP image(s) for vision`);
  }
  return messages;
}

export function dehydrateMessageImages(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages;

  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;

    const publicUrls: string[] = [];
    const textPart = msg.content.find((p: any) => p?.type === 'text' && typeof p.text === 'string');
    if (textPart?.text) {
      const matches = textPart.text.match(/https?:\/\/[^\s)]+/g);
      if (matches) {
        publicUrls.push(...matches.filter((candidate: string) => !isTwilioMediaUrl(candidate)));
      }
    }

    let httpIdx = 0;
    const nextContent: any[] = [];
    for (const part of msg.content) {
      if (part?.type !== 'image_url') {
        nextContent.push(part);
        continue;
      }
      const raw = imagePartUrl(part);
      if (typeof raw === 'string' && raw.startsWith('data:image/')) {
        const replacement = publicUrls[httpIdx++];
        if (replacement) {
          nextContent.push({
            type: 'image_url',
            image_url: { url: replacement },
          });
        }
        continue;
      }
      nextContent.push(part);
    }
    msg.content = nextContent;
  }

  return messages;
}
