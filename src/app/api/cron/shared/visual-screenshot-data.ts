import { createClient } from '@supabase/supabase-js';
import {
  resolveVisualStorageConfig,
  safeVisualStorageSegment,
} from './visual-screenshot-storage';

const MAX_FEEDBACK_IMAGE_BYTES = 900_000;
const FETCH_TIMEOUT_MS = 8_000;

function configuredStorageOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const origins = new Set<string>();
  for (const url of [env.APPS_SUPABASE_URL, env.REPOSITORY_SUPABASE_URL]) {
    if (!url) continue;
    try {
      origins.add(new URL(url).origin);
    } catch {
      // Ignore malformed environment values.
    }
  }
  return origins;
}

export interface VisualScreenshotFetchOptions {
  maxBytes?: number;
  requirementId: string;
  signal?: AbortSignal;
}

export async function fetchVisualScreenshotDataUrl(
  locator: string,
  options: VisualScreenshotFetchOptions,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(locator);
  } catch {
    return null;
  }

  const bucket = process.env.SUPABASE_BUCKET?.trim() || 'workspaces';
  const requirement = safeVisualStorageSegment(options.requirementId, 'unknown');
  const requiredObjectPrefix = `probe-screenshots/req-${requirement}/`;
  let fetchUrl = locator;
  let expectedOrigin: string;

  if (parsed.protocol === 'visual-storage:') {
    const config = resolveVisualStorageConfig();
    if (!config || parsed.hostname !== 'storage') return null;
    let segments: string[];
    try {
      segments = parsed.pathname
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return null;
    }
    if (
      segments.some(
        (segment) =>
          segment === '.' ||
          segment === '..' ||
          segment.includes('/') ||
          segment.includes('\\'),
      )
    ) {
      return null;
    }
    const locatorBucket = segments.shift();
    const storagePath = segments.join('/');
    if (
      locatorBucket !== config.bucket ||
      !storagePath.startsWith(requiredObjectPrefix)
    ) {
      return null;
    }
    const client = createClient(config.url, config.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.storage
      .from(config.bucket)
      .createSignedUrl(storagePath, 60);
    if (error || !data?.signedUrl) return null;
    fetchUrl = data.signedUrl;
    expectedOrigin = new URL(config.url).origin;
  } else {
    const allowedOrigins = configuredStorageOrigins();
    let pathname: string;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    const requiredPathPrefix =
      `/storage/v1/object/sign/${bucket}/${requiredObjectPrefix}`;
    if (
      parsed.protocol !== 'https:' ||
      !allowedOrigins.has(parsed.origin) ||
      !pathname.startsWith(requiredPathPrefix) ||
      !parsed.searchParams.has('token')
    ) {
      return null;
    }
    expectedOrigin = parsed.origin;
  }

  let fetchTarget: URL;
  try {
    fetchTarget = new URL(fetchUrl);
  } catch {
    return null;
  }
  if (fetchTarget.protocol !== 'https:' || fetchTarget.origin !== expectedOrigin) {
    return null;
  }

  const maxBytes = options.maxBytes ?? MAX_FEEDBACK_IMAGE_BYTES;

  try {
    const signal = options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetch(fetchTarget.toString(), {
      redirect: 'manual',
      signal,
    });
    if (response.url && new URL(response.url).origin !== expectedOrigin) return null;
    if (!response.ok) return null;

    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > maxBytes) return null;

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) return null;
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
