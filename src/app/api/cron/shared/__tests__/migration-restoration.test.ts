import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { restoreAppliedMigration, verifyMigrationRestorations } from '@/lib/services/apps-platform/migration-restoration';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { FIND_APPLIED_MIGRATION, RESTORE_APPLIED_MIGRATION, VERIFY_APPLIED_MIGRATIONS } from '@/lib/services/apps-platform/migration-restoration-scripts';

jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));

const file = 'supabase/migrations/0001_initial_schema.sql';
const schema = 'app_aaaaaaaaaaaaaaaaaaaaaaaa';
const requirementId = '12345678-1234-1234-1234-123456789012';
const hash = (sql: string | Buffer) => createHash('sha256').update(sql).digest('hex');
const applied = '\uFEFF-- versión aplicada\r\nALTER TABLE records ENABLE ROW LEVEL SECURITY;\r\n';
const drift = '-- edited after application\nALTER TABLE records ENABLE ROW LEVEL SECURITY;\n';

describe('gate-owned applied migration restoration (real Git and filesystem, offline DB)', () => {
  let root: string;
  let backups: string[];
  let db: any;
  let tenant: any;
  let receipt: any;
  let run: jest.Mock;
  let assertCurrent: jest.Mock;
  let beforeCommand: ((script: string) => void) | undefined;
  let afterCommand: ((script: string) => void) | undefined;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commit = (content: string) => {
    writeFileSync(join(root, file), content);
    git('add', '--', file);
    git('-c', 'user.name=Offline Test', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const params = () => ({ sandbox: { runCommand: run } as any, requirementId, schema, tenantId: 'tenant', file,
    expectedChecksum: hash(applied), actualChecksum: hash(drift), assertCurrent });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'migration-restoration-test-')));
    backups = [];
    mkdirSync(dirname(join(root, file)), { recursive: true });
    git('init', '-q');
    tenant = { tenant_id: 'tenant', schema };
    receipt = { found: true, value: { checksum: hash(applied) } };
    db = {
      from: jest.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tenant, error: null }) }) }) })),
      rpc: jest.fn(async () => ({ data: receipt, error: null })),
    };
    (getAppsAdminClient as jest.Mock).mockReturnValue(db);
    assertCurrent = jest.fn(async () => {});
    beforeCommand = afterCommand = undefined;
    run = jest.fn(async ({ cmd, args, timeoutMs }: any) => {
      expect(cmd).toBe('node');
      const script = args[1];
      const payload = { ...JSON.parse(args[2]), root };
      beforeCommand?.(script);
      let stdout = '', exitCode = 0;
      try {
        stdout = execFileSync(process.execPath, ['-e', script, JSON.stringify(payload)], {
          encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: any) { stdout = String(error.stdout || ''); exitCode = error.status || 1; }
      if (script === RESTORE_APPLIED_MIGRATION) {
        const result = JSON.parse(stdout);
        if (result.backupPath) backups.push(dirname(result.backupPath));
      }
      afterCommand?.(script);
      return { exitCode, stdout: async () => stdout };
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    backups.forEach(path => rmSync(path, { recursive: true, force: true }));
  });

  it('finds the applied version, not the creation commit; preserves bytes, pending work and a private preimage', async () => {
    commit('-- creation version\n');
    const revision = commit(applied);
    commit(drift);
    const head = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'pending.sql'), 'pending work');
    const result = await restoreAppliedMigration(params());
    expect(result).toMatchObject({ restored: { file, checksum: hash(applied), previousChecksum: hash(drift),
      source: { kind: 'git', revision } } });
    if (!('restored' in result)) throw new Error('Expected a restoration');
    expect(readFileSync(join(root, file))).toEqual(Buffer.from(applied));
    expect(readFileSync(result.restored.backupPath, 'utf8')).toBe(drift);
    expect(readFileSync(join(root, 'pending.sql'), 'utf8')).toBe('pending work');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(db.rpc.mock.calls.every(([name]: string[]) => name === 'apps_get_migration_receipt')).toBe(true);
    await expect(verifyMigrationRestorations(params().sandbox, [result.restored], true)).rejects.toThrow('commit');
    commit(applied);
    await expect(verifyMigrationRestorations(params().sandbox, [result.restored], true)).resolves.toBeUndefined();
  });

  it('uses the allowlisted platform copy with the exact requirement, schema, path and live checksum', async () => {
    const archive = 'supabase/tenant-migrations/app_5a1d6caa92a4420d80f25673/0001_initial_schema.sql';
    const bytes = readFileSync(join(process.cwd(), archive));
    tenant.schema = 'app_5a1d6caa92a4420d80f25673';
    receipt.value.checksum = hash(bytes);
    writeFileSync(join(root, file), drift);
    const result = await restoreAppliedMigration({ ...params(), requirementId: '5a1d6caa-92a4-420d-80f2-567392a1af11',
      schema: tenant.schema, expectedChecksum: hash(bytes) });
    expect(result).toMatchObject({ restored: { source: { kind: 'platform_archive', revision: archive } } });
    expect(run.mock.calls.some(([arg]) => arg.args[1] === FIND_APPLIED_MIGRATION)).toBe(false);
    expect(readFileSync(join(root, file))).toEqual(bytes);
  });

  it('does not reuse another requirement’s archive or invent SQL when no matching source exists', async () => {
    commit(drift);
    const result = await restoreAppliedMigration(params());
    expect(result).toMatchObject({ failureKind: 'product', failure: { reason: 'no_matching_applied_source', writeAttempted: false } });
    expect(readFileSync(join(root, file), 'utf8')).toBe(drift);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['ledger', 'tenant', 'owner'])('refuses a changed %s after source discovery', async change => {
    commit(applied); commit(drift);
    afterCommand = script => {
      if (script !== FIND_APPLIED_MIGRATION) return;
      if (change === 'ledger') receipt = { found: false };
      if (change === 'tenant') tenant = { ...tenant, schema: 'app_bbbbbbbbbbbbbbbbbbbbbbbb' };
      if (change === 'owner') assertCurrent.mockRejectedValue(new Error('stale execution'));
    };
    expect(await restoreAppliedMigration(params())).toMatchObject({ failure: { reason: 'restoration_context_unavailable', writeAttempted: false } });
    expect(readFileSync(join(root, file), 'utf8')).toBe(drift);
  });

  it.each(['symlink', 'hardlink', 'concurrent_edit'])('refuses unsafe target: %s', async change => {
    commit(applied); commit(drift);
    beforeCommand = script => {
      if (script !== RESTORE_APPLIED_MIGRATION) return;
      if (change === 'concurrent_edit') writeFileSync(join(root, file), '-- changed concurrently');
      else {
        const other = join(root, 'other.sql');
        writeFileSync(other, drift);
        rmSync(join(root, file));
        if (change === 'symlink') symlinkSync(other, join(root, file));
        else linkSync(other, join(root, file));
      }
    };
    expect(await restoreAppliedMigration(params())).toMatchObject({ failure: { reason: 'restoration_unverified', writeAttempted: true } });
    expect(readFileSync(join(root, file), 'utf8')).not.toBe(applied);
  });

  it('retains ambiguity and never replays a write when transport fails after rename', async () => {
    commit(applied); commit(drift);
    afterCommand = script => { if (script === RESTORE_APPLIED_MIGRATION) throw new Error('lost acknowledgement'); };
    expect(await restoreAppliedMigration(params())).toMatchObject({ failure: { reason: 'restoration_unverified', writeAttempted: true } });
    expect(readFileSync(join(root, file), 'utf8')).toBe(applied);
    expect(run.mock.calls.filter(([arg]) => arg.args[1] === RESTORE_APPLIED_MIGRATION)).toHaveLength(1);
  });

  it('fails closed when restored bytes change before post-write verification', async () => {
    commit(applied); commit(drift);
    beforeCommand = script => { if (script === VERIFY_APPLIED_MIGRATIONS) writeFileSync(join(root, file), drift); };
    expect(await restoreAppliedMigration(params())).toMatchObject({ failure: { reason: 'restoration_unverified', writeAttempted: true } });
  });

  it('does not expose SQL or credentials in failure diagnostics', async () => {
    const sensitive = randomBytes(24).toString('hex');
    commit(applied); commit(drift);
    run.mockRejectedValue(new Error(sensitive));
    const result = await restoreAppliedMigration(params());
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(JSON.stringify(result)).not.toContain(applied);
    expect(JSON.stringify(result)).not.toContain(drift);
  });

  it.each(['../0001.sql', 'supabase/migrations/../0001.sql', 'supabase/migrations/.hidden.sql'])('rejects noncanonical file %s', async badFile => {
    expect(await restoreAppliedMigration({ ...params(), file: badFile })).toMatchObject({ failure: { reason: 'invalid_restoration_identity' } });
    expect(db.rpc).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it('never restores without a valid protected checksum', async () => {
    expect(await restoreAppliedMigration({ ...params(), expectedChecksum: '' })).toMatchObject({ failure: { reason: 'invalid_restoration_identity' } });
    expect(db.rpc).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it('restores an emptied applied file without accepting empty pending SQL', async () => {
    commit(applied);
    writeFileSync(join(root, file), '');
    const result = await restoreAppliedMigration({ ...params(), actualChecksum: hash('') });
    expect(result).toHaveProperty('restored');
    expect(readFileSync(join(root, file), 'utf8')).toBe(applied);
  });

  it('refuses oversized or non-round-trippable historical source even when its digest matches', async () => {
    for (const bytes of [Buffer.alloc(65537, 65), Buffer.from([0xff, 0xfe, 0x80])]) {
      writeFileSync(join(root, file), bytes);
      git('add', '--', file);
      git('-c', 'user.name=Offline Test', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'unsupported bytes');
      writeFileSync(join(root, file), drift);
      receipt.value.checksum = hash(bytes);
      const result = await restoreAppliedMigration({ ...params(), expectedChecksum: hash(bytes) });
      expect(result).toMatchObject({ failure: { writeAttempted: false } });
      expect(readFileSync(join(root, file), 'utf8')).toBe(drift);
    }
  });

  it('rejects conflicting expectations before running checkpoint verification', async () => {
    await expect(verifyMigrationRestorations(params().sandbox, [
      { file, checksum: 'a'.repeat(64) }, { file, checksum: 'b'.repeat(64) },
    ] as any)).rejects.toThrow('Conflicting');
    expect(run).not.toHaveBeenCalled();
  });
});