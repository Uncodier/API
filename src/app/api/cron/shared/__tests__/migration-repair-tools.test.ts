import { createHash } from 'node:crypto';
import { createMigrationRepairTools } from '@/lib/services/apps-platform/migration-repair-tools';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import type { MigrationSecurityReview } from '@/lib/services/apps-platform/migration-security-review';

jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));

const file = 'supabase/migrations/0001.sql';
const sql = 'CREATE POLICY read_all ON records USING (true);';
const fixed = 'CREATE POLICY read_all ON records USING (auth.uid() = user_id);';
const target = { file, schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', tenantId: 'tenant',
  checksum: createHash('sha256').update(sql).digest('hex'), reason: 'lint' as const };

function harness(contextPaths: string[] = []) {
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
  const reviewSecurity = jest.fn<Promise<MigrationSecurityReview>, [unknown]>().mockResolvedValue({ decision: 'approved_for_validation', reason: 'Preserves the specified owner access.' });
  const beforeWrite = jest.fn(async () => {});
  const repair = createMigrationRepairTools({ sandbox: sandbox as any, requirementId: 'req', target, assertCurrent, reviewSecurity, contextPaths, beforeWrite });
  return { ...repair, sandbox, rpc, lookup, assertCurrent, reviewSecurity, beforeWrite,
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
    expect(h.assertCurrent).toHaveBeenCalledTimes(6);
    expect(h.beforeWrite).toHaveBeenCalledWith(fixed);
    expect(h.reviewSecurity).toHaveBeenCalledWith(expect.objectContaining({ originalSql: sql, proposedSql: fixed }));
    expect(h.rpc).toHaveBeenCalledTimes(4);
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

  it.each(['request_changes', 'platform_review'] as const)('refuses a %s verdict without writing', async decision => {
    const h = harness();
    h.reviewSecurity.mockResolvedValue({ decision, reason: 'The product access model is not preserved.' });
    await expect(h.write({ sql: fixed })).resolves.toMatchObject({ success: false, review: { decision } });
    expect(h.wasChanged()).toBe(false);
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('does not treat a business question as authorization to write', async () => {
    const h = harness();
    h.reviewSecurity.mockResolvedValue({ decision: 'needs_product_decision', decisionId: 'access-audience', reason: 'Access is undefined.',
      question: 'Who should see records?', options: ['Owner', 'Organization'], specificationExcerpt: 'Records' });
    await expect(h.write({ sql: fixed })).resolves.toMatchObject({ success: false });
    expect(h.securityReview()?.decision).toBe('needs_product_decision');
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('revalidates concurrent changes and applied receipts after review', async () => {
    const h = harness();
    h.reviewSecurity.mockImplementation(async () => {
      h.sandbox.fs.readFile.mockResolvedValue('-- changed during review');
      return { decision: 'approved_for_validation', reason: 'Approved' };
    });
    await expect(h.write({ sql: fixed })).rejects.toThrow('concurrently');
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
    const applied = harness();
    applied.reviewSecurity.mockImplementation(async () => {
      applied.rpc.mockResolvedValue({ data: { found: true } });
      return { decision: 'approved_for_validation', reason: 'Approved' };
    });
    await expect(applied.write({ sql: fixed })).rejects.toThrow('ledger');
    expect(applied.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('fails closed when review context is missing or the reviewer fails', async () => {
    const h = harness();
    h.sandbox.runCommand.mockImplementation(async (_command, args) => ({ exitCode: args[1].endsWith('requirement.spec.md') ? 1 : 0, stdout: async () => args[1] }));
    await expect(h.write({ sql: fixed })).resolves.toMatchObject({ success: false, review: { decision: 'platform_review' } });
    expect(h.reviewSecurity).not.toHaveBeenCalled();
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
    const failed = harness();
    failed.reviewSecurity.mockRejectedValue(new Error('provider unavailable'));
    await expect(failed.write({ sql: fixed })).rejects.toThrow('provider unavailable');
    expect(() => failed.assertHealthy()).toThrow('provider unavailable');
    expect(failed.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('triages a stopped repair without exposing write privileges or replaying review', async () => {
    const h = harness();
    h.reviewSecurity.mockResolvedValue({ decision: 'platform_review', reason: 'Dynamic SQL cannot be safely replaced automatically.' });
    await expect(h.reviewBlockedMigration()).resolves.toMatchObject({ decision: 'platform_review' });
    await h.reviewBlockedMigration();
    expect(h.reviewSecurity).toHaveBeenCalledTimes(1);
    expect(h.reviewSecurity).toHaveBeenCalledWith(expect.objectContaining({ proposedSql: undefined, originalSql: sql }));
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('rejects concurrent replacement calls before a second reviewer or writer runs', async () => {
    const h = harness();
    const results = await Promise.all([h.write({ sql: fixed }), h.write({ sql: fixed })]);
    expect(results.filter(result => result.success)).toHaveLength(1);
    expect(h.reviewSecurity).toHaveBeenCalledTimes(1);
    expect(h.sandbox.writeFiles).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed specification after the reviewer approved the previous contract', async () => {
    const h = harness();
    h.reviewSecurity.mockImplementation(async () => {
      h.sandbox.fs.readFile.mockImplementation(async (path: string) => path.endsWith('requirement.spec.md') ? 'Changed access model' : sql);
      return { decision: 'approved_for_validation', reason: 'Preserves original contract.' };
    });
    await expect(h.write({ sql: fixed })).rejects.toThrow('specification changed');
    expect(h.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('rereads carried source paths across durable turns and rejects post-review source changes', async () => {
    const h = harness(['src/access.ts']);
    const source = 'export const access = "owner";';
    h.sandbox.fs.readFile.mockImplementation(async (path: string) => path.endsWith('src/access.ts') ? source : sql);
    await h.write({ sql: fixed });
    expect(h.reviewSecurity).toHaveBeenCalledWith(expect.objectContaining({
      sourceContext: [{ path: '/vercel/sandbox/src/access.ts', content: source }],
    }));
    const changed = harness(['src/access.ts']);
    changed.reviewSecurity.mockImplementation(async () => {
      changed.sandbox.fs.readFile.mockImplementation(async (path: string) => path.endsWith('src/access.ts') ? 'changed' : sql);
      return { decision: 'approved_for_validation', reason: 'Approved original context.' };
    });
    await expect(changed.write({ sql: fixed })).rejects.toThrow('Project source changed');
    expect(changed.sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('tracks a write attempt even when verification fails and preserves its terminal error', async () => {
    const h = harness();
    h.sandbox.writeFiles.mockImplementation(async () => { h.sandbox.fs.readFile.mockRejectedValue(new Error('readback unavailable')); });
    await expect(h.write({ sql: fixed })).rejects.toThrow('readback unavailable');
    expect(h.writeAttempted()).toBe(true);
    expect(h.wasChanged()).toBe(false);
    expect(() => h.assertHealthy()).toThrow('readback unavailable');
  });
});