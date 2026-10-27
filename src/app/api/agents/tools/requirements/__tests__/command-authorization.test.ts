import { randomUUID } from 'node:crypto';

const rpc = jest.fn();
const update = jest.fn();
const get = jest.fn();
const reset = jest.fn();
let remote = false;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
jest.mock('@/lib/database/requirement-db', () => ({ getRequirementById: get, updateRequirement: update }));
jest.mock('@/lib/mcp/remote-client', () => ({ shouldUseRemoteApi: () => remote, invokeRemoteTool: jest.fn() }));
jest.mock('@/lib/services/requirement-cron-reset', () => ({ checkAndResetCronAttempts: reset }));
jest.mock('@/lib/services/requirement-flow-engine', () => ({ canCloseRequirement: jest.fn() }));
jest.mock('../create/core', () => ({ createRequirementCore: jest.fn() }));
jest.mock('../get/core', () => ({ getRequirementsCore: jest.fn() }));
import { requirementsTool } from '../assistantProtocol';
import { updateRequirementCore } from '../update/core';
import { submitRequirementCommand } from '@/lib/services/requirement-command';

const siteId = randomUUID(), userId = randomUUID(), instanceId = randomUUID(), actionId = randomUUID();
const requirementId = randomUUID(), runner = randomUUID();
const source = { siteId, userId, instanceId, actionId };
const requirement = { id: requirementId, site_id: siteId, status: 'on-review', metadata: { runner_instance_id: runner } };

beforeEach(() => {
  jest.clearAllMocks(); remote = false;
  get.mockResolvedValue(requirement);
  rpc.mockResolvedValue({ data: { state: 'queued', requirement, authorization_action_id: actionId, runner_instance_id: runner } });
});

it('queues a cross-session update with the host action and leaves the existing runner and current state untouched', async () => {
  const result = await requirementsTool(siteId, userId, instanceId, source).execute({
    action: 'update', requirement_id: requirementId, instructions: 'Preserve prior research. Add a marketplace ranking.',
    status: 'in-progress', completion_status: 'pending',
  });
  expect(rpc).toHaveBeenCalledWith('submit_requirement_command', {
    p_requirement_id: requirementId, p_site_id: siteId, p_user_id: userId, p_instance_id: instanceId,
    p_action_id: actionId, p_patch: { instructions: 'Preserve prior research. Add a marketplace ranking.', status: 'in-progress', completion_status: 'pending' },
  });
  expect(result).toMatchObject({ success: true, command: { state: 'queued', execution_started: false, runner_instance_id: runner } });
  expect(update).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled();
  expect(requirement.metadata.runner_instance_id).toBe(runner);
});

it('does not expose authorization IDs in the model schema or let supplied message/ID override the host', async () => {
  const tool = requirementsTool(siteId, userId, instanceId, source);
  expect(tool.parameters.properties).not.toHaveProperty('authorization_action_id');
  await tool.execute({ action: 'update', requirement_id: requirementId, instructions: 'New scope',
    authorization_action_id: randomUUID(), message: 'Fabricated authority' } as any);
  expect(rpc.mock.calls[0][1].p_action_id).toBe(actionId);
  expect(rpc.mock.calls[0][1].p_patch).not.toHaveProperty('message');
});

it.each([{ site_id: randomUUID() }, { user_id: randomUUID() }])('rejects forged tenant or actor before queuing', async overrides => {
  await expect(requirementsTool(siteId, userId, instanceId, source).execute({
    action: 'update', requirement_id: requirementId, instructions: 'Changed', ...overrides,
  })).rejects.toMatchObject({ status: 403 });
  expect(rpc).not.toHaveBeenCalled();
});

it('rejects an unavailable or foreign requirement', async () => {
  get.mockResolvedValue({ ...requirement, site_id: randomUUID() });
  await expect(updateRequirementCore({ requirement_id: requirementId, site_id: siteId, instructions: 'New' }, source)).rejects.toThrow('permiso');
  expect(rpc).not.toHaveBeenCalled();
});

it.each([{ metadata: { runner_instance_id: instanceId } }, { status: 'done' }, { completion_status: 'completed' }])(
  'does not allow interactive commands to change ownership or close work', async changes => {
    await expect(updateRequirementCore({ requirement_id: requirementId, site_id: siteId, instructions: 'New', ...changes }, source)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  },
);

it('accepts an idempotent duplicate without claiming a second execution', async () => {
  rpc.mockResolvedValue({ data: { state: 'duplicate', requirement, authorization_action_id: actionId, runner_instance_id: runner } });
  expect(await submitRequirementCommand(requirementId, { instructions: 'Same message' }, source))
    .toMatchObject({ command: { state: 'duplicate', execution_started: false } });
});

it.each([
  { error: { message: 'Permission denied' } },
  { data: { state: 'queued', requirement, authorization_action_id: randomUUID() } },
  { data: { state: 'queued', requirement: { ...requirement, site_id: randomUUID() }, authorization_action_id: actionId } },
])('fails closed on rejected or unverifiable receipts', async response => {
  rpc.mockResolvedValue(response);
  await expect(submitRequirementCommand(requirementId, { instructions: 'New' }, source)).rejects.toThrow();
});

it('never delegates message authorization as untrusted remote tool parameters', async () => {
  remote = true;
  await expect(updateRequirementCore({ requirement_id: requirementId, site_id: siteId, instructions: 'New' }, source)).rejects.toThrow('local execution context');
  expect(rpc).not.toHaveBeenCalled();
});

it('retains the direct update path for non-interactive execution without a user-action source', async () => {
  update.mockResolvedValue(requirement);
  await updateRequirementCore({ requirement_id: requirementId, site_id: siteId, instructions: 'Runner checkpoint' });
  expect(update).toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});

it('a read-only status query does not register a command', async () => {
  await requirementsTool(siteId, userId, instanceId, source).execute({ action: 'list', search: 'Research' });
  expect(rpc).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled();
});

it('instructs the assistant to report diagnostics without promising starts or resubmitting blindly', () => {
  const { description } = requirementsTool(siteId, userId, instanceId, source);
  expect(description).toContain('command.diagnostic');
  expect(description).toContain('command_diagnostic');
  expect(description).toContain('never promise queued work will start');
  expect(description).toContain('Never blindly resubmit a persisted command, even when retryable is true');
  expect(description).toContain('unavailable means diagnosis could not be checked');
});

it('allows explicitly requested budget cap removal and preserves the diagnostic receipt', async () => {
  const diagnostic = { state: 'queued', reason: 'runner_busy', retryable: true, checked_at: new Date().toISOString() };
  rpc.mockResolvedValueOnce({ data: { state: 'queued', requirement, authorization_action_id: actionId, runner_instance_id: runner } });
  rpc.mockResolvedValueOnce({ data: { [requirementId]: diagnostic } });
  const tool = requirementsTool(siteId, userId, instanceId, source);
  expect(tool.parameters.properties.budget.type).toEqual(['number', 'null']);
  expect(tool.parameters.properties.budget.description).toContain('only when the user explicitly requests');
  const result = await tool.execute({ action: 'update', requirement_id: requirementId, budget: null });
  expect(rpc).toHaveBeenNthCalledWith(1, 'submit_requirement_command', expect.objectContaining({ p_patch: { budget: null } }));
  expect(result).toMatchObject({ success: true, command: { execution_started: false, diagnostic } });
});

it.each([-1, NaN, Infinity, -Infinity])('rejects invalid budget %p before persistence or inspection', async budget => {
  await expect(submitRequirementCommand(requirementId, { budget }, source)).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});