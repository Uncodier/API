import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Sandbox } from '@vercel/sandbox';

const MAX_SCREENSHOT_BYTES = 900_000;
const CAPTURE_DIRECTORY = '/tmp/visual-probe-captures';
const SCREENSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const STORAGE_LIST_PAGE_SIZE = 100;
const RETENTION_MARKER_PATH = 'probe-screenshots/retention-sweep.marker';

type StorageBucketApi = ReturnType<
  ReturnType<typeof createClient>['storage']['from']
>;
type StorageListResult = Awaited<ReturnType<StorageBucketApi['list']>>;
type StorageEntry = NonNullable<StorageListResult['data']>[number];

export interface LocalVisualCapture {
  route: string;
  viewport: string;
  local_path: string;
  content_type: 'image/jpeg' | 'image/png';
  byte_size: number;
  dom_snippet?: string;
}

export interface PersistedVisualCapture {
  route: string;
  viewport: string;
  url: string;
  storage_path: string;
  dom_snippet?: string;
}

export interface VisualStorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

export function resolveVisualStorageConfig(
  env: Record<string, string | undefined> = process.env,
): VisualStorageConfig | null {
  const candidates = [
    {
      url: env.APPS_SUPABASE_URL,
      serviceKey: env.APPS_SUPABASE_SERVICE_KEY,
    },
    {
      url: env.REPOSITORY_SUPABASE_URL,
      serviceKey:
        env.REPOSITORY_SUPABASE_SERVICE_ROLE_KEY ||
        env.REPOSITORY_SUPABASE_SERVICE_KEY,
    },
  ];
  const matched = candidates.find(
    (candidate) => candidate.url?.trim() && candidate.serviceKey?.trim(),
  );
  if (!matched?.url || !matched.serviceKey) return null;
  return {
    url: matched.url.trim().replace(/\/+$/, ''),
    serviceKey: matched.serviceKey.trim(),
    bucket: env.SUPABASE_BUCKET?.trim() || 'workspaces',
  };
}

export function safeVisualStorageSegment(value: string, fallback: string): string {
  const safe = value
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return safe || fallback;
}

export function createVisualStorageLocator(
  bucket: string,
  storagePath: string,
): string {
  const encodedPath = storagePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `visual-storage://storage/${encodeURIComponent(bucket)}/${encodedPath}`;
}

function assertTrustedLocalPath(localPath: string): void {
  if (
    !localPath.startsWith(`${CAPTURE_DIRECTORY}/`) ||
    localPath.includes('/../') ||
    localPath.includes('\\')
  ) {
    throw new Error(`Visual capture returned an unsafe local path: ${localPath}`);
  }
}

async function listAllStorageEntries(
  storage: StorageBucketApi,
  prefix: string,
): Promise<StorageEntry[]> {
  const entries: StorageEntry[] = [];
  for (let offset = 0; ; offset += STORAGE_LIST_PAGE_SIZE) {
    const { data, error } = await storage.list(prefix, {
      limit: STORAGE_LIST_PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(error.message);
    entries.push(...(data || []));
    if ((data || []).length < STORAGE_LIST_PAGE_SIZE) return entries;
  }
}

async function removeStoragePaths(
  storage: StorageBucketApi,
  paths: string[],
): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += STORAGE_LIST_PAGE_SIZE) {
    const { error } = await storage.remove(
      paths.slice(offset, offset + STORAGE_LIST_PAGE_SIZE),
    );
    if (error) throw new Error(error.message);
  }
}

async function enforceGlobalScreenshotRetention(
  storage: StorageBucketApi,
): Promise<void> {
  const now = Date.now();
  const rootEntries = await listAllStorageEntries(storage, 'probe-screenshots');
  const marker = rootEntries.find(
    (entry) => entry.name === 'retention-sweep.marker',
  );
  const markerUpdatedAt = Date.parse(
    marker?.updated_at || marker?.created_at || '',
  );
  if (
    Number.isFinite(markerUpdatedAt) &&
    markerUpdatedAt >= now - RETENTION_SWEEP_INTERVAL_MS
  ) {
    return;
  }

  const cutoff = now - SCREENSHOT_RETENTION_MS;
  for (const requirement of rootEntries) {
    if (!/^req-[a-z0-9_-]+$/i.test(requirement.name)) continue;
    const requirementPrefix = `probe-screenshots/${requirement.name}`;
    const steps = await listAllStorageEntries(storage, requirementPrefix);
    for (const step of steps) {
      if (!/^step-\d+$/.test(step.name)) continue;
      const stepPrefix = `${requirementPrefix}/${step.name}`;
      const files = await listAllStorageEntries(storage, stepPrefix);
      const stalePaths = files
        .filter((file) => {
          if (!/\.(?:jpg|png)$/i.test(file.name)) return false;
          const updatedAt = Date.parse(file.updated_at || file.created_at || '');
          return Number.isFinite(updatedAt) && updatedAt < cutoff;
        })
        .map((file) => `${stepPrefix}/${file.name}`);
      await removeStoragePaths(storage, stalePaths);
    }
  }

  const { error } = await storage.upload(
    RETENTION_MARKER_PATH,
    Buffer.from(new Date(now).toISOString()),
    {
      contentType: 'text/plain',
      cacheControl: '60',
      upsert: true,
    },
  );
  if (error) throw new Error(error.message);
}

export async function persistVisualCaptures(params: {
  sandbox: Sandbox;
  captures: LocalVisualCapture[];
  requirementId?: string;
  stepOrder: number;
  config: VisualStorageConfig;
}): Promise<{ screenshots: PersistedVisualCapture[]; errors: string[] }> {
  const client = createClient(params.config.url, params.config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const screenshots: PersistedVisualCapture[] = [];
  const errors: string[] = [];
  let bucketResult = await client.storage.getBucket(params.config.bucket);
  if (!bucketResult.data) {
    const created = await client.storage.createBucket(params.config.bucket, {
      public: false,
    });
    if (!created.error) {
      bucketResult = await client.storage.getBucket(params.config.bucket);
    } else if (!/already exists/i.test(created.error.message)) {
      return {
        screenshots,
        errors: [
          `Could not provision private screenshot bucket: ${created.error.message}`,
        ],
      };
    } else {
      bucketResult = await client.storage.getBucket(params.config.bucket);
    }
  }
  if (bucketResult.error || !bucketResult.data) {
    return {
      screenshots,
      errors: [
        `Could not verify screenshot bucket privacy: ${bucketResult.error?.message || 'bucket metadata unavailable'}`,
      ],
    };
  }
  if (bucketResult.data?.public) {
    return {
      screenshots,
      errors: [
        `Screenshot bucket "${params.config.bucket}" is public; refusing to upload visual evidence`,
      ],
    };
  }
  const storage = client.storage.from(params.config.bucket);
  const requirement = safeVisualStorageSegment(params.requirementId || '', 'unknown');
  const storagePrefix =
    `probe-screenshots/req-${requirement}/step-${params.stepOrder}`;

  for (const capture of params.captures) {
    try {
      assertTrustedLocalPath(capture.local_path);
      const bytes = await params.sandbox.fs.readFile(capture.local_path);
      if (
        bytes.length === 0 ||
        bytes.length > MAX_SCREENSHOT_BYTES ||
        capture.byte_size !== bytes.length
      ) {
        throw new Error(
          `invalid screenshot size (${bytes.length} bytes, reported ${capture.byte_size})`,
        );
      }

      const extension = capture.content_type === 'image/jpeg' ? 'jpg' : 'png';
      const route = safeVisualStorageSegment(capture.route, 'root');
      const routeHash = createHash('sha256')
        .update(capture.route)
        .digest('hex')
        .slice(0, 10);
      const viewport = safeVisualStorageSegment(capture.viewport, 'viewport');
      const storagePath =
        `${storagePrefix}/${route}__${routeHash}__${viewport}.${extension}`;
      const { error } = await storage.upload(storagePath, bytes, {
        contentType: capture.content_type,
        cacheControl: '60',
        upsert: true,
      });
      if (error) throw new Error(error.message);

      screenshots.push({
        route: capture.route,
        viewport: capture.viewport,
        url: createVisualStorageLocator(params.config.bucket, storagePath),
        storage_path: storagePath,
        dom_snippet: capture.dom_snippet,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${capture.route} (${capture.viewport}): ${message}`);
    }
  }

  if (screenshots.length > 0) {
    const uploadedComplete = screenshots.length === params.captures.length;
    try {
      const data = await listAllStorageEntries(storage, storagePrefix);
      const activeNames = new Set(
        screenshots.map((screenshot) =>
          screenshot.storage_path.slice(storagePrefix.length + 1),
        ),
      );
      const stale = (data || [])
        .map((entry) => entry.name)
        .filter(
          (name) =>
            /__\d{10,}\.(?:jpg|png)$/i.test(name) ||
            (uploadedComplete &&
              /\.(?:jpg|png)$/i.test(name) &&
              !activeNames.has(name)),
        )
        .map((name) => `${storagePrefix}/${name}`);
      await removeStoragePaths(storage, stale);
    } catch (error: unknown) {
      console.warn(
        '[VisualProbe] Could not remove legacy screenshot objects:',
        error instanceof Error ? error.message : error,
      );
    }

    if (uploadedComplete) {
      try {
        await enforceGlobalScreenshotRetention(storage);
      } catch (error: unknown) {
        console.warn(
          '[VisualProbe] Could not enforce screenshot retention:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return { screenshots, errors };
}

export async function cleanupLocalVisualCaptures(sandbox: Sandbox): Promise<void> {
  await sandbox.fs.rm(CAPTURE_DIRECTORY, { recursive: true, force: true }).catch(() => undefined);
}
