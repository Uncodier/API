import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { lintMigration } from './migration-linter';
import { Sandbox } from '@vercel/sandbox';
import { syncPostgrestSchemas } from './postgrest-config';
import { createHash } from 'node:crypto';
import type { MigrationRepairTarget } from './migration-repair-types';
import { authorizeMigrationApplication, loadMigrationApplicationContext, type MigrationApplicationContext } from './migration-application-guard';
import { transitionMigrationLifecycle, type MigrationLifecycleRecord } from './migration-lifecycle';
import { migrationLifecycleValue } from './migration-lifecycle-value';

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function applyPendingMigrations(
  sandbox: Sandbox,
  requirementId: string,
  expectedRepairs: MigrationRepairTarget[] = [],
  applicationContext?: MigrationApplicationContext,
): Promise<{ applied: string[]; errors: string[]; failureKind?: 'product' | 'infrastructure'; repairTarget?: MigrationRepairTarget; correction?: MigrationLifecycleRecord }> {
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

  // A recovered sandbox must not turn a lost repair into an empty/passing batch.
  for (const expected of expectedRepairs) {
    if (expected.schema !== schema || expected.tenantId !== tenantId) {
      return { applied: [], errors: ['Repaired migration tenant identity changed.'], failureKind: 'infrastructure' };
    }
    const read = await sandbox.runCommand('cat', [expected.file]);
    if (read.exitCode !== 0 || migrationChecksum(await read.stdout()) !== expected.checksum) {
      return { applied: [], errors: [`Repaired migration ${expected.file} is missing or changed after sandbox recovery.`], failureKind: 'infrastructure' };
    }
  }

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
  if (expectedRepairs.some(expected => !files.includes(expected.file))) {
    return { applied: [], errors: ['Repaired migration is absent from the discovered migration batch.'], failureKind: 'infrastructure' };
  }

  if (files.length === 0) {
    return { applied: [], errors: [] };
  }

  const applied: string[] = [];
  const errors: string[] = [];
  let failureKind: 'product' | 'infrastructure' = 'infrastructure';
  let repairTarget: MigrationRepairTarget | undefined;
  let correction: MigrationLifecycleRecord | undefined;
  let context = applicationContext;
  let shouldSyncExposure = false;

  for (const file of files) {
    try {
    if (!/^(?:migrations|supabase\/migrations|src\/db\/migrations)\/[A-Za-z0-9_./-]+\.sql$/.test(file) ||
        file.split('/').some(part => !part || part === '.' || part === '..')) {
      errors.push('Non-canonical migration path rejected.');
      break;
    }
    const canonical = await sandbox.runCommand('realpath', ['--', `/vercel/sandbox/${file}`]);
    if (canonical.exitCode !== 0 || (await canonical.stdout()).trim() !== `/vercel/sandbox/${file}`) {
      errors.push(`Migration ${file} is not a canonical file.`);
      break;
    }
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
      errors.push(`Migration ${file} is empty; do not erase pending or applied SQL to skip validation.`);
      failureKind = 'product';
      break;
    }
    const checksum = migrationChecksum(sql);
    const expectedRepair = expectedRepairs.find(expected => expected.file === file);
    if (expectedRepair && expectedRepair.checksum !== checksum) {
      errors.push(`Repaired migration ${file} changed during validation.`);
      break;
    }

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
        failureKind = 'product';
        errors.push(
          `Migration ${file} changed after it was applied. ` +
          'Restore the exact applied file bytes from a trusted source and verify their SHA-256 against the protected ledger first; the earliest Git commit is not proof of the applied version. ' +
          'Create a new migration for subsequent changes instead of editing applied SQL. Never change the ledger checksum to match the file.',
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

    // Central review applies equally to normal executor writes and repair-tool writes.
    context ||= await loadMigrationApplicationContext(requirementId);
    const target: MigrationRepairTarget = { file, schema, tenantId, checksum, reason: 'lint' };
    const decision = await authorizeMigrationApplication({
      context, target, sql,
      assertUnchanged: async () => {
        const canonical = await sandbox.runCommand('realpath', ['--', `/vercel/sandbox/${file}`]);
        if (canonical.exitCode !== 0 || (await canonical.stdout()).trim() !== `/vercel/sandbox/${file}`) throw new Error('Migration path changed during independent review.');
        const read = await sandbox.runCommand('cat', [file]);
        if (read.exitCode !== 0 || migrationChecksum(await read.stdout()) !== checksum) throw new Error('Migration changed during independent review.');
      },
    });
    if (!decision.allowed) {
      failureKind = 'product';
      correction = decision.lifecycle;
      repairTarget = target;
      errors.push(decision.error || 'Migration requires correction or technical review.');
      break;
    }
    await context.assertCurrent();
    // Defense in depth: review never replaces deterministic lint.
    const lintResult = lintMigration({
      schema,
      tenant_id: tenantId,
      sql
    });

    if (!lintResult.ok) {
      failureKind = 'product';
      repairTarget = { file, schema, tenantId, checksum, reason: 'lint' };
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
      // Syntax/constraint errors require product repair, not infrastructure retries.
      // Unknown/transport/authentication failures remain infrastructure failures.
      if (/^(?:22|23|42)/.test(execError.code || '') && execError.code !== '42501') {
        failureKind = 'product';
        repairTarget = { file, schema, tenantId, checksum, reason: 'sql' };
        correction = await transitionMigrationLifecycle({ requirementId, file,
          expectedVersion: decision.lifecycle.version, executionGeneration: context.executionGeneration,
          value: migrationLifecycleValue(decision.lifecycle, { state: 'correction_required', reason: `Atomic SQL application rolled back (${execError.code}). Correct the tenant migration.` }) });
      }
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
    } catch (error) {
      // Preserve earlier atomic receipts when a later file's review/transport
      // fails. Durable lifecycle intent still blocks unverified delivery.
      failureKind = 'infrastructure';
      errors.push(`Migration ${file} could not complete review/application: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  if (errors.length === 0) {
    for (const expected of expectedRepairs) {
      const { data: receipt, error } = await client.rpc('apps_get_migration_receipt', {
        p_target_schema: schema, p_expected_tenant_id: tenantId,
        p_migration_key: `migration:${expected.file}`,
      });
      if (error || receipt?.found !== true || receipt.value?.checksum !== expected.checksum) {
        errors.push(`Repaired migration ${expected.file} has no matching atomic receipt.`);
        break;
      }
    }
  }

  if (shouldSyncExposure) {
    // Automatically expose schemas to PostgREST to ensure new tables/schemas are visible
    // and reload the schema cache so introspection works immediately.
    const syncResult = await syncPostgrestSchemas();
    if (!syncResult.ok) {
      failureKind = 'infrastructure';
      repairTarget = undefined;
      errors.push(`Failed to sync schemas with Supabase Management API: ${syncResult.error}`);
    }
    const exposeSql = `
      notify pgrst, 'reload config';
      notify pgrst, 'reload schema';
    `;
    const { error: exposeError } = await client.rpc('apps_exec_sql', { sql: exposeSql });
    if (exposeError) {
      failureKind = 'infrastructure';
      repairTarget = undefined;
      errors.push(`Failed to auto-expose schema to PostgREST: ${exposeError.message}`);
    }
  }

  return { applied, errors, ...(errors.length > 0 ? { failureKind } : {}),
    ...(repairTarget ? { repairTarget } : {}), ...(correction ? { correction } : {}) };
}
