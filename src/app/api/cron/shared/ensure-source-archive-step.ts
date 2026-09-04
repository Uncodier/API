'use step';

import { createClient } from '@supabase/supabase-js';
import { uploadSandboxSourceArchiveToRepository } from '@/app/api/agents/tools/sandbox/sandbox-source-upload';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';

export async function checkSourceCodeStep(reqId: string): Promise<string | null> {
  'use step';
  const repoUrl = process.env.REPOSITORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const repoKey = process.env.REPOSITORY_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!repoUrl || !repoKey) return null;

  const storageClient = createClient(repoUrl, repoKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = process.env.SUPABASE_BUCKET || 'workspaces';
  const names = [`req-${reqId}_source_code.tar.gz`, `req-${reqId}_source_code.zip`];
  for (const name of names) {
    const { data } = await storageClient.storage.from(bucket).list('', { search: name, limit: 1 });
    if (data?.length) {
      return storageClient.storage.from(bucket).getPublicUrl(name).data.publicUrl;
    }
  }
  return null;
}

/**
 * Prefer an existing storage archive; otherwise snapshot the live sandbox
 * even when git push failed this cycle.
 */
export async function ensureSourceArchiveStep(
  reqId: string,
  sandboxId?: string | null,
): Promise<string | null> {
  'use step';
  const existing = await checkSourceCodeStep(reqId);
  if (existing) return existing;
  if (!sandboxId) return null;

  try {
    const sandbox = await getSandboxHandle(sandboxId);
    const up = await uploadSandboxSourceArchiveToRepository(sandbox, reqId);
    if (up.ok) {
      console.log(`[CronPersist] finally archive uploaded: ${up.file}`);
      return up.public_url;
    }
    console.warn('[CronPersist] finally archive skipped:', up.error);
  } catch (e: unknown) {
    console.warn('[CronPersist] finally archive failed:', e instanceof Error ? e.message : e);
  }
  return null;
}
