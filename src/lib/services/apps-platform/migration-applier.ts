import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { lintMigration } from './migration-linter';
import { Sandbox } from '@vercel/sandbox';

function schemaForRequirement(requirementId: string): string {
  return `app_${requirementId.replace(/-/g, '').slice(0, 24)}`;
}

export async function applyPendingMigrations(
  sandbox: Sandbox,
  requirementId: string
): Promise<{ applied: string[]; errors: string[] }> {
  const client = getAppsAdminClient();
  const schema = schemaForRequirement(requirementId);

  // Get tenant_id
  const { data: tenantRow } = await client
    .from('apps_tenants')
    .select('tenant_id')
    .eq('requirement_id', requirementId)
    .maybeSingle();

  if (!tenantRow?.tenant_id) {
    return { applied: [], errors: ['Tenant not provisioned for this requirement.'] };
  }
  const tenantId = tenantRow.tenant_id;

  // Find migration files in the sandbox
  // Check both migrations/ and supabase/migrations/
  const findCmd = await sandbox.runCommand('sh', [
    '-c',
    `find migrations supabase/migrations src/db/migrations -name "*.sql" -type f 2>/dev/null | sort`
  ]);
  const stdout = await findCmd.stdout();
  const files = stdout.trim().split('\n').filter(Boolean);

  if (files.length === 0) {
    return { applied: [], errors: [] };
  }

  const applied: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    // Check if already applied
    const migrationKey = `migration:${file}`;
    let metaRow = null;
    try {
      const res = await client
        .from(`${schema}._meta` as any) // bypass type checking for dynamic schema
        .select('key')
        .eq('key', migrationKey)
        .maybeSingle();
      metaRow = res.data;
    } catch (e) {
      // If _meta doesn't exist yet, it will fail
    }

    if (metaRow) {
      continue; // Already applied
    }

    // Read file content
    const catCmd = await sandbox.runCommand('cat', [file]);
    const sql = await catCmd.stdout();

    if (!sql.trim()) {
      continue;
    }

    // Lint
    const lintResult = lintMigration({
      schema,
      tenant_id: tenantId,
      sql
    });

    if (!lintResult.ok) {
      const errorMsgs = lintResult.errors.map(e => `Line ${e.line}: ${e.message}`).join('\n');
      errors.push(`File ${file} failed linting:\n${errorMsgs}`);
      continue;
    }

    // Execute
    // We need to set search_path to the tenant schema so that unqualified table names go there
    const wrappedSql = `
      set search_path to "${schema}";
      ${sql}
    `;

    const { error: execError } = await client.rpc('apps_exec_sql', { sql: wrappedSql });

    if (execError) {
      errors.push(`File ${file} failed to execute: ${execError.message}`);
      continue;
    }

    // Record as applied
    await client.rpc('apps_exec_sql', {
      sql: `
        insert into "${schema}"."_meta" (key, value)
        values ('${migrationKey}', '{"applied_at": "${new Date().toISOString()}"}'::jsonb)
        on conflict (key) do nothing;
      `
    });

    applied.push(file);
  }

  return { applied, errors };
}
