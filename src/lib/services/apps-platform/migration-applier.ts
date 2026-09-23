import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { lintMigration } from './migration-linter';
import { Sandbox } from '@vercel/sandbox';
import { syncPostgrestSchemas } from './postgrest-config';
import { createHash } from 'node:crypto';

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function applyPendingMigrations(
  sandbox: Sandbox,
  requirementId: string
): Promise<{ applied: string[]; errors: string[] }> {
  const client = getAppsAdminClient();

  const { data: tenantRow, error: tenantError } = await client
    .from('apps_tenants')
    .select('tenant_id, schema')
    .eq('requirement_id', requirementId)
    .maybeSingle();

  if (tenantError) {
    return {
      applied: [],
      errors: [`Could not load tenant registry: ${tenantError.message}`],
    };
  }
  if (
    !tenantRow?.tenant_id ||
    typeof tenantRow.schema !== 'string' ||
    !/^app_[a-f0-9]{24}$/.test(tenantRow.schema)
  ) {
    return { applied: [], errors: ['Tenant not provisioned for this requirement.'] };
  }
  const tenantId = tenantRow.tenant_id;
  const schema = tenantRow.schema;

  // Find migration files in the sandbox
  // Check both migrations/ and supabase/migrations/
  const findCmd = await sandbox.runCommand('sh', [
    '-c',
    'for dir in migrations supabase/migrations src/db/migrations; do ' +
      'if [ -d "$dir" ]; then find "$dir" -name "*.sql" -type f; fi; ' +
      'done | sort',
  ]);
  if (findCmd.exitCode !== 0) {
    const stderr = await findCmd.stderr().catch(() => '');
    return {
      applied: [],
      errors: [
        `Could not list migration files: ${stderr.trim() || `exit ${findCmd.exitCode}`}`,
      ],
    };
  }
  const stdout = await findCmd.stdout();
  const files = stdout.trim().split('\n').filter(Boolean);

  if (files.length === 0) {
    return { applied: [], errors: [] };
  }

  const applied: string[] = [];
  const errors: string[] = [];
  let shouldSyncExposure = false;

  for (const file of files) {
    const migrationKey = `migration:${file}`;

    // Read file content
    const catCmd = await sandbox.runCommand('cat', [file]);
    if (catCmd.exitCode !== 0) {
      const stderr = await catCmd.stderr().catch(() => '');
      errors.push(
        `Could not read migration ${file}: ` +
        (stderr.trim() || `exit ${catCmd.exitCode}`),
      );
      break;
    }
    const sql = await catCmd.stdout();

    if (!sql.trim()) {
      continue;
    }
    const checksum = migrationChecksum(sql);

    const { data: receipt, error: metaError } = await client.rpc(
      'apps_get_migration_receipt',
      {
        p_target_schema: schema,
        p_expected_tenant_id: tenantId,
        p_migration_key: migrationKey,
      },
    );
    if (metaError) {
      errors.push(
        `Could not read migration ledger for ${file}: ${metaError.message}`,
      );
      break;
    }
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      typeof receipt.found !== 'boolean'
    ) {
      errors.push(`Could not validate migration ledger receipt for ${file}.`);
      break;
    }
    if (receipt.found) {
      shouldSyncExposure = true;
      const recordedChecksum =
        receipt.value &&
        typeof receipt.value === 'object' &&
        'checksum' in receipt.value
          ? String(receipt.value.checksum)
          : null;
      if (recordedChecksum && recordedChecksum !== checksum) {
        errors.push(
          `Migration ${file} changed after it was applied. ` +
          'Create a new migration instead of editing applied SQL.',
        );
        break;
      }
      if (!recordedChecksum) {
        const { data: backfilled, error: backfillError } = await client.rpc(
          'apps_apply_migration',
          {
            p_target_schema: schema,
            p_expected_tenant_id: tenantId,
            p_migration_key: migrationKey,
            p_migration_checksum: checksum,
            p_migration_sql: sql,
          },
        );
        if (backfillError) {
          errors.push(
            `Could not backfill migration checksum for ${file}: ` +
            backfillError.message,
          );
          break;
        }
        if (backfilled !== false) {
          errors.push(
            `Could not confirm checksum backfill for ${file}.`,
          );
          break;
        }
      }
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
      break;
    }

    const { data: didApply, error: execError } = await client.rpc(
      'apps_apply_migration',
      {
        p_target_schema: schema,
        p_expected_tenant_id: tenantId,
        p_migration_key: migrationKey,
        p_migration_checksum: checksum,
        p_migration_sql: sql,
      },
    );

    if (execError) {
      errors.push(`File ${file} failed to execute: ${execError.message}`);
      break;
    }
    if (didApply === true) {
      applied.push(file);
      shouldSyncExposure = true;
    } else if (didApply === false) {
      shouldSyncExposure = true;
    } else {
      errors.push(
        `File ${file} did not return an atomic migration receipt.`,
      );
      break;
    }
  }

  if (shouldSyncExposure) {
    // Automatically expose schemas to PostgREST to ensure new tables/schemas are visible
    // and reload the schema cache so introspection works immediately.
    const syncResult = await syncPostgrestSchemas();
    if (!syncResult.ok) {
      errors.push(`Failed to sync schemas with Supabase Management API: ${syncResult.error}`);
    }
    const exposeSql = `
      notify pgrst, 'reload config';
      notify pgrst, 'reload schema';
    `;
    const { error: exposeError } = await client.rpc('apps_exec_sql', { sql: exposeSql });
    if (exposeError) {
      errors.push(`Failed to auto-expose schema to PostgREST: ${exposeError.message}`);
    }
  }

  return { applied, errors };
}
