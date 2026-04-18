import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

const WORK_DIR = SandboxService.WORK_DIR;

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

  const bucket = process.env.SUPABASE_BUCKET || 'workspaces';
  const repoUrl = process.env.REPOSITORY_SUPABASE_URL;
  const repoKey = process.env.REPOSITORY_SUPABASE_ANON_KEY;
  if (!repoUrl || !repoKey) {
    return {
      ok: false,
      error: 'REPOSITORY_SUPABASE_URL and REPOSITORY_SUPABASE_ANON_KEY are required for source archive upload.',
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

  const b64Res = await sandbox.runCommand('base64', ['-w', '0', tarPath]);
  if (b64Res.exitCode !== 0) {
    return { ok: false, error: `Failed to encode archive: ${(await b64Res.stderr()).trim()}` };
  }
  const b64Content = (await b64Res.stdout()).trim();
  const buffer = Buffer.from(b64Content, 'base64');

  const { createClient } = await import('@supabase/supabase-js');
  const storageClient = createClient(repoUrl, repoKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await storageClient.storage.from(bucket).upload(tarName, buffer, {
    contentType: 'application/gzip',
    upsert: true,
  });

  if (error) {
    return { ok: false, error: `Supabase upload failed: ${error.message}` };
  }

  const { data: urlData } = storageClient.storage.from(bucket).getPublicUrl(tarName);
  return {
    ok: true,
    public_url: urlData.publicUrl,
    file: tarName,
    size_bytes: buffer.length,
    storage_path: data.path,
  };
}
