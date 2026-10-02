import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { sanitizeMigrationRepairContext } from './migration-repair-policy';

export interface MigrationDiagnostic {
  file?: string;
  code: string;
  message: string;
  kind: 'sql' | 'policy' | 'infrastructure' | 'history' | 'pending';
  repeated?: boolean;
  rolled_back?: boolean;
}

export interface MigrationScope { schema: string; tenantId: string; capabilityFingerprint?: string }
export interface MigrationFeedback {
  migration_key: string;
  checksum: string;
  context_key: string;
  error: MigrationDiagnostic | null;
}
export interface MigrationWorkspace {
  schema_fingerprint: string;
  files: MigrationFeedback[];
  receipts: Array<{ migration_key: string; value: unknown }>;
}

export const validMigrationChecksum = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const canonicalMigrationFile = (file: string, platform = true): boolean =>
  file.length <= 512 && new RegExp(`^(?:migrations|supabase/migrations|src/db/migrations${platform ? '|platform' : ''})/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.sql$`).test(file);

function bounded(text: string, bytes: number): string {
  // Redact before truncation: a truncated credential would evade the redactor.
  const safe = sanitizeMigrationRepairContext(text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, value => {
      try {
        const url = new URL(value);
        if (url.username || url.password) { url.username = 'REDACTED'; url.password = 'REDACTED'; }
        for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, 'REDACTED');
        return url.toString();
      } catch { return '[REDACTED_URL]'; }
    })
    .replace(/(\b[\w]*(?:token|password|secret|api_key|service_key|service_role_key)[\w]*\s*[:=]\s*)(?![\s'"`\[])[^\s,;]+/gi, '$1[REDACTED]');
  return Buffer.from(safe).subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '');
}

/** Only these bounded fields cross the Apps journal boundary; never SQL or RPC objects. */
export function safeMigrationDiagnostic(input: MigrationDiagnostic): MigrationDiagnostic {
  const result: MigrationDiagnostic = {
    ...(input.file && canonicalMigrationFile(input.file) ? { file: input.file } : {}),
    code: bounded(input.code, 80), message: bounded(input.message, 1400), kind: input.kind,
    ...(input.repeated === true ? { repeated: true } : {}),
    ...(input.rolled_back === true ? { rolled_back: true } : {}),
  };
  // JSON escapes can expand otherwise bounded control characters sixfold.
  while (Buffer.byteLength(JSON.stringify(result)) > 3900) result.message = result.message.slice(0, Math.floor(result.message.length * 0.8));
  return result;
}

function parseDiagnostic(value: unknown): MigrationDiagnostic | null {
  if (value === null) return null;
  const item = value as MigrationDiagnostic;
  if (!item || typeof item !== 'object' || typeof item.code !== 'string' || !item.code ||
      typeof item.message !== 'string' || !['sql', 'policy', 'infrastructure', 'history', 'pending'].includes(item.kind) ||
      Buffer.byteLength(JSON.stringify(value)) > 4096) throw new Error('Invalid migration feedback diagnostic.');
  return safeMigrationDiagnostic(item);
}

export function migrationReceiptChecksum(value: unknown): string | undefined {
  const checksum = value && typeof value === 'object' ? (value as { checksum?: unknown }).checksum : undefined;
  return validMigrationChecksum(checksum) ? checksum : undefined;
}

export async function getMigrationWorkspace(scope: MigrationScope): Promise<MigrationWorkspace> {
  const { data, error } = await getAppsAdminClient().rpc('apps_get_migration_workspace', {
    p_target_schema: scope.schema, p_expected_tenant_id: scope.tenantId,
  });
  if (error) throw new Error('Migration workspace is unavailable.');
  if (!data || typeof data !== 'object' || !/^[a-f0-9]{32}$/.test(data.schema_fingerprint) ||
      !Array.isArray(data.files) || !Array.isArray(data.receipts)) throw new Error('Invalid migration workspace.');
  const keys = new Set<string>();
  const files = data.files.map((row: MigrationFeedback) => {
    if (!row || typeof row.migration_key !== 'string' || !row.migration_key.startsWith('migration:') ||
        !canonicalMigrationFile(row.migration_key.slice(10)) || keys.has(row.migration_key) ||
        !validMigrationChecksum(row.checksum) || typeof row.context_key !== 'string' ||
        !row.context_key || Buffer.byteLength(row.context_key) > 256) throw new Error('Invalid migration workspace file.');
    keys.add(row.migration_key);
    return { migration_key: row.migration_key, checksum: row.checksum, context_key: row.context_key, error: parseDiagnostic(row.error) };
  });
  keys.clear();
  const receipts = data.receipts.map((row: MigrationWorkspace['receipts'][number]) => {
    if (!row || typeof row.migration_key !== 'string' || !row.migration_key.startsWith('migration:') ||
        keys.has(row.migration_key) || !Object.prototype.hasOwnProperty.call(row, 'value')) throw new Error('Invalid migration workspace receipt.');
    keys.add(row.migration_key);
    return { migration_key: row.migration_key, value: row.value };
  });
  return { schema_fingerprint: data.schema_fingerprint, files, receipts };
}

export async function recordMigrationFeedback(scope: MigrationScope, proposal: MigrationFeedback): Promise<void> {
  const error = proposal.error ? safeMigrationDiagnostic(proposal.error) : null;
  const response = await getAppsAdminClient().rpc('apps_record_migration_feedback', {
    p_target_schema: scope.schema, p_expected_tenant_id: scope.tenantId,
    p_migration_key: proposal.migration_key, p_migration_checksum: proposal.checksum,
    p_context_key: proposal.context_key, p_error: error,
  });
  const row = response.data;
  if (response.error || !row || row.target_schema !== scope.schema || row.tenant_id !== scope.tenantId ||
      row.migration_key !== proposal.migration_key || row.checksum !== proposal.checksum ||
      row.context_key !== proposal.context_key || JSON.stringify(parseDiagnostic(row.error)) !== JSON.stringify(error)) {
    throw new Error('Migration feedback could not be durably recorded.');
  }
}