'use step';

import { createClient } from '@supabase/supabase-js';
import {
  resolveSourceArchiveStorageConfig,
  SOURCE_ARCHIVE_URL_TTL_SECONDS,
  uploadSandboxSourceArchiveToRepository,
} from '@/app/api/agents/tools/sandbox/sandbox-source-upload';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';

export async function checkSourceCodeStep(reqId: string): Promise<string | null> {
  'use step';
  const storageConfig = resolveSourceArchiveStorageConfig();
  if (!storageConfig) return null;

  const storageClient = createClient(
    storageConfig.url,
    storageConfig.serviceKey,
    {
    auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const storage = storageClient.storage.from(storageConfig.bucket);
  const names = [`req-${reqId}_source_code.tar.gz`, `req-${reqId}_source_code.zip`];
  for (const name of names) {
    const { data, error } = await storage.list('', { search: name, limit: 10 });
    if (error || !data?.some((entry) => entry.name === name)) continue;
    const { data: signed, error: signedError } = await storage.createSignedUrl(
      name,
      SOURCE_ARCHIVE_URL_TTL_SECONDS,
    );
    if (!signedError && signed?.signedUrl) {
      return signed.signedUrl;
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
