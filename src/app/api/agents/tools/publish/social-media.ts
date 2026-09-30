export interface SocialMediaInput {
  text?: string;
  urls?: string[];
  assets?: string[];
  media_urls?: string[];
}

/** The caller supplies an authenticated client and an authorized, trusted site ID. */
export interface SocialMediaClient {
  getMedia(id: string, tenantId: string): Promise<unknown>;
}

export interface PreparedSocialMedia {
  content: string;
  media: Array<{ url: string; filename: string }>;
}

const MAX_URL_LENGTH = 8192;
const MAX_TEXT_LENGTH = 100_000;
const MAX_MEDIA = 20;
const MEDIA_EXTENSION = /\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?|mp4|mov|m4v|webm|avi|mkv|mpeg|mpg)$/i;
const PUBLIC_BUCKETS = new Set(['assets', 'generative_images', 'generative_videos']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, name: string, limit: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${name} must be an array with at most ${limit} entries.`);
  }
  const entries: string[] = [];
  // Iterate rather than map so sparse arrays cannot bypass item validation.
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLength
      || CONTROL_CHARACTERS.test(item)) {
      throw new Error(`${name} must contain non-empty strings of at most ${maxLength} characters.`);
    }
    entries.push(item.trim());
  }
  return Array.from(new Set(entries));
}

function parseWebUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid social URL. Use an absolute HTTP or HTTPS URL.');
  }
  if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.port || value.includes('\\')
    || CONTROL_CHARACTERS.test(value) || /%(?![\da-f]{2})/i.test(value)) {
    throw new Error('Social URLs must use HTTP or HTTPS without credentials or unexpected ports.');
  }
  return url;
}

function trustedStorageHosts(): Set<string> {
  const hosts = new Set(['db.makinari.com']);
  for (const value of [process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_URL]) {
    if (!value) continue;
    try {
      const url = parseWebUrl(value);
      // Only the configured Supabase project, never every *.supabase.co tenant.
      if (url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.supabase\.co$/.test(url.hostname)) {
        hosts.add(url.hostname);
      }
    } catch {
      // Invalid/private development configuration must not widen the allowlist.
    }
  }
  return hosts;
}

function mediaPath(value: string): string[] {
  const rawPath = value.match(/^https?:\/\/[^/?#]+([^?#]*)/i)?.[1] || '';
  let segments: string[];
  try {
    segments = rawPath.split('/').slice(1).map(decodeURIComponent);
  } catch {
    throw new Error('Media URL has an invalid encoded path.');
  }
  if (segments.length === 0 || segments.some((part) => !part || part === '.' || part === '..'
    || /[\\/%?#]/.test(part) || CONTROL_CHARACTERS.test(part))) {
    throw new Error('Media URL must identify a file without unsafe path segments.');
  }
  return segments;
}

function cleanFilename(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255
    || /[\\/?#]/.test(value) || CONTROL_CHARACTERS.test(value)
    || !MEDIA_EXTENSION.test(value) || value.startsWith('.')) {
    throw new Error('Social media requires a clean image or video filename with an extension.');
  }
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function attachment(value: string, hosts: Set<string>, filename?: unknown): PreparedSocialMedia['media'][number] {
  if (!value || value.length > MAX_URL_LENGTH) throw new Error('Invalid media URL length.');
  const url = parseWebUrl(value);
  const parts = mediaPath(value);
  // Official docs use media.outstand.so/<org>/<file>/<name> (and /renditions/...).
  // No wildcard/per-org media hostname is documented, so none is trusted here.
  const isProviderMedia = url.hostname === 'media.outstand.so';
  const isPublicStorage = hosts.has(url.hostname)
    && parts.slice(0, 4).join('/') === 'storage/v1/object/public'
    && PUBLIC_BUCKETS.has(parts[4]) && parts.length >= 6;
  if (url.protocol !== 'https:' || (!isProviderMedia && !isPublicStorage)) {
    throw new Error('Media URL must use trusted public HTTPS storage or media.outstand.so.');
  }
  url.hash = '';
  return { url: url.href, filename: cleanFilename(filename ?? parts[parts.length - 1]) };
}

function validateTenant(record: Record<string, unknown>, siteId: string): void {
  for (const key of ['tenant_id', 'tenantId', 'site_id', 'siteId']) {
    if (key in record && record[key] !== siteId) {
      throw new Error('Outstand media does not belong to the authorized site.');
    }
  }
}

async function uploadedAttachment(
  client: SocialMediaClient, id: string, siteId: string, hosts: Set<string>,
): Promise<PreparedSocialMedia['media'][number]> {
  let response: unknown;
  try {
    response = await client.getMedia(id, siteId);
  } catch {
    throw new Error('Unable to resolve uploaded Outstand media for this site.');
  }
  if (!isRecord(response) || response.success !== true || response.error) {
    throw new Error('Outstand media lookup failed or returned a malformed response.');
  }
  validateTenant(response, siteId);
  const data = 'data' in response ? response.data : response;
  if (!isRecord(data) || data.id !== id || typeof data.url !== 'string'
    || typeof data.filename !== 'string' || data.error) {
    throw new Error('Outstand media lookup returned malformed media.');
  }
  validateTenant(data, siteId);
  if (data.status !== 'active') throw new Error('Outstand media is not active and ready.');
  if (data.video != null && (!isRecord(data.video) || data.video.status !== 'ready')) {
    throw new Error('Outstand video media is not ready.');
  }
  if (data.expires_at !== undefined && (typeof data.expires_at !== 'string'
    || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now())) {
    throw new Error('Outstand media is expired or has an invalid expiration.');
  }
  if (data.content_type != null && (typeof data.content_type !== 'string'
    || !/^(?:image|video)\/[a-z0-9.+-]+$/i.test(data.content_type))) {
    throw new Error('Outstand media must be an image or video.');
  }
  return attachment(data.url, hosts, data.filename);
}

/**
 * Prepare only: no publishing, downloading, uploading, or DNS lookups.
 * Outstand accepts public HTTPS URLs and fetches at publish time; the caller
 * remains responsible for availability and platform-specific media limits.
 * https://www.outstand.so/docs/create-a-post (containers[].media)
 */
export async function prepareSocialMedia(
  client: SocialMediaClient, siteId: string, input: SocialMediaInput,
): Promise<PreparedSocialMedia> {
  if (typeof siteId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(siteId)) {
    throw new Error('An authorized site ID is required for social media preparation.');
  }
  if (!isRecord(input)) throw new Error('Social media input must be an object.');
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > MAX_TEXT_LENGTH)) {
    throw new Error(`Social text must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
  }
  const urls = stringList(input.urls, 'urls', 50, MAX_URL_LENGTH);
  const mediaUrls = stringList(input.media_urls, 'media_urls', MAX_MEDIA, MAX_URL_LENGTH);
  const assets = stringList(input.assets, 'assets', MAX_MEDIA, 200);
  if (assets.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error('assets must contain opaque uploaded Outstand media IDs, not URLs or paths.');
  }
  const hosts = trustedStorageHosts();
  const media = new Map<string, PreparedSocialMedia['media'][number]>();
  const links = new Map<string, string>();
  for (const value of urls) {
    const url = parseWebUrl(value);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new Error('Social URL has an invalid encoded path.');
    }
    if (MEDIA_EXTENSION.test(pathname)) {
      const item = attachment(value, hosts);
      media.set(item.url, item);
    } else {
      // Ordinary links are content, never fetch targets; do not storage-allowlist them.
      links.set(url.href, value);
    }
  }
  for (const value of mediaUrls) {
    const item = attachment(value, hosts);
    media.set(item.url, item);
  }
  if (media.size > MAX_MEDIA) throw new Error(`At most ${MAX_MEDIA} social media attachments are allowed.`);
  const text = input.text || '';
  const content = [text, ...Array.from(links.values())].filter(Boolean).join('\n\n');
  if (content.length > MAX_TEXT_LENGTH) throw new Error('Social content including links is too long.');
  for (const id of assets) {
    const item = await uploadedAttachment(client, id, siteId, hosts);
    media.set(item.url, item);
    if (media.size > MAX_MEDIA) throw new Error(`At most ${MAX_MEDIA} social media attachments are allowed.`);
  }
  if (!content.trim() && media.size === 0) throw new Error('Social posts require text, links, or media.');
  return { content, media: Array.from(media.values()) };
}