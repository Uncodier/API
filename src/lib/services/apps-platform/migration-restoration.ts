import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Sandbox } from '@vercel/sandbox';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import archives from './migration-restoration-archives.json';
import { FIND_APPLIED_MIGRATION, RESTORE_APPLIED_MIGRATION, VERIFY_APPLIED_MIGRATIONS } from './migration-restoration-scripts';

const ROOT = '/vercel/sandbox';
const MAX_BYTES = 64 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const validChecksum = (value: string) => /^[a-f0-9]{64}$/.test(value);
const validFile = (file: string) => /^(?:migrations|supabase\/migrations|src\/db\/migrations)\/[A-Za-z0-9_./-]+\.sql$/.test(file) &&
  !file.split('/').some(part => !part || part.startsWith('.'));

/** File recovery evidence, NOT an SQL application or authorization receipt. */
export interface MigrationFileRestoration {
  file: string;
  schema: string;
  tenantId: string;
  checksum: string;
  previousChecksum: string;
  source: { kind: 'git' | 'platform_archive'; revision: string };
  /** Private sandbox-local preimage; not a durable artifact or a migration. */
  backupPath: string;
}

export interface MigrationRestorationFailure {
  file: string;
  expectedChecksum: string;
  actualChecksum: string;
  reason: string;
  writeAttempted: boolean;
}

function matchingBytes(bytes: Buffer, checksum: string): boolean {
  // The applier consumes UTF-8. Never accept replacement-character normalization.
  return bytes.length > 0 && bytes.length <= MAX_BYTES &&
    Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) && digest(bytes) === checksum;
}

async function archivedCandidate(requirementId: string, schema: string, file: string, checksum: string) {
  const entry = archives.find(item => item.requirementId === requirementId && item.schema === schema && item.file === file);
  if (!entry) return null;
  const path = resolve(process.cwd(), entry.archive);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_BYTES || await realpath(path) !== path) return null;
    const bytes = await readFile(path);
    return matchingBytes(bytes, checksum) ? { bytes, source: { kind: 'platform_archive' as const, revision: entry.archive } } : null;
  } catch {
    // An absent packaged recovery copy cannot authorize reconstruction. Try Git.
    return null;
  }
}

/** Read-only attestation also used immediately before each actual Git push. */
export async function verifyMigrationRestorations(
  sandbox: Sandbox, entries: MigrationFileRestoration[], committed = false,
): Promise<void> {
  if (!entries.length) return;
  if (entries.some(entry => !validFile(entry.file) || !validChecksum(entry.checksum))) {
    throw new Error('Invalid migration restoration receipt.');
  }
  const expected = new Map<string, string>();
  for (const entry of entries) {
    if (expected.has(entry.file) && expected.get(entry.file) !== entry.checksum) throw new Error('Conflicting migration restoration receipts.');
    expected.set(entry.file, entry.checksum);
  }
  const result = await sandbox.runCommand({ cmd: 'node', args: ['-e', VERIFY_APPLIED_MIGRATIONS,
    JSON.stringify({ root: ROOT, entries: Array.from(expected, ([file, checksum]) => ({ file, checksum })), committed, maxBytes: MAX_BYTES })],
    cwd: ROOT, timeoutMs: 15000 });
  if (result.exitCode !== 0 || (await result.stdout()).trim() !== 'verified') {
    throw new Error('Restored migration bytes are missing or changed in the workspace or commit.');
  }
}

/** Gate-owned recovery only. The caller must supply its original execution owner. */
export async function restoreAppliedMigration(params: {
  sandbox: Sandbox;
  requirementId: string;
  file: string;
  schema: string;
  tenantId: string;
  expectedChecksum: string;
  actualChecksum: string;
  assertCurrent: () => Promise<void>;
}): Promise<
  | { restored: MigrationFileRestoration }
  | { failure: MigrationRestorationFailure; failureKind: 'product' | 'infrastructure' }
> {
  const { sandbox, requirementId, file, schema, tenantId, expectedChecksum, actualChecksum, assertCurrent } = params;
  let writeAttempted = false;
  const fail = (reason: string, failureKind: 'product' | 'infrastructure' = 'infrastructure') => ({
    failure: { file, expectedChecksum, actualChecksum, reason, writeAttempted }, failureKind,
  });
  if (!validFile(file) || !/^app_[a-f0-9]{24}$/.test(schema) ||
      !validChecksum(expectedChecksum) || !validChecksum(actualChecksum) || actualChecksum === expectedChecksum) {
    return fail('invalid_restoration_identity', 'product');
  }
  const assertReceipt = async () => {
    await assertCurrent();
    const client = getAppsAdminClient();
    const { data: tenant, error: tenantError } = await client.from('apps_tenants')
      .select('tenant_id, schema').eq('requirement_id', requirementId).maybeSingle();
    if (tenantError || tenant?.schema !== schema || tenant?.tenant_id !== tenantId) throw new Error('Tenant changed.');
    const { data: receipt, error } = await client.rpc('apps_get_migration_receipt', {
      p_target_schema: schema, p_expected_tenant_id: tenantId, p_migration_key: `migration:${file}`,
    });
    if (error || receipt?.found !== true || receipt.value?.checksum !== expectedChecksum) throw new Error('Ledger changed.');
  };
  try {
    await assertReceipt();
    let candidate: { bytes: Buffer; source: MigrationFileRestoration['source'] } | null =
      await archivedCandidate(requirementId, schema, file, expectedChecksum);
    if (!candidate) {
      const result = await sandbox.runCommand({ cmd: 'node', args: ['-e', FIND_APPLIED_MIGRATION,
        JSON.stringify({ root: ROOT, file, checksum: expectedChecksum, maxBytes: MAX_BYTES })], cwd: ROOT, timeoutMs: 12000 });
      if (result.exitCode !== 0) return fail('history_search_unavailable');
      const output = await result.stdout();
      if (output.length > MAX_BYTES * 2) return fail('invalid_history_result');
      const found = JSON.parse(output);
      if (typeof found.revision === 'string' && /^[a-f0-9]{40,64}$/.test(found.revision) && typeof found.content === 'string') {
        const bytes = Buffer.from(found.content, 'base64');
        if (matchingBytes(bytes, expectedChecksum)) candidate = { bytes, source: { kind: 'git', revision: found.revision } };
      }
      if (!candidate) return fail(found.unavailable ? 'history_search_unavailable' : 'no_matching_applied_source',
        found.unavailable ? 'infrastructure' : 'product');
    }
    // Discovery is asynchronous: revalidate the original lease, registry and ledger.
    await assertReceipt();
    await assertCurrent();
    writeAttempted = true;
    const result = await sandbox.runCommand({ cmd: 'node', args: ['-e', RESTORE_APPLIED_MIGRATION,
      JSON.stringify({ root: ROOT, file, checksum: expectedChecksum, previousChecksum: actualChecksum,
        content: candidate.bytes.toString('base64'), maxBytes: MAX_BYTES })], cwd: ROOT, timeoutMs: 5000 });
    const output = await result.stdout();
    if (output.length > 4096) return fail('restoration_unverified');
    const receipt = JSON.parse(output);
    if (result.exitCode !== 0 || receipt.restored !== true || typeof receipt.backupPath !== 'string' ||
        !new RegExp(`^/tmp/apps-migration-restoration-[A-Za-z0-9]+/${actualChecksum}\\.sql$`).test(receipt.backupPath)) {
      return fail('restoration_unverified');
    }
    const restored: MigrationFileRestoration = { file, schema, tenantId, checksum: expectedChecksum,
      previousChecksum: actualChecksum, source: candidate.source, backupPath: receipt.backupPath };
    await assertReceipt();
    await verifyMigrationRestorations(sandbox, [restored]);
    return { restored };
  } catch {
    // Transport failures may follow a successful rename: never retry blindly in this gate.
    // Do not include command output, original SQL or arbitrary filesystem errors in logs.
    return fail(writeAttempted ? 'restoration_unverified' : 'restoration_context_unavailable');
  }
}