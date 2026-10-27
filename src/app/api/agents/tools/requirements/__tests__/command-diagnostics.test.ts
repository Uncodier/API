import { randomUUID } from 'node:crypto';

const rpc = jest.fn();
const getRequirements = jest.fn();
const invokeRemoteTool = jest.fn();
let remote = false;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
jest.mock('@/lib/database/requirement-db', () => ({ getRequirements }));
jest.mock('@/lib/mcp/remote-client', () => ({ shouldUseRemoteApi: () => remote, invokeRemoteTool }));
jest.mock('@/lib/timezone', () => ({ DATE_PERIODS: ['today', 'yesterday'], isLocalDateString: () => false }));

import { submitRequirementCommand } from '@/lib/services/requirement-command';
import { inspectRequirementCommands } from '@/lib/services/requirement-command-diagnostics';
import { getRequirementsCore } from '../get/core';

const siteId = randomUUID();
const requirementId = randomUUID();
const secondId = randomUUID();
const source = { siteId, userId: randomUUID(), instanceId: randomUUID(), actionId: randomUUID() };
const requirement = { id: requirementId, site_id: siteId, title: 'Persisted request' };
const secondRequirement = { id: secondId, site_id: siteId, title: 'Other request' };
const checkedAt = new Date().toISOString();
const blocked = { state: 'blocked', reason: 'explicit_pause', retryable: false, checked_at: checkedAt };
const queued = { state: 'queued', reason: 'runner_busy', retryable: true, checked_at: checkedAt };
const unavailable = { state: 'unavailable', reason: 'diagnostic_unavailable', retryable: false, checked_at: null };
const receipt = {
  state: 'queued', requirement, authorization_action_id: source.actionId, runner_instance_id: randomUUID(),
};

beforeEach(() => {
  jest.resetAllMocks();
  remote = false;
  getRequirements.mockResolvedValue({ requirements: [requirement, secondRequirement], total: 8, hasMore: true });
});

it.each([
  blocked, queued,
  { state: 'applied', reason: null, retryable: false, checked_at: checkedAt },
  { state: 'none', reason: null, retryable: false, checked_at: checkedAt },
])('attaches the read-only $state snapshot after persisting the update', async diagnostic => {
  rpc.mockResolvedValueOnce({ data: receipt, error: null });
  rpc.mockResolvedValueOnce({ data: { [requirementId]: diagnostic }, error: null });
  const result = await submitRequirementCommand(requirementId, { instructions: 'Preserve scope and add tests' }, source);
  expect(result).toMatchObject({ success: true, requirement, command: {
    state: 'queued', authorization_action_id: source.actionId, execution_started: false, diagnostic,
  } });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenNthCalledWith(1, 'submit_requirement_command', expect.objectContaining({ p_action_id: source.actionId }));
  expect(rpc).toHaveBeenNthCalledWith(2, 'inspect_requirement_commands', { p_requirement_ids: [requirementId], p_site_id: siteId });
  expect(result.command.message).toContain('does not guarantee execution or a start time');
  expect(result.command.message).toContain('retryable is not permission to resubmit');
});

it.each(['rpc-error', 'exception', 'missing-entry', 'malformed-entry'])('preserves persisted success with unavailable diagnostics on %s', async failure => {
  rpc.mockResolvedValueOnce({ data: receipt, error: null });
  if (failure === 'exception') rpc.mockRejectedValueOnce(new Error('Internal transport details'));
  else if (failure === 'rpc-error') rpc.mockResolvedValueOnce({ error: { message: 'Internal database details' }, data: null });
  else rpc.mockResolvedValueOnce({ data: failure === 'missing-entry' ? {} : { [requirementId]: { ...queued, retryable: 'true' } } });
  const result = await submitRequirementCommand(requirementId, { instructions: 'Persist these changes' }, source);
  expect(result).toMatchObject({ success: true, requirement, command: { state: 'queued', diagnostic: unavailable, execution_started: false } });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('Internal');
});

it('does not inspect an unverifiable persisted receipt', async () => {
  rpc.mockResolvedValueOnce({ data: { ...receipt, authorization_action_id: randomUUID() } });
  await expect(submitRequirementCommand(requirementId, { instructions: 'New scope' }, source)).rejects.toThrow('unverifiable');
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('inspects a list in one site-scoped batch while preserving rows and pagination', async () => {
  rpc.mockResolvedValue({ data: { [requirementId]: blocked, [secondId]: queued } });
  const result = await getRequirementsCore({ site_id: siteId, offset: 2, limit: 2 });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('inspect_requirement_commands', { p_requirement_ids: [requirementId, secondId], p_site_id: siteId });
  expect(result).toMatchObject({ success: true, data: {
    requirements: [{ ...requirement, command_diagnostic: blocked }, { ...secondRequirement, command_diagnostic: queued }],
    pagination: { total: 8, count: 2, offset: 2, limit: 2, has_more: true },
  } });
  expect(requirement).not.toHaveProperty('command_diagnostic');
});

it('does not fail a successful list when the diagnostic RPC is unavailable', async () => {
  rpc.mockRejectedValue(new Error('RPC unavailable'));
  const result = await getRequirementsCore({ site_id: siteId });
  expect(result).toMatchObject({ success: true, data: {
    requirements: [{ ...requirement, command_diagnostic: unavailable }, { ...secondRequirement, command_diagnostic: unavailable }],
    pagination: { total: 8, count: 2, has_more: true },
  } });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('keeps valid entries, defaults missing or invalid entries, strips extras and ignores unrequested IDs', async () => {
  const missingId = randomUUID(), extraId = randomUUID();
  rpc.mockResolvedValue({ data: {
    [requirementId]: { ...blocked, internal: 'not part of the diagnostic contract' },
    [secondId]: { ...queued, checked_at: 'not a timestamp' },
    [extraId]: queued,
  } });
  expect(await inspectRequirementCommands([requirementId, secondId, requirementId, missingId], siteId)).toEqual({
    [requirementId]: blocked, [secondId]: unavailable, [missingId]: unavailable,
  });
  expect(rpc).toHaveBeenCalledWith('inspect_requirement_commands', { p_requirement_ids: [requirementId, secondId, missingId], p_site_id: siteId });
});

it.each([null, [], 'unexpected', 42])('treats malformed bulk data %p as unavailable', async data => {
  rpc.mockResolvedValue({ data });
  expect(await inspectRequirementCommands([requirementId], siteId)).toEqual({ [requirementId]: unavailable });
});

it('skips inspection for empty lists', async () => {
  getRequirements.mockResolvedValue({ requirements: [], total: 0, hasMore: false });
  expect(await getRequirementsCore({ site_id: siteId })).toMatchObject({ success: true, data: { requirements: [] } });
  expect(rpc).not.toHaveBeenCalled();
});

it('leaves remote list inspection to the remote service without local database calls', async () => {
  remote = true;
  const response = { success: true, data: { requirements: [{ ...requirement, command_diagnostic: blocked }] } };
  invokeRemoteTool.mockResolvedValue(response);
  expect(await getRequirementsCore({ site_id: siteId })).toEqual(response);
  expect(rpc).not.toHaveBeenCalled();
  expect(getRequirements).not.toHaveBeenCalled();
});