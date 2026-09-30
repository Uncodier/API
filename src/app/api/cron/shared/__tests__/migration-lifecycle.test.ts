import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  listMigrationLifecycle, transitionMigrationLifecycle,
  type MigrationLifecycleRecord, type MigrationLifecycleTransitionInput,
} from '@/lib/services/apps-platform/migration-lifecycle';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));

const requirementId = '00000000-0000-4000-8000-000000000001';
const file = 'supabase/migrations/0001_access.sql';
const checksum = 'a'.repeat(64);
const specificationChecksum = 'b'.repeat(64);
const row = (extra: Partial<MigrationLifecycleRecord> = {}): MigrationLifecycleRecord => ({
  requirement_id: requirementId, file, version: 1, state: 'correction_required',
  checksum, specification_checksum: specificationChecksum, original_sql: 'SELECT 1;',
  reason: 'Correct ownership; fresh verification required.', review: null, attempts: 0,
  updated_at: '2026-09-30T01:00:00.000000+00:00', ...extra,
});
const input = (): MigrationLifecycleTransitionInput => ({
  requirementId, file, expectedVersion: 0, executionGeneration: 7,
  value: { state: 'correction_required', checksum, specification_checksum: specificationChecksum,
    original_sql: 'SELECT 1;', reason: row().reason, review: null, attempts: 0 },
});
const rpc = supabaseAdmin.rpc as jest.Mock;
const from = supabaseAdmin.from as jest.Mock;
const eq = jest.fn();
const select = jest.fn(() => ({ eq }));

beforeEach(() => {
  jest.clearAllMocks();
  from.mockReturnValue({ select });
  eq.mockResolvedValue({ data: [row()], error: null });
  rpc.mockResolvedValue({ data: row(), error: null });
});

describe('service-role migration lifecycle client', () => {
  it('loads explicitly selected full rows scoped to the requirement without tenant I/O', async () => {
    await expect(listMigrationLifecycle(requirementId)).resolves.toEqual([row()]);
    expect(from).toHaveBeenCalledWith('requirement_migration_lifecycle');
    expect(select).toHaveBeenCalledWith('requirement_id,file,version,state,checksum,specification_checksum,original_sql,reason,review,attempts,updated_at');
    expect(eq).toHaveBeenCalledWith('requirement_id', requirementId);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts a genuine empty list but never substitutes an empty list for failures', async () => {
    eq.mockResolvedValueOnce({ data: [], error: null });
    await expect(listMigrationLifecycle(requirementId)).resolves.toEqual([]);
    eq.mockResolvedValueOnce({ data: [], error: { code: '42P01', message: 'missing table' } });
    await expect(listMigrationLifecycle(requirementId)).rejects.toThrow('42P01');
    eq.mockRejectedValueOnce(new Error('offline'));
    await expect(listMigrationLifecycle(requirementId)).rejects.toThrow('offline');
  });

  it.each([null, undefined, {}, { state: 'missing' }, [row(), row()],
    [row({ requirement_id: '00000000-0000-4000-8000-000000000002' })],
    [row({ file: 'migrations/../secret.sql' })], [row({ checksum: 'a'.repeat(63) })],
    [row({ attempts: 6 })], [row({ state: 'approved' as never })], [row({ version: 0 })],
    [row({ updated_at: 'yesterday' })], [row({ original_sql: 'é'.repeat(32769) })],
    [row({ reason: 'x'.repeat(2049) })], [row({ review: undefined })],
  ].map(data => ({ data })))('fails closed on malformed or cross-scope list data (%#)', async ({ data }) => {
    eq.mockResolvedValueOnce({ data, error: null });
    await expect(listMigrationLifecycle(requirementId)).rejects.toThrow();
  });

  it('keeps nullable provenance and full JSON review content intact', async () => {
    const record = row({ original_sql: null, review: { decision: 'request_changes', fields: { policy: 'ownership' }, issues: ['RLS'], approved: false } });
    eq.mockResolvedValueOnce({ data: [record], error: null });
    await expect(listMigrationLifecycle(requirementId)).resolves.toEqual([record]);
  });

  it('uses only the generation/version-scoped transition RPC and validates its receipt', async () => {
    await expect(transitionMigrationLifecycle(input())).resolves.toEqual(row());
    expect(rpc).toHaveBeenCalledWith('transition_requirement_migration', {
      p_requirement_id: requirementId, p_file: file, p_expected_version: 0,
      p_expected_execution_generation: 7, p_value: input().value,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('accepts a next-version durable review receipt with complete review JSON', async () => {
    const request = input();
    request.expectedVersion = 3;
    request.value.state = 'validation_pending';
    request.value.attempts = 2;
    request.value.review = { decision: 'approved_for_validation', findings: [], fields: { preserved: true } };
    const receipt = row({ ...request.value, version: 4 });
    rpc.mockResolvedValueOnce({ data: receipt, error: null });
    await expect(transitionMigrationLifecycle(request)).resolves.toEqual(receipt);
  });

  it('omits optional values instead of clearing durable SQL and review', async () => {
    const request = input();
    delete request.value.original_sql;
    delete request.value.review;
    const receipt = row({ review: { prior: true } });
    rpc.mockResolvedValueOnce({ data: receipt, error: null });
    await expect(transitionMigrationLifecycle(request)).resolves.toEqual(receipt);
    expect(rpc.mock.calls[0][1].p_value).not.toHaveProperty('original_sql');
    expect(rpc.mock.calls[0][1].p_value).not.toHaveProperty('review');
  });

  it('does not forward row identity/version fields when spreading a previous receipt', async () => {
    const request = { ...input(), value: { ...row() } };
    await transitionMigrationLifecycle(request);
    expect(rpc.mock.calls[0][1].p_value).toEqual(input().value);
  });

  it.each(['40001', '42501', '42P01', '23514'])('fails closed for RPC error %s without fallback writes', async code => {
    rpc.mockResolvedValueOnce({ data: row(), error: { code, message: 'sensitive database details' } });
    await expect(transitionMigrationLifecycle(input())).rejects.toThrow(code);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('propagates transport failure without retries that might reacquire a review lease', async () => {
    rpc.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(transitionMigrationLifecycle(input())).rejects.toThrow('network unavailable');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], [row()], { state: 'stale' }, { ...row(), success: true },
    row({ requirement_id: '00000000-0000-4000-8000-000000000002' }), row({ file: 'platform/other.sql' }),
    row({ version: 2 }), row({ version: 0 }), row({ state: 'validated' }), row({ checksum: 'c'.repeat(64) }),
    row({ specification_checksum: 'd'.repeat(64) }), row({ original_sql: null }),
    row({ attempts: 1 }), row({ reason: 'Unexpected reason' }), row({ updated_at: '' }),
  ].map(data => ({ data })))('rejects malformed, stale, or mismatched transition receipts (%#)', async ({ data }) => {
    rpc.mockResolvedValueOnce({ data, error: null });
    await expect(transitionMigrationLifecycle(input())).rejects.toThrow('Invalid migration lifecycle');
  });

  it.each(['requirement_id','file','version','state','checksum','specification_checksum','original_sql','reason','review','attempts','updated_at'])('requires full response field %s', async field => {
    const incomplete = { ...row() } as Record<string, unknown>;
    delete incomplete[field];
    rpc.mockResolvedValueOnce({ data: incomplete, error: null });
    await expect(transitionMigrationLifecycle(input())).rejects.toThrow();
  });

  it.each(['migrations/a.sql', 'supabase/migrations/nested/001_a.sql', 'src/db/migrations/a.sql', 'platform/auth/001.sql'])('accepts canonical path %s', async path => {
    rpc.mockResolvedValueOnce({ data: row({ file: path }), error: null });
    await expect(transitionMigrationLifecycle({ ...input(), file: path })).resolves.toMatchObject({ file: path });
  });

  it.each(['a.sql','../migrations/a.sql','/migrations/a.sql','migrations/a.sql\n','migrations/./a.sql',
    'migrations/../a.sql','migrations//a.sql','platform/.secret.sql','migrations/a.SQL','migrations/a.ts',
    'migrations/a%2fb.sql','migrations\\a.sql','migrations/' + 'x'.repeat(513) + '.sql',
  ])('rejects noncanonical path %s before any I/O', async path => {
    await expect(transitionMigrationLifecycle({ ...input(), file: path })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { expectedVersion: -1 }, { expectedVersion: 0.1 }, { expectedVersion: 2147483647 },
    { executionGeneration: -1 }, { executionGeneration: NaN }, { executionGeneration: 2147483648 },
    { requirementId: 'not-a-uuid' },
  ])('rejects malformed scope/version before any I/O (%#)', async invalid => {
    await expect(transitionMigrationLifecycle({ ...input(), ...invalid })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { checksum: checksum + '\n' }, { checksum: 'A'.repeat(64) }, { specification_checksum: 'sha256:' + checksum },
    { attempts: 6 }, { attempts: -1 }, { attempts: 1.1 }, { attempts: '1' },
    { state: 'approved' }, { original_sql: 'é'.repeat(32769) }, { original_sql: {} },
    { reason: 'x'.repeat(2049) }, { reason: null },
  ])('rejects malformed transition values before any I/O (%#)', async invalid => {
    await expect(transitionMigrationLifecycle({ ...input(), value: { ...input().value, ...invalid } } as MigrationLifecycleTransitionInput)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts bounded 64KiB UTF-8 provenance, 2048 character reasons and nullable review', async () => {
    const request = input();
    request.value.original_sql = 'é'.repeat(32768);
    request.value.reason = 'é'.repeat(2048);
    rpc.mockResolvedValueOnce({ data: row(request.value), error: null });
    await expect(transitionMigrationLifecycle(request)).resolves.toMatchObject(request.value);
  });

  it('validates a requirement ID before loading anything', async () => {
    await expect(listMigrationLifecycle('untrusted')).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });
});