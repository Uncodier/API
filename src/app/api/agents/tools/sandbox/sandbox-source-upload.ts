import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

const WORK_DIR = SandboxService.WORK_DIR;

import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, unlinkSync } from 'fs';

export const SOURCE_ARCHIVE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SourceArchiveStorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

export function resolveSourceArchiveStorageConfig(
  env: Record<string, string | undefined> = process.env,
): SourceArchiveStorageConfig | null {
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

export type SandboxSourceUploadOk = {
  ok: true;
  public_url: string;
  file: string;
  size_bytes: number;
  storage_path: string;
};

export type SandboxSourceUploadErr = {
  ok: false;
  error: string;
};

/**
 * Archives the sandbox workspace (excluding heavy dirs) and uploads to repository Supabase Storage
 * as `req-{requirementId}_source_code.tar.gz` — same object name expected by cron `checkSourceCodeStep`.
 */
export async function uploadSandboxSourceArchiveToRepository(
  sandbox: Sandbox,
  requirementId: string,
): Promise<SandboxSourceUploadOk | SandboxSourceUploadErr> {
  const rid = requirementId.trim();
  if (!rid) {
    return { ok: false, error: 'requirementId is required for source archive upload.' };
  }

  const storageConfig = resolveSourceArchiveStorageConfig();
  if (!storageConfig) {
    return {
      ok: false,
      error:
        'A matching repository Supabase URL and service-role key are required for source archive upload.',
    };
  }

  const tarName = `req-${rid}_source_code.tar.gz`;
  const tarPath = `/tmp/${tarName}`;

  const tarRes = await sandbox.runCommand({
    cmd: 'tar',
    args: ['--exclude=node_modules', '--exclude=.git', '--exclude=.next', '-czf', tarPath, '.'],
    cwd: WORK_DIR,
  });
  if (tarRes.exitCode !== 0) {
    return { ok: false, error: `Failed to archive source code: ${(await tarRes.stderr()).trim()}` };
  }

  const localTarPath = join(tmpdir(), tarName);
  let buffer: Buffer;
  try {
    await sandbox.downloadFile({ path: tarPath }, { path: localTarPath });
    buffer = readFileSync(localTarPath);
  } catch (e: any) {
    return { ok: false, error: `Failed to download archive from sandbox: ${e.message}` };
  } finally {
    try {
      unlinkSync(localTarPath);
    } catch (_) {}
  }

  const { createClient } = await import('@supabase/supabase-js');
  const storageClient = createClient(
    storageConfig.url,
    storageConfig.serviceKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  let bucketResult = await storageClient.storage.getBucket(
    storageConfig.bucket,
  );
  if (!bucketResult.data) {
    const created = await storageClient.storage.createBucket(
      storageConfig.bucket,
      { public: false },
    );
    if (created.error && !/already exists/i.test(created.error.message)) {
      return {
        ok: false,
        error: `Could not provision private archive bucket: ${created.error.message}`,
      };
    }
    bucketResult = await storageClient.storage.getBucket(storageConfig.bucket);
  }
  if (bucketResult.error || !bucketResult.data || bucketResult.data.public) {
    return {
      ok: false,
      error: bucketResult.data?.public
        ? `Archive bucket "${storageConfig.bucket}" must be private`
        : `Could not verify archive bucket: ${bucketResult.error?.message || 'metadata unavailable'}`,
    };
  }

  const storage = storageClient.storage.from(storageConfig.bucket);
  const { data, error } = await storage.upload(tarName, buffer, {
    contentType: 'application/gzip',
    upsert: true,
  });

  if (error) {
    return { ok: false, error: `Supabase upload failed: ${error.message}` };
  }

  const { data: urlData, error: signedError } = await storage.createSignedUrl(
    tarName,
    SOURCE_ARCHIVE_URL_TTL_SECONDS,
  );
  if (signedError || !urlData?.signedUrl) {
    return {
      ok: false,
      error:
        `Supabase archive signing failed: ${signedError?.message || 'signed URL unavailable'}`,
    };
  }
  return {
    ok: true,
    public_url: urlData.signedUrl,
    file: tarName,
    size_bytes: buffer.length,
    storage_path: data.path,
  };
}
