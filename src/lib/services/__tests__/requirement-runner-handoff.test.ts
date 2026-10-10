const mockRpc = jest.fn();
const mockResults: any[] = [];
const query: any = {};
for (const method of ['select', 'eq', 'in', 'order']) query[method] = jest.fn(() => query);
query.then = (resolve: any) => resolve(mockResults.shift() || { data: [], error: null });
const mockFrom = jest.fn(() => query);
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: mockFrom, rpc: mockRpc },
}));
import { inspectRequirementRunnerHandoff, replaceArchivedRequirementRunner } from '../requirement-runner-handoff';

describe('original requirement runner handoff', () => {
  const requirement = { id: 'req', site_id: 'site', metadata: {
    runner_instance_id: 'original', assistant_origin_instance_id: 'original',
  } };
  beforeEach(() => { jest.clearAllMocks(); mockResults.length = 0; });

  it('defers the original assistant without falling back to another instance', async () => {
    mockRpc.mockResolvedValue({ data: { allowed: false, reason: 'assistant_action_not_finished' } });
    expect(await inspectRequirementRunnerHandoff(requirement)).toEqual({
      instanceId: 'original', skipReason: 'assistant_action_not_finished',
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('continues a finished or failed turn on the same logical instance', async () => {
    mockRpc.mockResolvedValue({ data: { allowed: true } });
    expect(await inspectRequirementRunnerHandoff(requirement)).toEqual({ instanceId: 'original' });
    expect(mockRpc).toHaveBeenCalledWith('inspect_requirement_assistant_handoff', {
      p_requirement_id: 'req', p_instance_id: 'original',
    });
  });

  it('identifies explicit archival for atomic replacement, not ordinary fallback', async () => {
    mockRpc.mockResolvedValue({ data: { allowed: false, reason: 'original_instance_archived' } });
    expect(await inspectRequirementRunnerHandoff(requirement)).toEqual({
      instanceId: 'original', archivedInstanceId: 'original',
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each(['original_instance_paused', 'original_instance_unavailable', 'assistant_action_not_finished', 'original_assistant_action_not_finished'])
  ('does not authorize replacement for %s', async reason => {
    mockRpc.mockResolvedValue({ data: { allowed: false, reason } });
    expect(await inspectRequirementRunnerHandoff(requirement)).toEqual({ instanceId: 'original', skipReason: reason });
  });

  it.each([{ error: { message: 'db unavailable' } }, { data: null }])('fails closed on an unavailable admission check', async result => {
    mockRpc.mockResolvedValue(result);
    expect((await inspectRequirementRunnerHandoff(requirement)).skipReason).toBe('assistant_handoff_unavailable');
  });

  it('discovers the oldest legacy plan owner before a canonical runner', async () => {
    mockResults.push({ data: [{ instance_id: 'maintenance' }, { instance_id: 'original' }, { instance_id: 'duplicate' }] },
      { data: [{ id: 'duplicate', name: 'req-runner-req' }, { id: 'original', name: 'Crowdrage' }, { id: 'maintenance', name: 'req-maint-req' }] });
    mockRpc.mockResolvedValue({ data: { allowed: false, reason: 'assistant_action_not_finished' } });
    expect(await inspectRequirementRunnerHandoff({ id: 'req', site_id: 'site' })).toEqual({
      instanceId: 'original', skipReason: 'assistant_action_not_finished',
    });
    expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
    expect(query.eq).toHaveBeenCalledWith('metadata->>requirement_id', 'req');
  });

  it('does not replace a missing historical owner', async () => {
    mockResults.push({ data: [{ instance_id: 'deleted' }] }, { data: [] });
    expect(await inspectRequirementRunnerHandoff({ id: 'req', site_id: 'site' })).toEqual({ skipReason: 'original_instance_unavailable' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('allows canonical runner lookup when all known history belongs to maintenance', async () => {
    mockResults.push({ data: [{ instance_id: 'maintenance' }] },
      { data: [{ id: 'maintenance', name: 'req-maint-req' }] });
    expect(await inspectRequirementRunnerHandoff({ id: 'req', site_id: 'site' })).toEqual({});
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('keeps the existing unassigned cron creation path', async () => {
    expect(await inspectRequirementRunnerHandoff({ id: 'req', site_id: 'site' })).toEqual({});
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('atomic archived runner replacement receipts', () => {
  const replacementId = '00000000-0000-4000-8000-000000000002';
  const input = { requirementId: 'req', runId: 'lease', archivedInstanceId: 'original', executionGeneration: 6 };
  const metadata = { runner_instance_id: replacementId, requirement_execution_generation: 7, cron_attempts: 4 };
  beforeEach(() => jest.clearAllMocks());

  it.each(['replaced', 'duplicate'])('accepts a confirmed %s receipt without a second insert', async state => {
    mockRpc.mockResolvedValue({ data: { state, instance_id: replacementId, execution_generation: 7, metadata } });
    expect(await replaceArchivedRequirementRunner(input)).toEqual({ instanceId: replacementId, metadata });
    expect(mockRpc).toHaveBeenCalledWith('replace_archived_requirement_runner', {
      p_requirement_id: 'req', p_run_id: 'lease', p_expected_instance_id: 'original', p_expected_execution_generation: 6,
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { state: 'replaced', instance_id: replacementId, execution_generation: 6, metadata },
    { state: 'replaced', instance_id: replacementId, execution_generation: 7, metadata: { ...metadata, runner_instance_id: 'other' } },
    { state: 'replaced', instance_id: replacementId, execution_generation: 7, metadata: { ...metadata, requirement_execution_generation: 6 } },
  ])('fails closed on an inconsistent receipt', async data => {
    mockRpc.mockResolvedValue({ data });
    expect(await replaceArchivedRequirementRunner(input)).toEqual({ skipReason: 'archived_runner_replacement_unconfirmed' });
  });

  it('does not retry insertion when a database guard denies replacement', async () => {
    mockRpc.mockResolvedValue({ data: { state: 'guarded', reason: 'original_instance_active' } });
    expect(await replaceArchivedRequirementRunner(input)).toEqual({ skipReason: 'archived_runner_replacement_guarded' });
  });

  it.each([{ error: { code: 'PGRST202' } }, new Error('offline')])('does not bypass an unavailable RPC', async result => {
    if (result instanceof Error) mockRpc.mockRejectedValue(result);
    else mockRpc.mockResolvedValue(result);
    expect(await replaceArchivedRequirementRunner(input)).toEqual({ skipReason: 'archived_runner_replacement_unavailable' });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});