const mockResume = jest.fn();
const mockMigrations = jest.fn();
const results: any[] = [];
const query: any = {};
for (const method of ['select', 'eq', 'order', 'limit']) query[method] = jest.fn(() => query);
query.maybeSingle = jest.fn(async () => results.shift());
const mockFrom = jest.fn(() => query);
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: mockFrom } }));
jest.mock('@/lib/services/requirement-execution-recovery', () => ({ resumeRequirementExecutionOnUserAction: mockResume }));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ listMigrationLifecycle: mockMigrations }));
import { activateCodingAgentsTool } from '../assistantProtocol';

const run = () => activateCodingAgentsTool('site', 'original').execute({ requirement_id: 'req' });
function owner(ownerId: string | null = 'original') {
  results.push({ data: { id: 'req', status: 'blocked', metadata: { runner_instance_id: ownerId } } });
}
function action(details = { requirement_id: 'req', status: 'running' }) {
  results.push({ data: { id: 'original', is_archived: false } }, { data: { id: 'user-action', details } });
}
describe('single-owner coding agent activation', () => {
  beforeEach(() => {
    jest.clearAllMocks(); results.length = 0;
    mockMigrations.mockResolvedValue([]);
    mockResume.mockResolvedValue({ state: 'applied', plans_updated: 1 });
  });
  it('only resumes the original with a trusted scoped user action', async () => {
    owner(); action();
    expect(await run()).toMatchObject({ success: true, owner_instance_id: 'original', activated_instances: 0, activated_plans: 1 });
    expect(mockResume).toHaveBeenCalledWith('req', 'original', true, 'user-action');
    expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
    expect(query.eq).toHaveBeenCalledWith('trusted_user_action', true);
    expect(query.eq).not.toHaveBeenCalledWith('name', expect.anything());
  });
  it.each(['other', null])('does not wake named runner/maintenance or steal owner %s', async ownerId => {
    owner(ownerId);
    expect(await run()).toMatchObject({ success: false, activated_instances: 0 });
    expect(mockResume).not.toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it.each([{ requirement_id: 'other', status: 'running' }, { requirement_id: 'req', status: 'stopped' }])('rejects unscoped or inactive user actions', async details => {
    owner(); action(details);
    expect(await run()).toMatchObject({ success: false, reason: 'trusted_requirement_action_required' });
    expect(mockResume).not.toHaveBeenCalled();
  });
  it('preserves platform/migration review holds', async () => {
    owner(); action(); mockMigrations.mockResolvedValue([{ state: 'platform_review' }]);
    expect(await run()).toMatchObject({ success: false, reason: 'migration_review_pending' });
    expect(mockResume).not.toHaveBeenCalled();
  });
  it('can resume operator-transferred history only with the usual trusted action', async () => {
    owner(); action(); mockMigrations.mockResolvedValue([{ state: 'transferred' }]);
    expect(await run()).toMatchObject({ success: true });
    expect(mockResume).toHaveBeenCalledWith('req', 'original', true, 'user-action');
  });
  it('does not turn a guarded recovery into a success', async () => {
    owner(); action(); mockResume.mockResolvedValue({ state: 'guarded', plans_updated: 0 });
    expect(await run()).toMatchObject({ success: false, reason: 'recovery_guarded' });
  });
  it('rejects inaccessible requirements before any mutation', async () => {
    results.push({ data: null });
    await expect(run()).rejects.toThrow('unavailable in this site');
    expect(mockResume).not.toHaveBeenCalled();
  });
});