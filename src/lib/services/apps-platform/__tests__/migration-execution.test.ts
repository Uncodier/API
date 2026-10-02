import { randomBytes } from 'node:crypto';
import {
  executeTenantMigration, loadMigrationExecutionContext, migrationDigest, migrationPolicyDiagnostic,
  type MigrationExecutionContext,
} from '../migration-execution';
import { safeMigrationDiagnostic } from '../migration-feedback';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { listMigrationLifecycle } from '../migration-lifecycle';

jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../migration-lifecycle', () => ({ listMigrationLifecycle: jest.fn() }));
jest.mock('../migration-application-guard', () => { throw new Error('Legacy review dependency is forbidden'); });
jest.mock('../migration-security-review', () => { throw new Error('Model review dependency is forbidden'); });

const requirementId = '12345678-1234-1234-1234-123456789012';
const tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const schema = 'app_aaaaaaaaaaaaaaaaaaaaaaaa';
const migrationKey = 'migration:platform/test.sql';
const sql = 'ALTER TABLE records ENABLE ROW LEVEL SECURITY;';
function harness() {
  const context: MigrationExecutionContext = { requirementId, executionGeneration: 1,
    instance: { requirement_id: requirementId, site_id: 'site', user_id: 'user' }, assertCurrent: jest.fn(async () => undefined) };
  const tenant = { tenant_id: tenantId, schema, site_id: 'site', user_id: 'user', status: 'active' };
  const capability: any = { version: 1, requirement_id: requirementId, tenant_id: tenantId, schema,
    identity: { user_id: `${schema}._app_current_user_id`, claims: `${schema}._app_request_claims`, backend: `${schema}._app_is_backend_request` },
    storage: { available: false, bucket: null }, backend: { role: 'authenticated', bypasses_rls: false, operations: [] } };
  const workspace: any = { schema_fingerprint: 'a'.repeat(32), files: [], receipts: [] };
  let execute: (args: any) => any = args => {
    workspace.receipts.push({ migration_key: args.p_migration_key, value: { checksum: args.p_migration_checksum } });
    return { data: true, error: null };
  };
  const rpc = jest.fn(async (name: string, args: any) => {
    if (name === 'apps_get_tenant_capabilities') return { data: capability, error: null };
    if (name === 'apps_get_migration_workspace') return { data: workspace, error: null };
    if (name === 'apps_record_migration_feedback') {
      const row = { migration_key: args.p_migration_key, checksum: args.p_migration_checksum, context_key: args.p_context_key, error: args.p_error };
      workspace.files = [...workspace.files.filter((prior: any) => prior.migration_key !== row.migration_key), row];
      return { data: { ...row, target_schema: schema, tenant_id: tenantId }, error: null };
    }
    if (name === 'apps_apply_migration') return execute(args);
    if (name === 'apps_reload_migration_schema') return { data: null, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  (getAppsAdminClient as jest.Mock).mockReturnValue({ rpc,
    from: jest.fn(() => ({ select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(async () => ({ data: tenant, error: null })) })) })) })),
  });
  return { context, tenant, capability, workspace, rpc,
    setExecute: (fn: typeof execute) => { execute = fn; },
    run: (proposed = sql) => executeTenantMigration({ context, schema, tenantId, migrationKey, sql: proposed }),
    calls: () => rpc.mock.calls.filter(call => call[0] === 'apps_apply_migration'),
  };
}

beforeEach(() => { jest.clearAllMocks(); (listMigrationLifecycle as jest.Mock).mockResolvedValue([]); });

describe('deterministic policy boundary', () => {
  it.each([
    'DROP TABLE records;', 'DELETE FROM records;', 'UPDATE records SET owner_id = null;',
    'TRUNCATE records;', 'WITH changed AS (DELETE FROM records RETURNING *) SELECT * FROM changed;',
    'INSERT INTO records(id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2;',
    'GRANT ALL ON records TO authenticated;', 'SET ROLE service_role;',
    'ALTER TABLE public.users ADD COLUMN note text;',
    'ALTER TABLE records DISABLE ROW LEVEL SECURITY;',
    'CREATE POLICY access ON records TO authenticated USING (true);',
    'CREATE OR REPLACE FUNCTION _app_current_user_id() RETURNS text LANGUAGE sql AS $$ SELECT null $$;',
  ])('rejects unsafe SQL without LLM permission: %s', proposed => {
    expect(migrationPolicyDiagnostic(proposed, { schema, tenantId }, 'platform/test.sql')).toMatchObject({ kind: 'policy' });
  });

  it('preserves static owner-scoped, non-destructive policies including idempotent recreation', () => {
    const proposed = `DROP POLICY IF EXISTS access ON records;
      CREATE POLICY access ON records TO authenticated USING (owner_id = ${schema}._app_current_user_id());`;
    expect(migrationPolicyDiagnostic(proposed, { schema, tenantId }, 'platform/test.sql')).toBeUndefined();
  });

  it('does not broaden standalone policy deletion into an allowed rewrite', () => {
    expect(migrationPolicyDiagnostic('DROP POLICY access ON records;', { schema, tenantId }, 'platform/test.sql')).toMatchObject({ code: 'MIGRATION_POLICY' });
  });
});

describe('single deterministic atomic execution', () => {
  it('applies through the restricted RPC and requires an exact receipt', async () => {
    const state = harness();
    expect(await state.run()).toEqual({ applied: true });
    expect(state.calls()).toHaveLength(1);
    expect(state.calls()[0][1]).toMatchObject({ p_target_schema: schema, p_expected_tenant_id: tenantId,
      p_migration_key: migrationKey, p_migration_checksum: migrationDigest(sql), p_migration_sql: sql });
    expect(state.rpc).toHaveBeenCalledWith('apps_reload_migration_schema', {
      p_target_schema: schema, p_expected_tenant_id: tenantId,
    });
  });

  it.each(['rpc', 'transport'])('preserves committed receipt on %s reload failure and retries reload without SQL', async failure => {
    const state = harness();
    const original = state.rpc.getMockImplementation()!;
    let failReload = true;
    state.rpc.mockImplementation(async (name, args) => {
      if (name === 'apps_reload_migration_schema' && failReload) {
        if (failure === 'transport') throw new Error('reload transport unavailable');
        return { data: null, error: { code: '42501', message: 'reload unavailable' } };
      }
      return original(name, args);
    });
    const failed = await state.run();
    expect(failed).toMatchObject({ applied: true, failureKind: 'infrastructure',
      diagnostic: { code: 'SCHEMA_RELOAD_PENDING', kind: 'infrastructure' } });
    expect(failed.diagnostic?.rolled_back).toBeUndefined();
    expect(state.workspace.receipts).toEqual([{ migration_key: migrationKey, value: { checksum: migrationDigest(sql) } }]);
    expect(state.workspace.files[0].error).toBeNull();
    failReload = false;
    expect(await state.run()).toEqual({ applied: false });
    expect(state.calls()).toHaveLength(1);
    expect(state.rpc.mock.calls.filter(call => call[0] === 'apps_reload_migration_schema')).toHaveLength(2);
  });

  it('rejects a supplied context with mismatched requirement identity before any RPC', async () => {
    const state = harness();
    state.context.instance.requirement_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await state.run()).toMatchObject({ applied: false, failureKind: 'infrastructure', error: 'Migration requirement identity changed.' });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('returns cached deterministic failure without SQL and invalidates on changed schema context', async () => {
    const state = harness();
    state.setExecute(() => ({ data: null, error: { code: '42601', message: 'syntax error near token' } }));
    expect(await state.run()).toMatchObject({ diagnostic: { code: '42601', rolled_back: true } });
    expect(await state.run()).toMatchObject({ diagnostic: { code: '42601', repeated: true } });
    expect(state.calls()).toHaveLength(1);
    state.workspace.schema_fingerprint = 'b'.repeat(32);
    expect(await state.run()).toMatchObject({ diagnostic: { code: '42601' } });
    expect(state.calls()).toHaveLength(2);
  });

  it('allows changed proposals and does not canonicalize SQL/checksums', async () => {
    const state = harness();
    state.setExecute(() => ({ data: null, error: { code: '42601', message: 'syntax error' } }));
    await state.run();
    await state.run(`${sql}\n-- changed bytes`);
    expect(state.calls()).toHaveLength(2);
  });

  it.each(['23505', '42501', '42P01'])('does not negative-cache dynamic data/permission/catalog error %s', async code => {
    const state = harness();
    state.setExecute(() => ({ data: null, error: { code, message: 'database rejected migration' } }));
    const result = await state.run();
    expect(result).toMatchObject({ failureKind: code === '42501' ? 'infrastructure' : 'product', diagnostic: { code, rolled_back: true } });
    expect(await state.run()).not.toMatchObject({ diagnostic: { repeated: true } });
    expect(state.calls()).toHaveLength(2);
  });

  it('reconciles lost response by exact receipt without replaying SQL', async () => {
    const state = harness();
    state.setExecute(args => {
      state.workspace.receipts.push({ migration_key: args.p_migration_key, value: { checksum: args.p_migration_checksum } });
      throw new Error('lost response');
    });
    expect(await state.run()).toEqual({ applied: true });
    expect(state.calls()).toHaveLength(1);
  });

  it('does not call transport or missing receipts a rollback/success', async () => {
    const state = harness();
    state.setExecute(() => { throw new Error('transport'); });
    expect(await state.run()).toMatchObject({ applied: false, failureKind: 'infrastructure', diagnostic: { code: 'MIGRATION_OUTCOME_UNKNOWN' } });
    expect(state.workspace.files[0].error.rolled_back).toBeUndefined();
    expect(state.calls()).toHaveLength(1);
  });

  it('does not accept true or false RPC responses without exact durable receipts', async () => {
    const state = harness();
    state.setExecute(() => ({ data: true, error: null }));
    expect(await state.run()).toMatchObject({ applied: false, failureKind: 'infrastructure' });
    state.setExecute(() => ({ data: false, error: null }));
    expect(await state.run()).toMatchObject({ applied: false, failureKind: 'infrastructure' });
  });

  it('preserves a confirmed atomic application when generation ownership is lost afterward', async () => {
    const state = harness();
    state.setExecute(args => {
      state.workspace.receipts.push({ migration_key: args.p_migration_key, value: { checksum: args.p_migration_checksum } });
      (state.context.assertCurrent as jest.Mock).mockRejectedValue(new Error('lease changed'));
      return { data: true, error: null };
    });
    expect(await state.run()).toMatchObject({ applied: true, failureKind: 'infrastructure' });
  });

  it('rejects changed and renamed applied history without touching SQL', async () => {
    const state = harness();
    state.workspace.receipts.push({ migration_key: migrationKey, value: { checksum: 'c'.repeat(64) } });
    expect(await state.run()).toMatchObject({ diagnostic: { code: 'APPLIED_MIGRATION_CHANGED' } });
    state.workspace.receipts = [{ migration_key: 'migration:platform/original.sql', value: { checksum: migrationDigest(sql) } }];
    expect(await state.run()).toMatchObject({ diagnostic: { code: 'RENAMED_APPLIED_MIGRATION' } });
    expect(state.calls()).toHaveLength(0);
  });

  it('fails closed on tenant scope change or invalid helper capability', async () => {
    const state = harness();
    state.tenant.site_id = 'other';
    expect(await state.run()).toMatchObject({ failureKind: 'infrastructure' });
    state.tenant.site_id = 'site';
    state.capability.identity.user_id = 'public.foreign_helper';
    expect(await state.run()).toMatchObject({ failureKind: 'infrastructure' });
    expect(state.calls()).toHaveLength(0);
  });

  it('sanitizes SQL diagnostics before returning or durable journaling', async () => {
    const state = harness();
    const token = randomBytes(24).toString('hex');
    const password = randomBytes(24).toString('hex');
    const url = new URL('https://database.example.test/query');
    url.username = 'synthetic'; url.password = password; url.searchParams.set('access_token', token);
    state.setExecute(() => ({ data: null, error: { code: '23505', message: `Bearer ${token} ${url.toString()} password='${password}' ${'x'.repeat(12000)}` } }));
    const result = await state.run();
    const diagnostic = JSON.stringify(result.diagnostic);
    expect(diagnostic).not.toContain(token);
    expect(diagnostic).not.toContain(password);
    expect(JSON.stringify(state.workspace.files[0].error)).toBe(diagnostic);
    expect(Buffer.byteLength(diagnostic)).toBeLessThan(4096);
  });

  it('bounds escaped control characters below the SQL JSON diagnostic limit', () => {
    const result = safeMigrationDiagnostic({ code: 'test', kind: 'sql', message: '\u0001'.repeat(6000) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
  });
});

describe('execution context', () => {
  it('selects no instructions/specification hash and fences status, generation, site and owner', async () => {
    const row = { id: requirementId, site_id: 'site', user_id: 'user', status: 'in-progress', metadata: { requirement_execution_generation: 1 } };
    const select = jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(async () => ({ data: row, error: null })) })) }));
    (supabaseAdmin.from as jest.Mock).mockReturnValue({ select });
    const owner = jest.fn(async () => undefined);
    const context = await loadMigrationExecutionContext(requirementId, owner);
    expect(select).toHaveBeenCalledWith('id,site_id,user_id,status,metadata');
    expect(context).not.toHaveProperty('specification');
    expect(owner).toHaveBeenCalled();
    row.metadata = { requirement_execution_generation: 2 };
    await expect(context.assertCurrent()).rejects.toThrow('ownership changed');
  });
});