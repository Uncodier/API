import { randomUUID } from 'node:crypto';

const create = jest.fn();
const update = jest.fn();
const get = jest.fn();
const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
jest.mock('@/lib/database/requirement-db', () => ({ createRequirement: create, updateRequirement: update, getRequirementById: get }));
jest.mock('@/lib/mcp/remote-client', () => ({ shouldUseRemoteApi: () => false, RemoteToolError: class extends Error {} }));
jest.mock('@/lib/services/requirement-cron-reset', () => ({ checkAndResetCronAttempts: jest.fn() }));
jest.mock('@/lib/services/requirement-flow-engine', () => ({ canCloseRequirement: jest.fn() }));
jest.mock('../get/core', () => ({ getRequirementsCore: jest.fn() }));

import { resolveRequirementEnvironment, resolveRequirementEnvironmentInput } from '@/lib/services/requirement-environment';
import { createRequirementCore } from '../create/core';
import { updateRequirementCore } from '../update/core';
import { requirementsTool } from '../assistantProtocol';
import { POST as createPost } from '../create/route';
import { POST as updatePost } from '../update/route';
import { NextRequest } from 'next/server';
import * as gitBinding from '@/lib/services/requirement-git-binding';
import * as gitSchema from '../git-binding-schema';

const siteId = randomUUID(), userId = randomUUID(), requirementId = randomUUID();
const source = { siteId, userId, instanceId: randomUUID(), actionId: randomUUID() };
const base = { id: requirementId, site_id: siteId, status: 'backlog', metadata: { execution_environment: 'cloud', note: 'keep' } };
const input = { site_id: siteId, user_id: userId, title: 'Build app', type: 'develop' };
const patch = { requirement_id: requirementId, site_id: siteId };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REQUIREMENT_GIT_STRICT;
  get.mockResolvedValue(base);
  create.mockImplementation(async params => ({ id: requirementId, ...params }));
  update.mockImplementation(async (_id, params) => ({ ...base, ...params, metadata: { ...base.metadata, ...params.metadata } }));
  rpc.mockResolvedValue({ data: { state: 'queued', requirement: base, authorization_action_id: source.actionId } });
});

it.each([undefined, null, {}, { type: 'content', title: 'cloud document', git: { kind: 'automation' } }])('defaults only legacy absence to workspace: %p', metadata => {
  expect(resolveRequirementEnvironment(metadata)).toBe('workspace');
});

it.each(['cloud', 'workspace'] as const)('uses persisted %s regardless of titles, types or bindings', mode => {
  expect(resolveRequirementEnvironment({ execution_environment: mode, type: 'develop', title: 'Research', git: { kind: 'applications' } })).toBe(mode);
  expect(resolveRequirementEnvironmentInput({}, mode)).toBe(mode);
});

it.each([null, undefined, '', 'Cloud', 'sandbox', false, 1, {}, []])('fails closed on explicitly invalid mode %p', value => {
  expect(() => resolveRequirementEnvironment({ execution_environment: value })).toThrow('execution_environment');
});

it.each(['cloud', [], 42, false])('fails closed on malformed metadata %p', metadata => {
  expect(() => resolveRequirementEnvironment(metadata)).toThrow();
});

it('persists first-class mode and preserves unrelated metadata', async () => {
  const result = await createRequirementCore({ ...input, execution_environment: 'cloud', metadata: { note: 'keep' } });
  expect(result.requirement.metadata).toMatchObject({ execution_environment: 'cloud', note: 'keep' });
  expect(create.mock.calls[0][0]).not.toHaveProperty('execution_environment');
});

it('never resolves or verifies an app Git binding for cloud, even with strict Git enabled', async () => {
  process.env.REQUIREMENT_GIT_STRICT = 'true';
  const defaults = jest.spyOn(gitBinding, 'resolveDefaultGitBinding');
  const verify = jest.spyOn(gitSchema, 'verifyGitBindingReachable');
  try {
    const result = await createRequirementCore({ ...input, execution_environment: 'cloud' });
    expect(result.requirement.metadata).not.toHaveProperty('git');
    expect(defaults).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  } finally {
    defaults.mockRestore(); verify.mockRestore();
    delete process.env.REQUIREMENT_GIT_STRICT;
  }
});

it('rejects app Git injection on cloud create and both update paths', async () => {
  const metadata = { git: { repo: 'app-repo' } };
  await expect(createRequirementCore({ ...input, execution_environment: 'cloud', metadata })).rejects.toThrow('workspace-only');
  await expect(updateRequirementCore({ ...patch, metadata })).rejects.toThrow('workspace-only');
  await expect(updateRequirementCore({ ...patch, metadata }, source)).rejects.toThrow('workspace-only');
  expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});

it('accepts metadata mode for API callers and explicitly persists workspace for absent legacy input', async () => {
  expect((await createRequirementCore({ ...input, metadata: { execution_environment: 'cloud' } })).requirement.metadata.execution_environment).toBe('cloud');
  expect((await createRequirementCore(input)).requirement.metadata.execution_environment).toBe('workspace');
});

it('rejects conflicting metadata instead of letting it override first-class mode', async () => {
  await expect(createRequirementCore({ ...input, execution_environment: 'workspace', metadata: { execution_environment: 'cloud' } })).rejects.toThrow('conflicts');
  await expect(updateRequirementCore({ ...patch, execution_environment: 'cloud', metadata: { execution_environment: 'workspace' } })).rejects.toThrow('conflicts');
  expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});

it.each([{ execution_environment: 'invalid' }, { metadata: { execution_environment: null } }])('rejects invalid API input %p', async invalid => {
  await expect(createRequirementCore({ ...input, ...invalid })).rejects.toThrow();
  await expect(updateRequirementCore({ ...patch, ...invalid })).rejects.toThrow();
  expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});

it('requires a first-class explicit model choice even when metadata specifies a mode', async () => {
  const tool = requirementsTool(siteId, userId);
  for (const metadata of [undefined, { execution_environment: 'cloud' }]) {
    await expect(tool.execute({ action: 'create', title: 'Research', metadata })).rejects.toThrow('execution_environment');
  }
  await tool.execute({ action: 'create', title: 'Research', execution_environment: 'cloud' });
  expect(create).toHaveBeenCalledTimes(1);
  expect(tool.parameters.properties.execution_environment.enum).toEqual(['cloud', 'workspace']);
  expect(tool.description).toContain('Never guess');
});

it.each([undefined, source])('rejects mode switches before direct writes or command submission (%p)', async commandSource => {
  for (const changes of [{ execution_environment: 'workspace' }, { metadata: { execution_environment: 'workspace' } }]) {
    await expect(updateRequirementCore({ ...patch, instructions: 'Changed', ...changes }, commandSource)).rejects.toMatchObject({ status: 409 });
  }
  expect(update).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});

it('legacy workspace mode is immutable even before execution starts', async () => {
  get.mockResolvedValue({ ...base, metadata: {} });
  await expect(updateRequirementCore({ ...patch, execution_environment: 'cloud' })).rejects.toThrow('immutable');
});

it('preserves environment on unrelated changes and strips same-mode assertions from direct patches', async () => {
  const result = await updateRequirementCore({ ...patch, execution_environment: 'cloud', metadata: { execution_environment: 'cloud', note: 'changed' } });
  expect(result.requirement.metadata).toEqual({ execution_environment: 'cloud', note: 'changed' });
  expect(update).toHaveBeenCalledWith(requirementId, { metadata: { note: 'changed' } });
});

it('queues same-mode first-class assertions without an unsupported mode field, and still rejects interactive metadata', async () => {
  await updateRequirementCore({ ...patch, execution_environment: 'cloud', instructions: 'Changed' }, source);
  expect(rpc).toHaveBeenNthCalledWith(1, 'submit_requirement_command', expect.objectContaining({ p_patch: { instructions: 'Changed' } }));
  rpc.mockClear();
  await expect(updateRequirementCore({ ...patch, metadata: { execution_environment: 'cloud' }, instructions: 'Changed' }, source)).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});

it('invalid stored modes cannot silently fall back during update', async () => {
  get.mockResolvedValue({ ...base, metadata: { execution_environment: 'invalid' } });
  await expect(updateRequirementCore({ ...patch, instructions: 'Changed' })).rejects.toThrow('execution_environment');
  expect(update).not.toHaveBeenCalled();
});

it('HTTP routes report bad choices/conflicts as 400 and mode changes as 409', async () => {
  const request = (body: unknown) => new NextRequest('https://requirements.test/api', { method: 'POST', body: JSON.stringify(body) });
  expect((await createPost(request({ ...input, execution_environment: 'invalid' }))).status).toBe(400);
  expect((await createPost(request({ ...input, execution_environment: 'workspace', metadata: { execution_environment: 'cloud' } }))).status).toBe(400);
  expect((await updatePost(request({ ...patch, execution_environment: 'workspace' }))).status).toBe(409);
});