import { createHash, randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { openWorkspace, adoptRequirementWorkspace } from '../workspace';
import { WORKSPACE_ISOLATION_VERSION, WORKSPACE_ROOT_INIT } from '../workspace-process-guard';
jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));
beforeEach(() => jest.resetAllMocks());

it('rejects old workspaces before policy updates or commands without resetting their files', async () => {
  const sessionId = randomUUID(), repository = { url: 'https://repo.example.invalid/project.git' };
  const sandbox = { name: `h-${sessionId}`, persistent: true, status: 'running',
    tags: { harnessSession: sessionId, harnessRepository: createHash('sha256').update(JSON.stringify([repository.url, null])).digest('hex') },
    runCommand: jest.fn(), update: jest.fn() };
  (Sandbox.get as jest.Mock).mockResolvedValue(sandbox);
  await expect(openWorkspace({ sessionId, repository })).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION_REQUIRED' });
  await expect(adoptRequirementWorkspace({ sessionId, repository, workspaceId: sandbox.name, assertActive: async () => {} }))
    .rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION_REQUIRED' });
  expect(sandbox.update).not.toHaveBeenCalled(); expect(sandbox.runCommand).not.toHaveBeenCalled();
  expect(Sandbox.create).not.toHaveBeenCalled();
});

it('does not mark failed initialization as isolated or attempt repository bootstrap', async () => {
  (Sandbox.get as jest.Mock).mockRejectedValue({ response: { status: 404 } });
  const sandbox = { runCommand: jest.fn().mockResolvedValue({ exitCode: 73 }), update: jest.fn() };
  (Sandbox.create as jest.Mock).mockResolvedValue(sandbox);
  await expect(openWorkspace({ sessionId: randomUUID(), repository: { url: 'https://repo.example.invalid/project.git' } }))
    .rejects.toMatchObject({ code: 'WORKSPACE_NOT_READY' });
  expect((Sandbox.create as jest.Mock).mock.calls[0][0].tags.harnessIsolation).toBeUndefined();
  expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
  expect(sandbox.runCommand.mock.calls[0][0].args).toContain(WORKSPACE_ROOT_INIT);
  expect(sandbox.update).not.toHaveBeenCalled();
});

it('requires a versioned host receipt, not a truthy arbitrary isolation tag', async () => {
  expect(WORKSPACE_ISOLATION_VERSION).toBe('ipv4-process-v1');
  (Sandbox.get as jest.Mock).mockResolvedValue({ tags: { harnessIsolation: 'true' }, status: 'running' });
  await expect(adoptRequirementWorkspace({ sessionId: randomUUID(), repository: { url: 'https://repo.example.invalid/project.git' },
    workspaceId: 'prior', assertActive: async () => {} })).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION_REQUIRED' });
});