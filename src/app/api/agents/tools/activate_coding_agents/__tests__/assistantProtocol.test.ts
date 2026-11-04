import { randomUUID } from 'node:crypto';

const mockMigrations = jest.fn();
const results: any[] = [];
const query: any = {};
for (const method of ['select', 'eq']) query[method] = jest.fn(() => query);
query.maybeSingle = jest.fn(async () => results.shift());
const mockFrom = jest.fn((_table: string) => query);
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: mockFrom } }));
jest.mock('@/lib/services/requirement-command', () => ({ submitRequirementCommand: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ listMigrationLifecycle: mockMigrations }));
import { activateCodingAgentsTool } from '../assistantProtocol';
import { submitRequirementCommand } from '@/lib/services/requirement-command';

const source = { siteId: randomUUID(), instanceId: randomUUID(), userId: randomUUID(), actionId: randomUUID() };
const requirementId = randomUUID();
const run = () => activateCodingAgentsTool(source.siteId, source.instanceId, source).execute({ requirement_id: requirementId });
const command = { state: 'queued', authorization_action_id: source.actionId, execution_started: false,
  diagnostic: { state: 'queued', reason: 'action_unfinished' } };
function owner(ownerId: string | null = source.instanceId, status = 'blocked') {
  results.push({ data: { id: requirementId, status, metadata: { runner_instance_id: ownerId } } });
}
function available() { results.push({ data: { id: source.instanceId, is_archived: false } }); }

beforeEach(() => {
  jest.clearAllMocks(); results.length = 0;
  mockMigrations.mockResolvedValue([]);
  jest.mocked(submitRequirementCommand).mockResolvedValue({ success: true, command } as any);
});

it('queues an owner retry using the exact host action, without requiring details.requirement_id', async () => {
  owner(); available();
  expect(await run()).toMatchObject({ success: true, owner_instance_id: source.instanceId,
    activated_instances: 0, activated_plans: 0, requirement_unblocked: false, execution_started: false, command });
  expect(submitRequirementCommand).toHaveBeenCalledWith(requirementId,
    { status: 'in-progress', completion_status: 'pending' }, source);
  expect(mockFrom.mock.calls.map(call => call[0])).toEqual(['requirements', 'remote_instances']);
});

it.each([randomUUID(), null])('does not steal another or missing owner %s', async ownerId => {
  owner(ownerId);
  expect(await run()).toMatchObject({ success: false, activated_instances: 0 });
  expect(submitRequirementCommand).not.toHaveBeenCalled();
});

it('does not infer authority from model fields or the latest user log when host identity is absent', async () => {
  owner();
  expect(await activateCodingAgentsTool(source.siteId, source.instanceId).execute({ requirement_id: requirementId,
    action_id: source.actionId, user_id: source.userId, commandSource: source } as any))
    .toMatchObject({ success: false, reason: 'trusted_requirement_action_required' });
  expect(submitRequirementCommand).not.toHaveBeenCalled();
  expect(mockFrom).toHaveBeenCalledTimes(1);
});

it.each(['siteId', 'instanceId'] as const)('rejects a mismatched host %s', async key => {
  owner();
  expect(await activateCodingAgentsTool(source.siteId, source.instanceId, { ...source, [key]: randomUUID() })
    .execute({ requirement_id: requirementId })).toMatchObject({ reason: 'trusted_requirement_action_required' });
  expect(submitRequirementCommand).not.toHaveBeenCalled();
});

it.each(['done', 'cancelled', 'canceled'])('does not reopen terminal work %s', async status => {
  owner(source.instanceId, status);
  expect(await run()).toMatchObject({ success: false, reason: 'requirement_terminal' });
  expect(submitRequirementCommand).not.toHaveBeenCalled();
});

it('preserves migration review holds', async () => {
  owner(); available(); mockMigrations.mockResolvedValue([{ state: 'platform_review' }]);
  expect(await run()).toMatchObject({ success: false, reason: 'migration_review_pending' });
  expect(submitRequirementCommand).not.toHaveBeenCalled();
});

it('allows transferred migration history without bypassing the queue', async () => {
  owner(); available(); mockMigrations.mockResolvedValue([{ state: 'transferred' }]);
  expect(await run()).toMatchObject({ success: true, execution_started: false });
  expect(submitRequirementCommand).toHaveBeenCalledTimes(1);
});

it.each(['queued', 'duplicate'])('reports %s admission without pretending plans were resumed', async state => {
  owner(); available();
  jest.mocked(submitRequirementCommand).mockResolvedValue({ success: true,
    command: { ...command, state, diagnostic: { state: 'blocked', reason: 'user_paused' } } } as any);
  expect(await run()).toMatchObject({ success: true, activated_plans: 0, requirement_unblocked: false,
    command: { state, diagnostic: { state: 'blocked', reason: 'user_paused' } } });
});

it('does not turn failed authorization or queue admission into success', async () => {
  owner(); available();
  jest.mocked(submitRequirementCommand).mockRejectedValue(new Error('Command authorization denied'));
  await expect(run()).rejects.toThrow('authorization denied');
});

it('rejects inaccessible requirements before any mutation', async () => {
  results.push({ data: null });
  await expect(run()).rejects.toThrow('unavailable');
  expect(submitRequirementCommand).not.toHaveBeenCalled();
});

it('rejects an archived original instance', async () => {
  owner(); results.push({ data: { id: source.instanceId, is_archived: true } });
  expect(await run()).toMatchObject({ reason: 'original_instance_unavailable' });
  expect(submitRequirementCommand).not.toHaveBeenCalled();
});

it('captures identity instead of retaining a mutable caller-owned object', async () => {
  owner(); available();
  const mutable = { ...source };
  const tool = activateCodingAgentsTool(source.siteId, source.instanceId, mutable);
  mutable.actionId = randomUUID();
  await tool.execute({ requirement_id: requirementId });
  expect(submitRequirementCommand).toHaveBeenCalledWith(requirementId, expect.anything(), source);
  expect(JSON.stringify(tool.parameters)).not.toContain(source.actionId);
});