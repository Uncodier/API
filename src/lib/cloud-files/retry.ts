import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createCloudFileStore } from './store';
import { publishCloudRevision } from './git';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';

/** Existing cron drains durable Git intents even after requirement execution ends.
 * No inference, requirement restart, workspace or public document URLs.
 */
export async function retryPendingCloudGit(options: {
  client?: typeof supabaseAdmin; publish?: typeof publishCloudRevision; env?: Record<string, string | undefined>;
} = {}): Promise<{ attempted: number; committed: number }> {
  const env = options.env ?? process.env;
  if (!env.CLOUD_FILES_GITHUB_REPOSITORY || !env.CLOUD_FILES_GITHUB_TOKEN || env.CLOUD_FILES_GITHUB_NO_DEPLOY !== 'true') {
    return { attempted: 0, committed: 0 };
  }
  const client = options.client ?? supabaseAdmin;
  const { data, error } = await client.rpc('claim_cloud_git_publications', { p_limit: 1 });
  if (error || !Array.isArray(data)) return { attempted: 0, committed: 0 };
  const store = createCloudFileStore(client);
  let committed = 0;
  for (const item of data) {
    const scope = { siteId: item.site_id, userId: item.user_id, instanceId: item.instance_id,
      ...(item.requirement_id ? { requirementId: item.requirement_id } : {}) };
    const signal = AbortSignal.timeout(30000);
    const active = async () => { signal.throwIfAborted(); await assertToolScreenAccess('read_cloud_file', scope); };
    try {
      await active();
      const revision = await store.read(scope, item.file_id, item.version);
      if (revision) {
        const published = await (options.publish ?? publishCloudRevision)(scope, revision, { store, env, assertActive: active, signal });
        if (published.git_status === 'committed') committed++;
      }
    } catch { /* Durable due/backoff retains the exact revision; no model replay. */ }
  }
  return { attempted: data.length, committed };
}