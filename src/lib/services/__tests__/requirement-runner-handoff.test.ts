const mockRpc = jest.fn();
const mockResults: any[] = [];
const query: any = {};
for (const method of ['select', 'eq', 'in', 'order']) query[method] = jest.fn(() => query);
query.then = (resolve: any) => resolve(mockResults.shift() || { data: [], error: null });
const mockFrom = jest.fn(() => query);
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: mockFrom, rpc: mockRpc },
}));
import { inspectRequirementRunnerHandoff } from '../requirement-runner-handoff';

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