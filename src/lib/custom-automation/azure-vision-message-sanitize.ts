/**
 * Sanitize chat message image_url parts for Azure OpenAI vision.
 * Rejects or fixes payloads that trigger 400 invalid_image_format (unsupported MIME, bad base64, mislabeled raster).
 */

import { Buffer } from 'node:buffer';

const LOG_PREFIX = '[AZURE_VISION_SANITIZE]';

type RasterKind = 'jpeg' | 'png' | 'gif' | 'webp';

function detectRasterKindFromBase64Prefix(b64: string): RasterKind | null {
  const sample = b64.replace(/\s/g, '').slice(0, 4096);
  if (sample.length < 12) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(sample, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function mimeForKind(kind: RasterKind): string {
  switch (kind) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function parseDataImageBase64(url: string): { subtype: string; payload: string } | null {
  if (!url.startsWith('data:image/')) return null;
  const semi = url.indexOf(';');
  const comma = url.indexOf(',');
  if (semi < 0 || comma < 0 || comma <= semi) return null;
  const mimePart = url.slice('data:'.length, semi);
  const afterSemi = url.slice(semi + 1, comma);
  if (!afterSemi.toLowerCase().startsWith('base64')) return null;
  const subtype = mimePart.replace(/^image\//i, '').split(';')[0].trim().toLowerCase();
  const payload = url.slice(comma + 1).replace(/\s/g, '');
  return { subtype, payload };
}

function isDeclaredAzureRasterSubtype(subtype: string): boolean {
  return (
    subtype === 'jpeg' ||
    subtype === 'jpg' ||
    subtype === 'pjpeg' ||
    subtype === 'png' ||
    subtype === 'gif' ||
    subtype === 'webp'
  );
}

/**
 * Returns a safe data URL for Azure vision, or null to drop the image.
 */
export function normalizeOrDropAzureVisionImageUrl(url: string): { ok: true; url: string } | { ok: false; reason: string } {
  if (url == null || typeof url !== 'string') {
    return { ok: false, reason: 'missing_url' };
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty_url' };
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const u = new URL(trimmed);
      const path = u.pathname.toLowerCase();
      if (path.endsWith('.svg') || path.endsWith('.svgz')) {
        return { ok: false, reason: 'unsupported_remote_svg' };
      }
    } catch {
      return { ok: false, reason: 'invalid_http_url' };
    }
    return { ok: true, url: trimmed };
  }

  const parsed = parseDataImageBase64(trimmed);
  if (!parsed) {
    return { ok: false, reason: 'malformed_or_non_base64_data_url' };
  }

  const { payload } = parsed;
  if (payload.length < 16) {
    return { ok: false, reason: 'payload_too_small' };
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(payload)) {
    return { ok: false, reason: 'invalid_base64_charset' };
  }
  const b64 = payload;

  const detected = detectRasterKindFromBase64Prefix(b64);
  const declaredOk = isDeclaredAzureRasterSubtype(parsed.subtype);

  if (declaredOk && detected) {
    const declaredKind: RasterKind | null =
      parsed.subtype === 'jpg' || parsed.subtype === 'jpeg' || parsed.subtype === 'pjpeg'
        ? 'jpeg'
        : parsed.subtype === 'png'
          ? 'png'
          : parsed.subtype === 'gif'
            ? 'gif'
            : parsed.subtype === 'webp'
              ? 'webp'
              : null;
    if (declaredKind && declaredKind !== detected) {
      const fixed = `data:${mimeForKind(detected)};base64,${b64}`;
      return { ok: true, url: fixed };
    }
    return { ok: true, url: trimmed };
  }

  if (!declaredOk && detected) {
    const fixed = `data:${mimeForKind(detected)};base64,${b64}`;
    return { ok: true, url: fixed };
  }

  if (declaredOk && !detected) {
    return { ok: false, reason: 'declared_raster_but_bytes_not_recognized' };
  }

  return { ok: false, reason: `unsupported_or_unrecognized_image_subtype:${parsed.subtype}` };
}

/**
 * Walks messages in place: fixes or removes image_url parts invalid for Azure vision.
 * Returns number of image parts removed (not fixed).
 */
export function sanitizeMessagesForAzureVisionImages(messages: any[]): number {
  let removed = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (part?.type !== 'image_url' || !part.image_url?.url) continue;

      const raw = part.image_url.url;
      const result = normalizeOrDropAzureVisionImageUrl(raw);
      if (!result.ok) {
        console.warn(`${LOG_PREFIX} Dropped image part: ${result.reason}`);
        msg.content.splice(j, 1);
        removed++;
        continue;
      }
      if (result.url !== raw) {
        console.warn(`${LOG_PREFIX} Rewrote image URL (mime/bytes alignment): ${raw.slice(0, 40)}...`);
      }
      part.image_url.url = result.url;
    }

    if (msg.content.length === 0) {
      messages.splice(i, 1);
    } else if (
      msg.content.length === 1 &&
      msg.content[0].type === 'text' &&
      typeof msg.content[0].text === 'string' &&
      (msg.content[0].text.includes('Here are the') || msg.content[0].text.includes('Here is the visual'))
    ) {
      messages.splice(i, 1);
    }
  }

  return removed;
}

/**
 * If the string is a data/image URL, normalize for Azure or return null (do not enqueue bad screenshots).
 */
export function ensureAzureSafeDataImageUrl(raw: string): string | null {
  const r = normalizeOrDropAzureVisionImageUrl(raw);
  return r.ok ? r.url : null;
}

/** Azure / OpenAI client may surface invalid_image_format on the error object in different shapes. */
export function isAzureInvalidImageError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; error?: { code?: string; message?: string } };
  const code = e?.code ?? e?.error?.code;
  if (code === 'invalid_image_format') return true;
  const msg = `${e?.message ?? ''} ${e?.error?.message ?? ''}`.toLowerCase();
  return msg.includes('invalid_image') || msg.includes('invalid image');
}
