/**
 * Hydrate/dehydrate multimodal image_url parts for the assistant LLM step.
 * Keeps large data URLs out of Vercel Workflow step serialization.
 */

import { fetchTwilioMedia, isTwilioMediaUrl } from '@/lib/services/twilio/fetchTwilioMedia';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Symbols survive in-process object spreads but are never sent in JSON to the
// provider or persisted in workflow checkpoints. No metadata field on the wire.
const SOURCE_URL = Symbol('visionSourceUrl');

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

/** Exact source identity, not hydrated bytes: distinct URLs may return identical images. */
export function getVisionImageSourceUrl(part: any): string | undefined {
  if (!part || part.type !== 'image_url') return undefined;
  return typeof part[SOURCE_URL] === 'string' ? part[SOURCE_URL] : imagePartUrl(part);
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
        nextContent.push({ ...withImageUrl(part, dataUrl), [SOURCE_URL]: raw });
      } catch (error) {
        // Never send unreadable/auth-protected URLs to the vision provider;
        // it cannot fetch Twilio images using our Basic Auth credentials.
        console.error(`❌ [vision-message-images] Failed to hydrate ${raw}:`, error);
        // Preserve the failed image's position/identity. Silently dropping it
        // leaves other (older) images visible and encourages false descriptions.
        nextContent.push({ type: 'text', text: `Image unavailable: ${JSON.stringify(raw)}. The image could not be downloaded and is NOT visible. Do not substitute another image or infer its contents from past descriptions. If this is the requested image, explain the failure and ask the user to resend it.` });
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

    const nextContent: any[] = [];
    for (const part of msg.content) {
      if (part?.type !== 'image_url') {
        nextContent.push(part);
        continue;
      }
      const raw = imagePartUrl(part);
      if (typeof raw === 'string' && raw.startsWith('data:image/')) {
        const replacement = part[SOURCE_URL];
        if (replacement) {
          const { [SOURCE_URL]: _source, ...cleanPart } = part;
          nextContent.push(withImageUrl(cleanPart, replacement));
        }
        continue;
      }
      nextContent.push(part);
    }
    msg.content = nextContent;
  }

  return messages;
}
