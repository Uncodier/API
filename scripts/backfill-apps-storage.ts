/** Operator-only, dry-run by default. Credentials come from environment, never CLI args.
 * Run with tsx; see docs/APPS_STORAGE_PROVISIONING_2026-09-30.md.
 */
import { createClient } from '@supabase/supabase-js';
import { ensureTenantStorage, getTenantStorageConfig, TenantStorageError, verifyTenantStorage } from '../src/lib/services/apps-platform/tenant-storage';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (args.some(arg => !/^(--apply|--project-ref=[a-z]+|--requirement=[a-f0-9-]+|--limit=\d+)$/.test(arg))) {
    throw new Error('Unsupported argument. Use --project-ref=REF [--requirement=UUID] [--limit=N] [--apply].');
  }
  const projectRef = value('project-ref');
  const requirementId = value('requirement');
  const limit = Number(value('limit') ?? '1000');
  if (!projectRef || !/^[a-z]{20}$/.test(projectRef) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000 ||
      (requirementId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requirementId))) {
    throw new Error('An explicit project ref, a valid optional requirement UUID and limit 1..10000 are required.');
  }
  const url = process.env.APPS_SUPABASE_URL || process.env.REPOSITORY_SUPABASE_URL;
  const key = process.env.APPS_SUPABASE_SERVICE_KEY || process.env.REPOSITORY_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || new URL(url).origin !== `https://${projectRef}.supabase.co` || !key) {
    throw new Error('Apps URL must match --project-ref and an Apps service key must be configured.');
  }
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let cursor: string | undefined;
  let processed = 0;
  let failures = 0;
  let created = 0;
  while (processed < limit) {
    let query = client.from('apps_tenants').select('requirement_id, tenant_id, schema, bucket, user_id, site_id')
      .eq('status', 'active').order('requirement_id').limit(Math.min(20, limit - processed));
    if (requirementId) query = query.eq('requirement_id', requirementId);
    if (cursor) query = query.gt('requirement_id', cursor);
    const { data, error } = await query;
    if (error || !data) throw new Error('Tenant inventory lookup failed.');
    if (!data.length) break;
    for (const tenant of data) {
      const binding = { requirementId: tenant.requirement_id, tenantId: tenant.tenant_id,
        schema: tenant.schema, bucket: tenant.bucket, userId: tenant.user_id, siteId: tenant.site_id };
      try {
        if (apply) {
          const result = await ensureTenantStorage(binding, client);
          if (result.created) created++;
          console.log(JSON.stringify({ requirement_id: tenant.requirement_id, state: result.created ? 'created' : 'verified' }));
        } else {
          await getTenantStorageConfig(binding, client);
          try {
            await verifyTenantStorage(binding, client);
            console.log(JSON.stringify({ requirement_id: tenant.requirement_id, state: 'verified' }));
          } catch (error) {
            if (!(error instanceof TenantStorageError) || error.code !== 'bucket_missing') throw error;
            console.log(JSON.stringify({ requirement_id: tenant.requirement_id, state: 'would_create' }));
          }
        }
      } catch (error) {
        failures++;
        console.error(JSON.stringify({ requirement_id: tenant.requirement_id,
          state: 'failed', code: error instanceof TenantStorageError ? error.code : 'unexpected_failure' }));
      }
      processed++;
      cursor = tenant.requirement_id;
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', processed, created, failures }));
  if (failures || (requirementId && processed === 0)) process.exitCode = 1;
}

main().catch(error => {
  // Deliberately omit provider response bodies and credentials.
  console.error(error instanceof TenantStorageError ? error.code : 'Storage backfill failed; verify arguments, project configuration and platform migration.');
  process.exitCode = 1;
});