import { obtainMigrationDiagnosis } from '../migration-diagnostic-handoff';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { diagnoseMigration } from '@/lib/services/apps-platform/migration-diagnostic-agent';
import { claimMigrationDiagnostic, completeMigrationDiagnostic, loadMigrationDiagnostic } from '@/lib/services/apps-platform/migration-diagnostic-state';
import { loadMigrationApplicationContext } from '@/lib/services/apps-platform/migration-application-guard';
import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { getTenantCapabilities } from '@/lib/services/apps-platform/tenant-capabilities-service';
import { assertCronExecutionOwnership } from '../cron-execution-ownership';
import type { MigrationLifecycleRecord } from '@/lib/services/apps-platform/migration-lifecycle';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/apps-platform/migration-diagnostic-agent', () => ({ diagnoseMigration: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-diagnostic-state', () => ({ claimMigrationDiagnostic: jest.fn(), completeMigrationDiagnostic: jest.fn(), loadMigrationDiagnostic: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-application-guard', () => ({ loadMigrationApplicationContext: jest.fn() }));
jest.mock('@/lib/services/apps-platform/tenant-capabilities-service', () => ({ getTenantCapabilities: jest.fn() }));
jest.mock('@/lib/services/sandbox-sdk', () => ({ getSandboxHandle: jest.fn() }));
jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn() }));
jest.mock('@/lib/services/cron-audit-log', () => ({ logCronInfrastructureEvent: jest.fn() }));

const row: MigrationLifecycleRecord = { requirement_id: 'req', file: 'migrations/0001.sql', attempts: 5, version: 6,
  state: 'correction_required', checksum: 'a'.repeat(64), specification_checksum: 'b'.repeat(64), reason: 'Policy failed',
  original_sql: 'SQL', review: null, updated_at: '2026-10-01T00:00:00Z' };
const params = { row, executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 7 }, previousInstructions: 'Old strategy', sandboxId: 'sandbox' };
const diagnosis = { decision: 'repair_candidate', reason: 'New strategy', hypothesis: 'Member access', instruction: 'Repair membership', verification: 'Test all roles', next_action: 'Execute', evidence: [] };

beforeEach(() => {
  jest.resetAllMocks();
  (loadMigrationDiagnostic as jest.Mock).mockResolvedValue(null);
  (claimMigrationDiagnostic as jest.Mock).mockResolvedValue({ token: 'token' });
  (completeMigrationDiagnostic as jest.Mock).mockImplementation(async (_scope, token, result) => ({ token, result }));
  (loadMigrationApplicationContext as jest.Mock).mockResolvedValue({ instance: { id: 'instance', site_id: 'site' } });
  (getSandboxHandle as jest.Mock).mockResolvedValue({});
  (getTenantCapabilities as jest.Mock).mockResolvedValue({});
  (diagnoseMigration as jest.Mock).mockResolvedValue(diagnosis);
  const query: any = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [], error: null }) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
});

it('claims before invoking the independent agent and persists before returning a handoff', async () => {
  expect(await obtainMigrationDiagnosis(params)).toEqual({ token: 'token', result: diagnosis });
  expect((claimMigrationDiagnostic as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((diagnoseMigration as jest.Mock).mock.invocationCallOrder[0]);
  expect(completeMigrationDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run' }), 'token', diagnosis);
});

it.each(['running', 'followup_reviewing', 'exhausted'])('does not replay an existing %s diagnostic', async state => {
  (loadMigrationDiagnostic as jest.Mock).mockResolvedValue({ state, execution_generation: 7, specification_checksum: row.specification_checksum,
    result: state === 'exhausted' ? { decision: 'unresolved', reason: 'No evidence' } : diagnosis });
  expect((await obtainMigrationDiagnosis(params)).result.decision).toBe('unresolved');
  expect(claimMigrationDiagnostic).not.toHaveBeenCalled();
  expect(diagnoseMigration).not.toHaveBeenCalled();
});

it.each(['followup_ready', 'followup_assigned'])('reuses persisted %s rather than calling a new agent', async state => {
  (loadMigrationDiagnostic as jest.Mock).mockResolvedValue({ state, token: 'token', execution_generation: 7,
    checksum: row.checksum, specification_checksum: row.specification_checksum, result: diagnosis });
  expect(await obtainMigrationDiagnosis(params)).toMatchObject({ token: 'token', result: diagnosis, assigned: state === 'followup_assigned' });
  expect(diagnoseMigration).not.toHaveBeenCalled();
});

it('preserves allowance across generic resume/generation change', async () => {
  (loadMigrationDiagnostic as jest.Mock).mockResolvedValue({ state: 'followup_ready', execution_generation: 6 });
  expect((await obtainMigrationDiagnosis(params)).result.decision).toBe('unresolved');
  expect(claimMigrationDiagnostic).not.toHaveBeenCalled();
});

it('cannot spend a second diagnosis when the claim is contended', async () => {
  (claimMigrationDiagnostic as jest.Mock).mockResolvedValue(null);
  await expect(obtainMigrationDiagnosis(params)).rejects.toThrow('Another worker');
  expect(diagnoseMigration).not.toHaveBeenCalled();
});

it('persists transport/capability failures as unresolved without pretending repair is impossible', async () => {
  (getSandboxHandle as jest.Mock).mockRejectedValue(new Error('offline'));
  expect((await obtainMigrationDiagnosis(params)).result.decision).toBe('unresolved');
  expect(completeMigrationDiagnostic).toHaveBeenCalledWith(expect.anything(), 'token', expect.objectContaining({ decision: 'unresolved' }));
});

it('never completes the diagnostic after losing execution ownership', async () => {
  (assertCronExecutionOwnership as jest.Mock).mockRejectedValue(new Error('stale owner'));
  await expect(obtainMigrationDiagnosis(params)).rejects.toThrow('stale owner');
  expect(completeMigrationDiagnostic).not.toHaveBeenCalled();
});