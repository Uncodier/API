import { createHash } from 'node:crypto';
import { createMigrationRepairTools } from '@/lib/services/apps-platform/migration-repair-tools';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';

jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));

const file = 'supabase/migrations/0001.sql';
const sql = 'CREATE POLICY read_all ON records USING (true);';
const fixed = 'CREATE POLICY read_all ON records USING (auth.uid() = user_id);';
const target = { file, schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenantId: 'tenant',
  checksum: createHash('sha256').update(sql).digest('hex'), reason: 'lint' as const };

function harness() {
  const assertCurrent = jest.fn().mockResolvedValue(undefined);
  const sandbox = {
    fs: { readFile: jest.fn().mockResolvedValue(sql) }, writeFiles: jest.fn(),
    runCommand: jest.fn(async (_command: string, args: string[]) => ({ exitCode: 0, stdout: async () => args[1] })),
  };
  sandbox.writeFiles.mockImplementation(async (files: Array<{ content: string }>) => {
    sandbox.fs.readFile.mockResolvedValue(files[0].content);
  });
  const lookup = jest.fn().mockResolvedValue({ data: { schema: target.schema, tenant_id: target.tenantId }, error: null });
  const rpc = jest.fn().mockResolvedValue({ data: { found: false, repairable: true }, error: null });
  (getAppsAdminClient as jest.Mock).mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: lookup }) }) }), rpc,
  });
  const repair = createMigrationRepairTools({ sandbox: sandbox as any, requirementId: 'req', target, assertCurrent });
  return { ...repair, sandbox, rpc, lookup, assertCurrent,
    read: repair.tools[0].execute as (args: { path: string }) => Promise<any>,
    write: repair.tools[1].execute as (args: { sql: string }) => Promise<any> };
}

describe('restricted pending migration repair tools', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exposes no shell, direct SQL, arbitrary write or push tool', () => {
    expect(harness().tools.map(t => t.name)).toEqual(['migration_read_context', 'migration_replace_pending_sql']);
  });

  it('validates lint, tenant, ledger and original checksum before a canonical write', async () => {
    const h = harness();
    await expect(h.read({ path: file })).resolves.toMatchObject({ success: true, content: sql });
    await expect(h.write({ sql: fixed })).resolves.toMatchObject({ success: true, applied: false });
    expect(h.rpc).toHaveBeenCalledWith('apps_get_migration_receipt', expect.objectContaining({ p_migration_key: `migration:${file}` }));
    expect(h.sandbox.writeFiles).toHaveBeenCalledWith([{ path: `/vercel/sandbox/${file}`, content: fixed }]);
    expect(h.wasChanged()).toBe(true);
    expect(h.assertCurrent).toHaveBeenCalledTimes(3);
  });

  it.each(['', '-- skip this migration', 'SELECT 1;', 'ALTER TABLE records DROP COLUMN email;', 'DELETE FROM records;', 'DROP SCHEMA public;', sql])('refuses empty/unsafe/unchanged SQL: %s', async bad => {
    const h = harness();
    await expect(h.write({ sql: bad })).resolves.toMatchObject({ success: false });
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
    expect(h.wasChanged()).toBe(false);
  });

  it.each([
    { data: { found: true }, error: null },
    { data: null, error: { message: 'unavailable' } },
    { data: {}, error: null },
  ])('fails closed on applied/missing ledger receipt', async response => {
    const h = harness(); h.rpc.mockResolvedValue(response);
    await expect(h.write({ sql: fixed })).rejects.toThrow('ledger');
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('refuses a different tenant and concurrently changed SQL', async () => {
    const h = harness(); h.lookup.mockResolvedValue({ data: { schema: 'other', tenant_id: 'other' } });
    await expect(h.write({ sql: fixed })).rejects.toThrow('tenant identity');
    expect(h.rpc).not.toHaveBeenCalled();
    const concurrent = harness(); concurrent.sandbox.fs.readFile.mockResolvedValue('-- another writer');
    await expect(concurrent.write({ sql: fixed })).rejects.toThrow('concurrently');
    expect(concurrent.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('refuses renamed applied SQL and unavailable eligibility RPC', async () => {
    const h = harness();
    h.rpc.mockResolvedValueOnce({ data: { found: false }, error: null })
      .mockResolvedValueOnce({ data: { repairable: false }, error: null });
    await expect(h.write({ sql: fixed })).rejects.toThrow('already applied under another path');
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
    const missing = harness();
    missing.rpc.mockResolvedValueOnce({ data: { found: false }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } });
    await expect(missing.write({ sql: fixed })).rejects.toThrow('eligibility is unavailable');
    expect(missing.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it.each(['.env.local', 'src/env.ts', 'docs/secrets.md', 'src/../.env.local', '/etc/passwd', 'src/.env', 'node_modules/pkg/index.ts', '../migrations/0001.sql'])('refuses sensitive/outside paths: %s', async path => {
    const h = harness();
    await expect(h.read({ path })).rejects.toThrow();
    expect(h.sandbox.fs.readFile).not.toHaveBeenCalled();
  });

  it.each([
    'ALTER TABLE records DROP email;', 'UPDATE records SET email = NULL;',
    'ALTER TABLE records DROP CONSTRAINT owner_required;',
    'ALTER TABLE records ENABLE ROW LEVEL SECURITY;',
    'CREATE POLICY renamed ON records USING (auth.uid() = user_id);',
  ])('refuses destructive or intent-erasing replacement: %s', async sql => {
    const h = harness();
    await expect(h.write({ sql })).resolves.toMatchObject({ success: false });
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('redacts inline credentials and verifies the repaired checksum', async () => {
    const h = harness();
    h.sandbox.fs.readFile.mockResolvedValueOnce('const token = "sensitive-value"; // ghp_syntheticvalue123');
    const result = await h.read({ path: 'src/lib/client.ts' });
    expect(result.content).not.toContain('sensitive-value');
    expect(result.content).not.toContain('ghp_syntheticvalue123');
    await h.write({ sql: fixed });
    expect(h.repairedTarget()?.checksum).toBe(createHash('sha256').update(fixed).digest('hex'));
  });

  it('refuses symlink targets and ownership loss immediately before a write', async () => {
    const h = harness(); h.sandbox.runCommand.mockImplementation(async () => ({ exitCode: 0, stdout: async () => '/etc/secret' }));
    await expect(h.write({ sql: fixed })).rejects.toThrow('symlink');
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
    const stale = harness(); stale.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('stale'));
    await expect(stale.write({ sql: fixed })).rejects.toThrow('stale');
    expect(stale.sandbox.writeFiles).not.toHaveBeenCalled();
  });
});