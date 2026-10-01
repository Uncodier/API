import { supabaseAdmin } from '@/lib/database/supabase-client';
import { claimMigrationDiagnostic, completeMigrationDiagnostic, assignMigrationDiagnosticFollowup, loadMigrationDiagnostic } from '@/lib/services/apps-platform/migration-diagnostic-state';
import { unresolvedMigration } from '@/lib/services/apps-platform/migration-diagnostic-policy';
import type { MigrationLifecycleRecord } from '@/lib/services/apps-platform/migration-lifecycle';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
const scope = { requirementId: '11111111-1111-4111-8111-111111111111', file: 'migrations/0001.sql', executionGeneration: 7, runId: 'run' };
const lifecycle: MigrationLifecycleRecord = { requirement_id: scope.requirementId, file: scope.file, version: 1,
  state: 'correction_required', checksum: 'a'.repeat(64), specification_checksum: 'b'.repeat(64), attempts: 5,
  original_sql: 'SELECT 1;', reason: 'Needs work', review: null, updated_at: '2026-10-01T00:00:00Z' };
const row = { requirement_id: scope.requirementId, file: scope.file, token: '22222222-2222-4222-8222-222222222222',
  state: 'running', execution_generation: 7, checksum: lifecycle.checksum, specification_checksum: lifecycle.specification_checksum,
  result: null, created_at: lifecycle.updated_at, updated_at: lifecycle.updated_at };
const rpc = supabaseAdmin.rpc as jest.Mock;

beforeEach(() => { jest.clearAllMocks(); rpc.mockResolvedValue({ data: row, error: null }); });

it('claims only once and treats a contended claim as no new diagnostic', async () => {
  expect(await claimMigrationDiagnostic(scope, lifecycle)).toEqual(row);
  rpc.mockResolvedValue({ data: null, error: null });
  expect(await claimMigrationDiagnostic(scope, lifecycle)).toBeNull();
  expect(rpc).toHaveBeenCalledWith('claim_migration_diagnostic', expect.objectContaining({ p_expected_version: 1, p_run_id: 'run' }));
});

it.each([{ requirement_id: '33333333-3333-4333-8333-333333333333' }, { execution_generation: 8 },
  { checksum: 'c'.repeat(64) }, { state: 'exhausted' }])('rejects a malformed or foreign claim receipt %j', async patch => {
  rpc.mockResolvedValue({ data: { ...row, ...patch }, error: null });
  await expect(claimMigrationDiagnostic(scope, lifecycle)).rejects.toThrow();
});

it('does not confuse a completion acknowledgement with a different diagnosis/token', async () => {
  const result = unresolvedMigration('Insufficient evidence');
  rpc.mockResolvedValue({ data: { ...row, state: 'exhausted', result }, error: null });
  expect((await completeMigrationDiagnostic(scope, row.token, result)).state).toBe('exhausted');
  rpc.mockResolvedValue({ data: { ...row, state: 'exhausted', result: { ...result, reason: 'different' } }, error: null });
  await expect(completeMigrationDiagnostic(scope, row.token, result)).rejects.toThrow('receipt');
});

it('rejects assignment without its typed repair candidate or with a different token', async () => {
  rpc.mockResolvedValue({ data: { ...row, state: 'followup_assigned' }, error: null });
  await expect(assignMigrationDiagnosticFollowup(scope, row.token)).rejects.toThrow();
});

it('does not fall back to an empty diagnostic when the persistence migration is missing', async () => {
  const query: any = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: { code: '42P01' } }) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  await expect(loadMigrationDiagnostic(scope.requirementId, scope.file)).rejects.toThrow('unavailable');
});