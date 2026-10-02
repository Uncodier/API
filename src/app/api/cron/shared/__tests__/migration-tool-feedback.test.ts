import { randomBytes } from 'node:crypto';
import { sandboxDbMigrateTool } from '@/app/api/agents/tools/sandbox/sandbox-db-migrate';
import { deductSandboxToolCredits, liveSandbox } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { applyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import { authorizeMigrationApplication } from '@/lib/services/apps-platform/migration-application-guard';
import { transitionMigrationLifecycle } from '@/lib/services/apps-platform/migration-lifecycle';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';

jest.mock('@/app/api/agents/tools/sandbox/assistantProtocol', () => ({
  deductSandboxToolCredits: jest.fn(), liveSandbox: jest.fn(),
}));
jest.mock('@/lib/services/apps-platform/migration-applier', () => ({ applyPendingMigrations: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-application-guard', () => ({ authorizeMigrationApplication: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ transitionMigrationLifecycle: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));

const sandbox = {} as any;
const activeSandbox = {} as any;
const toolsContext = { activeSandboxRef: { current: activeSandbox } };
const requirementId = 'requirement-1';
const file = 'migrations/002.sql';
const migrate = () => sandboxDbMigrateTool(sandbox, requirementId, toolsContext).execute();

describe('sandbox migration feedback in the ordinary agent loop', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (deductSandboxToolCredits as jest.Mock).mockResolvedValue({ success: true });
    (liveSandbox as jest.Mock).mockReturnValue(activeSandbox);
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [] });
  });

  afterEach(() => {
    // Tool feedback must not schedule repair work, alter plans/status, or execute
    // a second SQL path. The applier owns all migration execution.
    expect(authorizeMigrationApplication).not.toHaveBeenCalled();
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(getAppsAdminClient).not.toHaveBeenCalled();
  });

  it('uses the current sandbox and preserves receipts only on verified success', async () => {
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: ['migrations/001.sql', file], errors: [] });
    expect(await migrate()).toMatchObject({ success: true, applied: ['migrations/001.sql', file],
      receipt: { kind: 'database_migration', applied: ['migrations/001.sql', file], pending: 0 } });
    expect(liveSandbox).toHaveBeenCalledWith(sandbox, toolsContext);
    expect(applyPendingMigrations).toHaveBeenCalledWith(activeSandbox, requirementId);
  });

  it('keeps a verified empty/idempotent batch distinguishable from newly applied SQL', async () => {
    expect(await migrate()).toMatchObject({ success: true, applied: [],
      receipt: { kind: 'database_migration', applied: [], pending: 0 } });
  });

  it('retains earlier applied files and the failed file diagnostic without a success receipt', async () => {
    const diagnostic = { file, code: '42601', message: 'Syntax error at the pending statement', kind: 'sql', rolled_back: true };
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: ['migrations/001.sql'], errors: [diagnostic.message],
      pending: [file, 'migrations/003.sql'], failureKind: 'product', diagnostic });
    const result = await migrate();
    expect(result).toMatchObject({ success: false, applied: ['migrations/001.sql'], failureKind: 'product',
      pending: [file, 'migrations/003.sql'], diagnostic });
    expect(result).not.toHaveProperty('receipt');
    expect(result).not.toHaveProperty('correction');
    expect(result).not.toHaveProperty('attempts');
  });

  it.each([
    { code: 'MIGRATION_LINT', kind: 'policy', failureKind: 'product', repeated: true },
    { code: 'MISSING_MIGRATION', kind: 'history', failureKind: 'product' },
    { code: 'LEGACY_MIGRATION_HOLD', kind: 'infrastructure', failureKind: 'infrastructure' },
    { code: 'MIGRATION_OUTCOME_UNKNOWN', kind: 'infrastructure', failureKind: 'infrastructure' },
  ])('retains actionable feedback without inventing rollback or auto-resolving a hold ($code)', async ({ failureKind, ...details }) => {
    const diagnostic = { file, message: 'Migration needs attention', ...details };
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [diagnostic.message],
      pending: [file], failureKind, diagnostic });
    const result = await migrate();
    expect(result).toMatchObject({ success: false, diagnostic, pending: [file], failureKind });
    expect(result).not.toHaveProperty('receipt');
    expect(result).not.toHaveProperty('diagnostic.rolled_back');
  });

  it('never turns known pending files into an empty success', async () => {
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [], pending: [file] });
    const result = await migrate();
    expect(result).toMatchObject({ success: false, applied: [], pending: [file] });
    expect(result).not.toHaveProperty('receipt');
  });

  it('returns repeated feedback beyond five calls and permits correction in the same loop', async () => {
    const tool = sandboxDbMigrateTool(sandbox, requirementId, toolsContext);
    const diagnostic = { file, code: '42601', message: 'Correct pending SQL', kind: 'sql', repeated: true, rolled_back: true };
    (applyPendingMigrations as jest.Mock).mockResolvedValue({ applied: [], errors: [diagnostic.message],
      pending: [file], failureKind: 'product', diagnostic });
    for (let attempt = 0; attempt < 7; attempt++) {
      const result = await tool.execute();
      expect(result).toMatchObject({ success: false, diagnostic });
      expect(result).not.toHaveProperty('receipt');
      expect(result).not.toHaveProperty('correction');
      expect(result).not.toHaveProperty('state');
    }
    (applyPendingMigrations as jest.Mock).mockResolvedValueOnce({ applied: [file], errors: [] });
    expect(await tool.execute()).toMatchObject({ success: true, receipt: { applied: [file], pending: 0 } });
    expect(applyPendingMigrations).toHaveBeenCalledTimes(8);
  });

  it('honors ordinary tool credit checks without a migration-specific attempt budget', async () => {
    (deductSandboxToolCredits as jest.Mock).mockResolvedValue({ success: false, error: 'Tool execution unavailable' });
    expect(await migrate()).toEqual({ success: false, error: 'Tool execution unavailable' });
    expect(applyPendingMigrations).not.toHaveBeenCalled();
  });

  it('does not migrate without a bound requirement', async () => {
    expect(await sandboxDbMigrateTool(sandbox).execute()).toMatchObject({ success: false, error: expect.stringContaining('requirement_id') });
    expect(applyPendingMigrations).not.toHaveBeenCalled();
  });

  it('returns sanitized unexpected failure details without throwing out of the loop', async () => {
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/migrations');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    (applyPendingMigrations as jest.Mock).mockRejectedValueOnce(new Error(`Migration transport failed: ${url}`));
    const result = await migrate();
    expect(result).toMatchObject({ success: false, failureKind: 'infrastructure',
      diagnostic: { code: 'MIGRATION_INFRASTRUCTURE', kind: 'infrastructure', message: expect.stringContaining('Migration transport failed') } });
    expect(result).not.toHaveProperty('receipt');
    for (const sensitive of [username, password, token]) expect(JSON.stringify(result)).not.toContain(sensitive);
  });
});