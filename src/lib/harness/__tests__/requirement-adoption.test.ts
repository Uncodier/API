import { WORKSPACE_ISOLATION_VERSION } from '../workspace-process-guard';
import { randomBytes, randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { adoptRequirementWorkspace } from '../workspace';
jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));
const output = (stdout: string) => ({ cmdId: 'c', exitCode: 0, wait: async () => ({ exitCode: 0 }), kill: jest.fn(),
  logs: () => Object.assign((async function* () { yield { stream: 'stdout', data: stdout }; })(), { close() {} }) });
beforeEach(() => jest.resetAllMocks());

it('adopts an existing dirty repository without cloning, installing dependencies, resetting or switching branches', async () => {
  const url = new URL('https://git.example.invalid/team/project.git');
  const password = randomBytes(32).toString('hex'); url.username = 'git'; url.password = password;
  const vm = { name: 'legacy-workspace', status: 'running', tags: { harnessIsolation: WORKSPACE_ISOLATION_VERSION }, update: jest.fn().mockResolvedValue(undefined),
    runCommand: jest.fn().mockResolvedValueOnce(output(url.href)).mockResolvedValueOnce(output('')) };
  (Sandbox.get as jest.Mock).mockResolvedValue(vm);
  const input = { sessionId: randomUUID(), workspaceId: vm.name, repository: { url: 'https://git.example.invalid/team/project.git' }, assertActive: jest.fn(async () => {}) };
  const workspace = await adoptRequirementWorkspace(input);
  expect(workspace.ref.id).toBe(vm.name); expect(Sandbox.create).not.toHaveBeenCalled();
  expect(vm.runCommand).toHaveBeenCalledTimes(2);
  const commands = vm.runCommand.mock.calls.map(call => JSON.stringify(call[0]));
  expect(commands.join('\n')).not.toMatch(/git reset|git clone|git checkout|git switch|npm install/);
  expect(JSON.stringify(vm.update.mock.calls)).not.toContain(password);
  expect(input.assertActive).toHaveBeenCalled();
});
it.each(['foreign_session', 'missing_snapshot', 'wrong_repo'])('fails closed on %s without replacing the saved workspace', async kind => {
  const vm = { name: 'saved', status: kind === 'missing_snapshot' ? 'stopped' : 'running',
    tags: kind === 'foreign_session' ? { harnessSession: randomUUID() } : { harnessIsolation: WORKSPACE_ISOLATION_VERSION },
    update: jest.fn(), runCommand: jest.fn().mockResolvedValue(output('https://git.example.invalid/other/repo.git')) };
  (Sandbox.get as jest.Mock).mockResolvedValue(vm);
  await expect(adoptRequirementWorkspace({ sessionId: randomUUID(), workspaceId: vm.name,
    repository: { url: 'https://git.example.invalid/team/project.git' }, assertActive: async () => {} })).rejects.toThrow();
  expect(Sandbox.create).not.toHaveBeenCalled(); expect(vm.update).not.toHaveBeenCalled();
});

it('allows only the host-confirmed previous occurrence to transfer the same workspace to a recurring session', async () => {
  const previousSessionId = randomUUID(); const sessionId = randomUUID();
  const vm = { name: 'recurring', status: 'running', tags: { harnessIsolation: WORKSPACE_ISOLATION_VERSION, harnessSession: previousSessionId }, update: jest.fn().mockResolvedValue(undefined),
    runCommand: jest.fn().mockResolvedValueOnce(output('https://git.example.invalid/team/project.git')).mockResolvedValueOnce(output('')) };
  (Sandbox.get as jest.Mock).mockResolvedValue(vm);
  const workspace = await adoptRequirementWorkspace({ sessionId, previousSessionId, workspaceId: vm.name,
    repository: { url: 'https://git.example.invalid/team/project.git' }, assertActive: async () => {} });
  expect(workspace.ref.id).toBe(vm.name);
  expect(vm.update).toHaveBeenCalledWith(expect.objectContaining({ tags: expect.objectContaining({ harnessSession: sessionId }) }), expect.anything());
  expect(Sandbox.create).not.toHaveBeenCalled();
});