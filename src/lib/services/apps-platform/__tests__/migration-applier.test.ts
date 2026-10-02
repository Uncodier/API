import { applyPendingMigrations, verifyPendingMigrations } from '../migration-applier';
import { migrationDigest, type MigrationExecutionContext } from '../migration-execution';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { listMigrationLifecycle, transitionMigrationLifecycle } from '../migration-lifecycle';
import { restoreAppliedMigration, verifyMigrationRestorations } from '../migration-restoration';

jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../migration-lifecycle', () => ({ listMigrationLifecycle: jest.fn(), transitionMigrationLifecycle: jest.fn() }));
jest.mock('../migration-restoration', () => ({ restoreAppliedMigration: jest.fn(), verifyMigrationRestorations: jest.fn() }));
jest.mock('../migration-application-guard', () => { throw new Error('Normal path must not load LLM review'); });
jest.mock('../postgrest-config', () => { throw new Error('Normal path must not load Management API'); });

const requirementId = '12345678-1234-1234-1234-123456789012';
const schema = 'app_aaaaaaaaaaaaaaaaaaaaaaaa';
const tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const file = 'supabase/migrations/001_records.sql';
const sql = 'ALTER TABLE records ENABLE ROW LEVEL SECURITY;';
const second = 'migrations/002_records.sql';
const secondSql = 'ALTER TABLE records ADD COLUMN title text;';
const context = (): MigrationExecutionContext => ({ requirementId, executionGeneration: 1,
  instance: { requirement_id: requirementId, site_id: 'site', user_id: 'user' }, assertCurrent: jest.fn(async () => undefined) });

function setup(initial: Record<string, string> = { [file]: sql }) {
  const files = { ...initial };
  let tracked: string[] = [];
  let committed: string[] = [];
  let fingerprint = 'a'.repeat(32);
  const feedback = new Map<string, any>();
  const receipts = new Map<string, any>();
  let apply: (args: any) => any = args => {
    receipts.set(args.p_migration_key, { checksum: args.p_migration_checksum });
    return { data: true, error: null };
  };
  const db = {
    from: jest.fn(() => ({ select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(async () => ({
      data: { tenant_id: tenantId, schema, site_id: 'site', user_id: 'user', status: 'active' }, error: null,
    })) })) })) })),
    rpc: jest.fn(async (name: string, args: any) => {
      if (name === 'apps_get_tenant_capabilities') return { data: {
        version: 1, requirement_id: requirementId, tenant_id: tenantId, schema,
        identity: { user_id: `${schema}._app_current_user_id`, claims: `${schema}._app_request_claims`, backend: `${schema}._app_is_backend_request` },
        storage: { available: false, bucket: null }, backend: { role: 'authenticated', bypasses_rls: false, operations: [] },
      }, error: null };
      if (name === 'apps_get_migration_workspace') return { data: {
        schema_fingerprint: fingerprint, files: Array.from(feedback.values()),
        receipts: Array.from(receipts, ([migration_key, value]) => ({ migration_key, value })),
      }, error: null };
      if (name === 'apps_record_migration_feedback') {
        const row = { target_schema: schema, tenant_id: tenantId, migration_key: args.p_migration_key,
          checksum: args.p_migration_checksum, context_key: args.p_context_key, error: args.p_error, updated_at: '2026-10-02T00:00:00Z' };
        feedback.set(row.migration_key, row);
        return { data: row, error: null };
      }
      if (name === 'apps_apply_migration') return apply(args);
      if (name === 'apps_reload_migration_schema') return { data: null, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    }),
  };
  const sandbox = { runCommand: jest.fn(async (command: string, args: string[]) => {
    const output = command === 'sh' ? Object.keys(files).join('\n') : command === 'git'
      ? args[0] === 'rev-parse' ? 'a'.repeat(40) : args[0] === 'ls-tree' ? committed.join('\0') : tracked.join('\0') :
      command === 'realpath' ? args[1] : files[args[0]];
    return { exitCode: output === undefined ? 1 : 0, stdout: async () => output || '', stderr: async () => '' };
  }) } as any;
  (getAppsAdminClient as jest.Mock).mockReturnValue(db);
  return { db, files, feedback, receipts, sandbox,
    setTracked: (paths: string[]) => { tracked = paths; },
    setCommitted: (paths: string[]) => { committed = paths; },
    setFingerprint: (value: string) => { fingerprint = value; },
    setApply: (fn: typeof apply) => { apply = fn; },
    applications: () => db.rpc.mock.calls.filter(call => call[0] === 'apps_apply_migration'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (listMigrationLifecycle as jest.Mock).mockResolvedValue([]);
  (supabaseAdmin.from as jest.Mock).mockReturnValue({ select: jest.fn(() => ({ eq: jest.fn(() => ({
    maybeSingle: jest.fn(async () => ({ data: { id: requirementId, site_id: 'site', user_id: 'user', status: 'in-progress',
      metadata: { requirement_execution_generation: 1 } }, error: null })),
  })) })) });
  (verifyMigrationRestorations as jest.Mock).mockResolvedValue(undefined);
});

describe('deterministic migration batch', () => {
  it('registers every pending file before first SQL and uses only protected atomic writes', async () => {
    const state = setup({ [file]: sql, [second]: secondSql });
    const result = await applyPendingMigrations(state.sandbox, requirementId);
    expect(result).toEqual({ applied: [second, file], errors: [] });
    const calls = state.db.rpc.mock.calls;
    const firstApply = calls.findIndex(call => call[0] === 'apps_apply_migration');
    const registered = calls.slice(0, firstApply).filter(call => call[0] === 'apps_record_migration_feedback').map(call => call[1].p_migration_key);
    expect(registered).toEqual(expect.arrayContaining([`migration:${file}`, `migration:${second}`]));
    expect(state.applications()).toHaveLength(2);
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
    expect(calls.every(call => ['apps_get_tenant_capabilities', 'apps_get_migration_workspace', 'apps_record_migration_feedback', 'apps_apply_migration', 'apps_reload_migration_schema'].includes(call[0]))).toBe(true);
  });

  it('skips exact applied history even if SQL would fail current policy', async () => {
    const state = setup({ [file]: 'DROP TABLE records;' });
    state.receipts.set(`migration:${file}`, { checksum: migrationDigest(state.files[file]) });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [], errors: [] });
    expect(state.applications()).toHaveLength(0);
    expect(state.feedback.size).toBe(0);
  });

  it('retains applied file on reload failure and the next batch retries reload only', async () => {
    const state = setup();
    const original = state.db.rpc.getMockImplementation()!;
    let failReload = true;
    state.db.rpc.mockImplementation(async (name, args) => name === 'apps_reload_migration_schema' && failReload
      ? { data: null, error: { message: 'schema reload unavailable' } }
      : original(name, args));
    const result = await applyPendingMigrations(state.sandbox, requirementId);
    expect(result).toMatchObject({ applied: [file], pending: [], failureKind: 'infrastructure',
      diagnostic: { code: 'SCHEMA_RELOAD_PENDING' } });
    expect(result.diagnostic?.rolled_back).toBeUndefined();
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [], errors: [] });
    failReload = false;
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [], errors: [] });
    expect(state.applications()).toHaveLength(1);
    expect(state.db.rpc.mock.calls.filter(call => call[0] === 'apps_reload_migration_schema')).toHaveLength(2);
  });

  it('requests a single scope reload for an entirely applied historical batch', async () => {
    const state = setup({ [file]: sql, [second]: secondSql });
    state.receipts.set(`migration:${file}`, { checksum: migrationDigest(sql) });
    state.receipts.set(`migration:${second}`, { checksum: migrationDigest(secondSql) });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [], errors: [] });
    expect(state.applications()).toHaveLength(0);
    expect(state.db.rpc.mock.calls.filter(call => call[0] === 'apps_reload_migration_schema')).toHaveLength(1);
  });

  it('refuses changed applied bytes without backfilling the checksum', async () => {
    const state = setup();
    state.receipts.set(`migration:${file}`, { checksum: 'a'.repeat(64) });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({
      applied: [], failureKind: 'product', diagnostic: { code: 'APPLIED_MIGRATION_CHANGED', kind: 'history' },
    });
    expect(state.applications()).toHaveLength(0);
    expect(restoreAppliedMigration).not.toHaveBeenCalled();
  });

  it('refuses receipts without a checksum instead of guessing/backfilling history', async () => {
    const state = setup();
    state.receipts.set(`migration:${file}`, { applied_at: '2026-10-02' });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({
      failureKind: 'infrastructure', diagnostic: { code: 'LEGACY_MIGRATION_CHECKSUM' },
    });
    expect(state.applications()).toHaveLength(0);
  });

  it.each(['journal', 'receipt', 'git'])('does not pass when a %s-observed file disappears', async source => {
    const state = setup({});
    if (source === 'journal') state.feedback.set(`migration:${file}`, { migration_key: `migration:${file}`, checksum: migrationDigest(sql), context_key: 'context', error: null });
    if (source === 'receipt') state.receipts.set(`migration:${file}`, { checksum: migrationDigest(sql) });
    if (source === 'git') state.setTracked([file]);
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ failureKind: 'product', diagnostic: { code: 'MISSING_MIGRATION' } });
    expect(state.applications()).toHaveLength(0);
  });

  it('refuses committed migration deleted from both the working tree and index before first observation', async () => {
    const state = setup({});
    state.setCommitted([file]);
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({
      failureKind: 'product', diagnostic: { code: 'MISSING_MIGRATION' },
    });
    expect(state.feedback.size).toBe(0);
    expect(state.applications()).toHaveLength(0);
  });

  it.each([true, false])('accepts missing HEAD only when the repository is explicitly unborn (%s)', async unborn => {
    const state = setup({});
    const original = state.sandbox.runCommand.getMockImplementation();
    state.sandbox.runCommand.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'git') {
        if (args[0] === 'rev-parse') return { exitCode: 1, stdout: async () => '' };
        if (args[0] === 'symbolic-ref') return { exitCode: unborn ? 0 : 1, stdout: async () => unborn ? 'refs/heads/main' : '' };
        if (args[0] === 'show-ref') return { exitCode: 1, stdout: async () => '' };
      }
      return original(command, args);
    });
    const result = await verifyPendingMigrations(state.sandbox, requirementId);
    if (unborn) expect(result).toEqual({ applied: [], errors: [] });
    else expect(result).toMatchObject({ failureKind: 'infrastructure' });
  });

  it('fails closed when committed migration tree cannot be read', async () => {
    const state = setup({});
    const original = state.sandbox.runCommand.getMockImplementation();
    state.sandbox.runCommand.mockImplementation(async (command: string, args: string[]) => command === 'git' && args[0] === 'ls-tree'
      ? { exitCode: 128, stdout: async () => '' } : original(command, args));
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ failureKind: 'infrastructure' });
  });

  it('records observed proposals in verification but never applies tenant SQL', async () => {
    const state = setup();
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({
      applied: [], pending: [file], failureKind: 'product', diagnostic: { kind: 'pending' },
    });
    expect(state.feedback.has(`migration:${file}`)).toBe(true);
    expect(state.applications()).toHaveLength(0);
    delete state.files[file];
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ diagnostic: { code: 'MISSING_MIGRATION' } });
  });

  it('does not allow a platform pending proposal to vanish from sandbox verification', async () => {
    const state = setup({});
    state.feedback.set('migration:platform/endpoint.sql', { migration_key: 'migration:platform/endpoint.sql', checksum: migrationDigest(sql), context_key: 'context', error: null });
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ pending: ['platform/endpoint.sql'], failureKind: 'product' });
    state.receipts.set('migration:platform/endpoint.sql', { checksum: migrationDigest(sql) });
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [], errors: [] });
  });

  it('returns historical infrastructure feedback for a tool retry instead of permanently blocking a now-readable workspace', async () => {
    const state = setup();
    state.setApply(() => ({ data: null, error: { code: '42501', message: 'permission denied' } }));
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ failureKind: 'infrastructure' });
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({
      failureKind: 'product', diagnostic: { kind: 'pending', code: 'MIGRATION_RETRY_REQUIRED',
        message: expect.stringContaining('do not rewrite SQL') },
    });
    expect(state.applications()).toHaveLength(1);
    state.setApply(args => {
      state.receipts.set(args.p_migration_key, { checksum: args.p_migration_checksum });
      return { data: true, error: null };
    });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [file], errors: [] });
    expect(state.applications()).toHaveLength(2);
  });

  it('treats receipts as authoritative over stale concurrent proposal feedback', async () => {
    const state = setup();
    state.feedback.set(`migration:${file}`, { migration_key: `migration:${file}`, checksum: migrationDigest(secondSql),
      context_key: 'old-context', error: { code: '42601', kind: 'sql', message: 'stale rejected proposal' } });
    state.receipts.set(`migration:${file}`, { checksum: migrationDigest(sql) });
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [], errors: [] });
    expect(state.applications()).toHaveLength(0);
    expect(state.feedback.get(`migration:${file}`).checksum).toBe(migrationDigest(secondSql));
  });

  it('catches files appearing only in the final workspace read', async () => {
    const state = setup({});
    let reads = 0;
    const original = state.db.rpc.getMockImplementation()!;
    state.db.rpc.mockImplementation(async (name, args) => {
      if (name === 'apps_get_migration_workspace' && ++reads === 2) {
        state.receipts.set(`migration:${file}`, { checksum: migrationDigest(sql) });
      }
      return original(name, args);
    });
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ diagnostic: { code: 'MISSING_MIGRATION' } });
  });

  it('fails closed on malformed journal responses', async () => {
    const state = setup({});
    const original = state.db.rpc.getMockImplementation()!;
    state.db.rpc.mockImplementation(async (name, args) => name === 'apps_get_migration_workspace'
      ? { data: { schema_fingerprint: 'a'.repeat(32), files: null, receipts: [] }, error: null }
      : original(name, args));
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ failureKind: 'infrastructure' });
  });

  it('fails an empty file and registers nonempty later proposals before SQL', async () => {
    const state = setup({ [file]: ' \n', [second]: secondSql });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ diagnostic: { code: 'EMPTY_MIGRATION' } });
    expect(state.feedback.has(`migration:${second}`)).toBe(true);
    expect(state.applications()).toHaveLength(0);
  });

  it('retains earlier atomic receipts when a later file fails', async () => {
    const state = setup({ 'migrations/001.sql': sql, 'migrations/002.sql': secondSql });
    state.setApply(args => {
      if (args.p_migration_key.endsWith('002.sql')) return { data: null, error: { code: '42601', message: 'syntax error' } };
      state.receipts.set(args.p_migration_key, { checksum: args.p_migration_checksum });
      return { data: true, error: null };
    });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({
      applied: ['migrations/001.sql'], pending: ['migrations/002.sql'], diagnostic: { code: '42601', rolled_back: true },
    });
  });

  it('caches deterministic rejection across batch registration and allows changed SQL', async () => {
    const state = setup({ [file]: 'DROP TABLE records;' });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ diagnostic: { code: 'MIGRATION_POLICY' } });
    const writes = state.db.rpc.mock.calls.filter(call => call[0] === 'apps_record_migration_feedback').length;
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ diagnostic: { code: 'MIGRATION_POLICY', repeated: true } });
    expect(state.db.rpc.mock.calls.filter(call => call[0] === 'apps_record_migration_feedback')).toHaveLength(writes);
    expect(state.applications()).toHaveLength(0);
    state.files[file] = sql;
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toEqual({ applied: [file], errors: [] });
  });

  it('rechecks final discovery instead of claiming success for a deleted applied file', async () => {
    const state = setup();
    state.setApply(args => {
      state.receipts.set(args.p_migration_key, { checksum: args.p_migration_checksum });
      delete state.files[file];
      return { data: true, error: null };
    });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ applied: [file], diagnostic: { code: 'MISSING_MIGRATION' } });
  });

  it('fails unavailable workspace even when there are no files', async () => {
    const state = setup({});
    state.db.rpc.mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } });
    expect(await verifyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ failureKind: 'infrastructure' });
  });

  it('blocks unresolved historical recovery without any lifecycle transition', async () => {
    const state = setup();
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ state: 'validation_pending' }]);
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ diagnostic: { code: 'LEGACY_MIGRATION_HOLD' }, failureKind: 'infrastructure' });
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
    expect(state.applications()).toHaveLength(0);
  });

  it('rejects paths outside the sandbox before journal or SQL', async () => {
    const state = setup({ 'migrations/../../outside.sql': sql });
    expect(await applyPendingMigrations(state.sandbox, requirementId)).toMatchObject({ diagnostic: { code: 'MIGRATION_PATH' } });
    expect(state.applications()).toHaveLength(0);
  });

  it('detects a file changed just before atomic application', async () => {
    const state = setup();
    const owner = context();
    let calls = 0;
    (owner.assertCurrent as jest.Mock).mockImplementation(async () => { if (++calls === 4) state.files[file] += '\n-- concurrent change'; });
    const result = await applyPendingMigrations(state.sandbox, requirementId, [], owner);
    expect(result.errors).not.toEqual([]);
    expect(state.applications()).toHaveLength(0);
  });

  it('restores only in an explicitly owned gate and never executes restored historical SQL', async () => {
    const state = setup({ [file]: 'changed' });
    state.receipts.set(`migration:${file}`, { checksum: migrationDigest(sql) });
    const restored = { file, schema, tenantId, checksum: migrationDigest(sql), previousChecksum: migrationDigest('changed') };
    (restoreAppliedMigration as jest.Mock).mockImplementation(async () => { state.files[file] = sql; return { restored }; });
    expect(await applyPendingMigrations(state.sandbox, requirementId, [], context(), { assertCurrent: jest.fn() })).toEqual({ applied: [], errors: [], restored: [restored] });
    expect(state.applications()).toHaveLength(0);
    expect(verifyMigrationRestorations).toHaveBeenCalledWith(state.sandbox, [restored]);
  });
});