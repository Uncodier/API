import { createHash, randomBytes } from 'node:crypto';
import { resolveHandler } from '../handlers';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  executeTenantMigration, loadMigrationExecutionContext, loadMigrationTenantScope,
} from '@/lib/services/apps-platform/migration-execution';
import { authorizeMigrationApplication } from '@/lib/services/apps-platform/migration-application-guard';
import { transitionMigrationLifecycle } from '@/lib/services/apps-platform/migration-lifecycle';

jest.mock('@/lib/services/apps-platform/migration-execution', () => ({
  ...jest.requireActual('@/lib/services/apps-platform/migration-execution'),
  executeTenantMigration: jest.fn(),
  loadMigrationExecutionContext: jest.fn(),
  loadMigrationTenantScope: jest.fn(),
}));
jest.mock('@/lib/services/apps-platform/migration-application-guard', () => ({ authorizeMigrationApplication: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ transitionMigrationLifecycle: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));

const context = {
  site_id: '00000000-0000-4000-8000-000000000001',
  requirement_id: '00000000-0000-4000-8000-000000000002',
  api_key_id: 'key-1',
  scopes: ['db.migrate'],
  test_only: false,
  capability: 'db',
  scope: 'db.migrate',
};
const executionContext = {
  requirementId: context.requirement_id,
  executionGeneration: 1,
  instance: { site_id: context.site_id, user_id: 'user-1', requirement_id: context.requirement_id },
  assertCurrent: jest.fn(),
};
const tenantScope = {
  tenantId: '00000000-0000-4000-8000-000000000003',
  schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa',
};
const sql = 'ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;';
const file = 'platform/20260923_campaigns.sql';

function request(body: Record<string, unknown>) {
  return { json: jest.fn().mockResolvedValue(body) } as any;
}

function migrationHandler() {
  const entry = resolveHandler('POST', ['db', 'migrations']);
  if (!entry) throw new Error('Migration handler is not registered');
  return entry.handler;
}

describe('platform migration handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (loadMigrationExecutionContext as jest.Mock).mockResolvedValue(executionContext);
    (loadMigrationTenantScope as jest.Mock).mockResolvedValue(tenantScope);
    (executeTenantMigration as jest.Mock).mockResolvedValue({ applied: true });
  });

  afterEach(() => {
    // The handler delegates DB authority. No parallel SQL/review/lifecycle path.
    expect(getAppsAdminClient).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(authorizeMigrationApplication).not.toHaveBeenCalled();
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '../escape.sql', 'nested/file.sql', 'bad..sql'])('requires a stable migration name (%s)', async name => {
    const result = await migrationHandler()(request({ name, sql }), context);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('stable migration name');
    expect(loadMigrationExecutionContext).not.toHaveBeenCalled();
    expect(executeTenantMigration).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '  '])('rejects missing SQL (%s)', async invalidSql => {
    const result = await migrationHandler()(request({ name: 'test.sql', sql: invalidSql }), context);
    expect(result.status).toBe(400);
    expect(executeTenantMigration).not.toHaveBeenCalled();
  });

  it('requires a requirement-bound caller before resolving a tenant', async () => {
    const result = await migrationHandler()(request({ name: 'test.sql', sql }), { ...context, requirement_id: null });
    expect(result.status).toBe(403);
    expect(loadMigrationExecutionContext).not.toHaveBeenCalled();
    expect(loadMigrationTenantScope).not.toHaveBeenCalled();
    expect(executeTenantMigration).not.toHaveBeenCalled();
  });

  it.each([
    { instance: { ...executionContext.instance, site_id: 'other-site' } },
    { instance: { ...executionContext.instance, requirement_id: 'other-requirement' } },
    { requirementId: 'other-requirement' },
  ])('validates caller site and requirement even before an existing receipt lookup (%j)', async mismatch => {
    (loadMigrationExecutionContext as jest.Mock).mockResolvedValue({ ...executionContext, ...mismatch });
    (executeTenantMigration as jest.Mock).mockResolvedValue({ applied: false });
    const result = await migrationHandler()(request({ name: 'test.sql', sql }), context);
    expect(result.status).toBe(403);
    expect(loadMigrationTenantScope).not.toHaveBeenCalled();
    expect(executeTenantMigration).not.toHaveBeenCalled();
  });

  it.each(['20260923_campaigns', '20260923_campaigns.sql'])('uses the supplied name as the immutable shared ledger identity (%s)', async name => {
    const result = await migrationHandler()(request({ name, sql }), context);
    expect(result).toMatchObject({ status: 200, body: {
      applied: true, schema: tenantScope.schema, checksum: createHash('sha256').update(sql).digest('hex'), warnings: [],
    } });
    expect(loadMigrationExecutionContext).toHaveBeenCalledWith(context.requirement_id);
    expect(loadMigrationTenantScope).toHaveBeenCalledWith(executionContext);
    expect(executeTenantMigration).toHaveBeenCalledWith({
      context: executionContext, ...tenantScope, migrationKey: `migration:${file}`, sql,
    });
  });

  it('preserves idempotent success without claiming another SQL application', async () => {
    (executeTenantMigration as jest.Mock).mockResolvedValue({ applied: false });
    const result = await migrationHandler()(request({ name: '20260923_campaigns.sql', sql }), context);
    expect(result).toMatchObject({ status: 200, body: { applied: false, schema: tenantScope.schema, warnings: [] } });
  });

  it.each([undefined, null, 'true', 0])('never reports success for a non-boolean applied result (%s)', async applied => {
    (executeTenantMigration as jest.Mock).mockResolvedValueOnce({ applied });
    const result = await migrationHandler()(request({ name: '20260923_campaigns.sql', sql }), context);
    expect(result).toMatchObject({ status: 503, body: { applied: false, failureKind: 'infrastructure',
      diagnostic: { code: 'MIGRATION_INFRASTRUCTURE', message: 'Migration execution returned an invalid application result.' } } });
    expect(result.body).not.toHaveProperty('receipt');
  });

  it.each([
    { code: '42601', kind: 'sql', failureKind: 'product', status: 422, rolled_back: true, repeated: true },
    { code: 'MIGRATION_LINT', kind: 'policy', failureKind: 'product', status: 422 },
    { code: 'APPLIED_MIGRATION_CHANGED', kind: 'history', failureKind: 'product', status: 409 },
    { code: 'PENDING_MIGRATIONS', kind: 'pending', failureKind: 'product', status: 409 },
    { code: 'LEGACY_MIGRATION_HOLD', kind: 'infrastructure', failureKind: 'infrastructure', status: 503 },
    { code: 'MIGRATION_OUTCOME_UNKNOWN', kind: 'infrastructure', failureKind: 'infrastructure', status: 503 },
  ])('returns the shared diagnostic rather than generic RPC unavailable ($code)', async ({ status, failureKind, ...details }) => {
    const diagnostic = { file, message: 'Specific migration failure', ...details };
    const failure = { applied: false, error: diagnostic.message, diagnostic, failureKind };
    (executeTenantMigration as jest.Mock).mockResolvedValue(failure);
    const result = await migrationHandler()(request({ name: '20260923_campaigns.sql', sql }), context);
    expect(result).toMatchObject({ status, body: failure });
    expect(result.body).not.toHaveProperty('receipt');
    expect(result.body).not.toHaveProperty('state');
    expect(result.body.error).not.toContain('RPC not available');
  });

  it('preserves confirmed partial evidence when ownership changes after application', async () => {
    (executeTenantMigration as jest.Mock).mockResolvedValue({ applied: true, error: 'Ownership changed', failureKind: 'infrastructure',
      diagnostic: { file, code: 'MIGRATION_INFRASTRUCTURE', kind: 'infrastructure', message: 'Ownership changed' } });
    const result = await migrationHandler()(request({ name: '20260923_campaigns.sql', sql }), context);
    expect(result).toMatchObject({ status: 503, body: { applied: true, error: 'Ownership changed' } });
    expect(result.body).not.toHaveProperty('receipt');
  });

  it('does not report rollback when schema reload fails after SQL application', async () => {
    const diagnostic = { file, code: 'SCHEMA_RELOAD_PENDING', kind: 'infrastructure', message: 'Schema reload remains pending' };
    (executeTenantMigration as jest.Mock).mockResolvedValueOnce({ applied: true, error: diagnostic.message,
      failureKind: 'infrastructure', diagnostic });
    const result = await migrationHandler()(request({ name: '20260923_campaigns.sql', sql }), context);
    expect(result).toMatchObject({ status: 503, body: { applied: true, diagnostic } });
    expect(result.body).not.toHaveProperty('receipt');
    expect(result.body).not.toHaveProperty('diagnostic.rolled_back');

    (executeTenantMigration as jest.Mock).mockResolvedValueOnce({ applied: false });
    expect(await migrationHandler()(request({ name: '20260923_campaigns.sql', sql }), context))
      .toMatchObject({ status: 200, body: { applied: false, warnings: [] } });
  });

  it('keeps the caller runnable through repeated feedback and a corrected proposal', async () => {
    (executeTenantMigration as jest.Mock).mockResolvedValue({ applied: false, error: 'Correct pending SQL', failureKind: 'product',
      diagnostic: { file, code: '42601', kind: 'sql', message: 'Correct pending SQL', repeated: true, rolled_back: true } });
    for (let attempt = 0; attempt < 7; attempt++) {
      const result = await migrationHandler()(request({ name: '20260923_campaigns.sql', sql }), context);
      expect(result.status).toBe(422);
      expect(result.body).not.toHaveProperty('attempts');
      expect(result.body).not.toHaveProperty('state');
    }
    (executeTenantMigration as jest.Mock).mockResolvedValueOnce({ applied: true });
    expect(await migrationHandler()(request({ name: '20260923_campaigns.sql', sql: `${sql}\n-- corrected` }), context))
      .toMatchObject({ status: 200, body: { applied: true } });
  });

  it.each(['context', 'scope', 'execute'])('reports infrastructure at the actual boundary (%s)', async boundary => {
    const loader = boundary === 'context' ? loadMigrationExecutionContext : boundary === 'scope' ? loadMigrationTenantScope : executeTenantMigration;
    (loader as jest.Mock).mockRejectedValueOnce(new Error(`${boundary} unavailable`));
    const result = await migrationHandler()(request({ name: 'test.sql', sql }), context);
    expect(result).toMatchObject({ status: 503, body: { applied: false, failureKind: 'infrastructure',
      diagnostic: { code: 'MIGRATION_INFRASTRUCTURE', message: `${boundary} unavailable` } } });
    expect(result.body.error).not.toContain('RPC not available');
    if (boundary !== 'execute') expect(executeTenantMigration).not.toHaveBeenCalled();
  });

  it('redacts unexpected authenticated URL errors without dropping the diagnostic', async () => {
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/migration');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    (loadMigrationTenantScope as jest.Mock).mockRejectedValueOnce(new Error(`Tenant connection unavailable: ${url}`));
    const result = await migrationHandler()(request({ name: 'test.sql', sql }), context);
    expect(result).toMatchObject({ status: 503, body: { diagnostic: { kind: 'infrastructure' } } });
    for (const sensitive of [username, password, token]) expect(JSON.stringify(result)).not.toContain(sensitive);
  });
});