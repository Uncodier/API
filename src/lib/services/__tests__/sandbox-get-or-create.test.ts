import { randomBytes } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { getOrCreateRequirementSandbox } from '../sandbox-get-or-create';
import { cloneRepoIntoWorkDir } from '../sandbox-git-clone';
import { resumeRequirementWorkspace } from '../sandbox-on-resume';
import { isMissingSandboxSnapshotError, isSandboxNotFoundError, retireSandboxWithoutSnapshots } from '../sandbox-missing-snapshot';

jest.mock('@vercel/sandbox', () => ({ Sandbox: { getOrCreate: jest.fn(), get: jest.fn(), create: jest.fn() } }));
jest.mock('../sandbox-git-clone', () => ({ cloneRepoIntoWorkDir: jest.fn() }));
jest.mock('../sandbox-git-layout', () => ({ assertPlatformGitLayout: jest.fn() }));
jest.mock('../sandbox-on-resume', () => ({ resumeRequirementWorkspace: jest.fn() }));
jest.mock('../sandbox-create-params', () => ({ buildSandboxCreateParams: (params: unknown) => params }));
jest.mock('../cron-audit-log', () => ({ logCronInfrastructureEvent: jest.fn() }));
jest.mock('../sandbox-missing-snapshot', () => ({
  isMissingSandboxSnapshotError: jest.fn(), isSandboxNotFoundError: jest.fn(), retireSandboxWithoutSnapshots: jest.fn(),
}));

describe('getOrCreateRequirementSandbox', () => {
  const sandbox = { name: 'req-21c35450-abcd1234', resume: jest.fn() };
  const missing = new Error('not found');
  const assertOwnership = jest.fn();
  const authenticatedUrl = new URL('https://repository.example.test/org/repo.git');
  authenticatedUrl.username = 'x-access-token';
  authenticatedUrl.password = randomBytes(24).toString('hex');
  const params = {
    name: sandbox.name, tags: { kind: 'requirement' }, authRepoUrl: authenticatedUrl.href,
    requirementId: '21c35450-abcd-4123-abcd-0123456789ab',
    assertRecoveryOwnership: assertOwnership,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    (Sandbox.get as jest.Mock).mockRejectedValue(missing);
    (Sandbox.create as jest.Mock).mockResolvedValue(sandbox);
    (isSandboxNotFoundError as jest.Mock).mockImplementation(error => error === missing);
    sandbox.resume.mockResolvedValue(undefined);
    assertOwnership.mockResolvedValue(undefined);
  });

  it('clones into WORK_DIR on create via onCreate', async () => {
    await expect(getOrCreateRequirementSandbox(params)).resolves.toEqual({ sandbox, created: true });
    expect(cloneRepoIntoWorkDir).toHaveBeenCalledWith(sandbox, authenticatedUrl.href);
    expect(retireSandboxWithoutSnapshots).not.toHaveBeenCalled();
  });

  it('returns an existing VM after resume without cloning', async () => {
    (Sandbox.get as jest.Mock).mockResolvedValue(sandbox);
    await expect(getOrCreateRequirementSandbox(params)).resolves.toEqual({ sandbox, created: false });
    expect(resumeRequirementWorkspace).toHaveBeenCalled();
    expect(resumeRequirementWorkspace).toHaveBeenCalledWith(sandbox, undefined, expect.objectContaining({ syncToOrigin: false }));
    expect(cloneRepoIntoWorkDir).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'authentication denied', 'duplicate name', 'generic 404', 'generic 410'])(
    'preserves %s without falling through to another create', async message => {
      const error = new Error(message);
      (Sandbox.get as jest.Mock).mockRejectedValue(error);
      await expect(getOrCreateRequirementSandbox(params)).rejects.toBe(error);
      expect(Sandbox.get).toHaveBeenCalledTimes(1);
      expect(Sandbox.getOrCreate).not.toHaveBeenCalled();
      expect(Sandbox.create).not.toHaveBeenCalled();
      expect(retireSandboxWithoutSnapshots).not.toHaveBeenCalled();
    },
  );

  it('recovers only the exact missing-snapshot case with explicit ownership', async () => {
    (isMissingSandboxSnapshotError as jest.Mock).mockReturnValue(true);
    (Sandbox.get as jest.Mock).mockRejectedValueOnce(new Error('verified missing snapshot'));
    await expect(getOrCreateRequirementSandbox(params)).resolves.toEqual({ sandbox, created: true });
    expect(retireSandboxWithoutSnapshots).toHaveBeenCalledWith(sandbox.name, assertOwnership);
    expect(Sandbox.get).toHaveBeenCalledTimes(2);
    expect(Sandbox.create).toHaveBeenCalledTimes(1);
    expect(Sandbox.getOrCreate).not.toHaveBeenCalled();
  });

  it('does not retire without host ownership authorization', async () => {
    const error = new Error('missing snapshot');
    (isMissingSandboxSnapshotError as jest.Mock).mockReturnValue(true);
    (Sandbox.get as jest.Mock).mockRejectedValue(error);
    await expect(getOrCreateRequirementSandbox({ ...params, assertRecoveryOwnership: undefined })).rejects.toBe(error);
    expect(retireSandboxWithoutSnapshots).not.toHaveBeenCalled();
  });

  it('never treats a clone/layout callback failure as lost VM data', async () => {
    const error = new Error('callback failed');
    (isMissingSandboxSnapshotError as jest.Mock).mockReturnValue(true);
    (cloneRepoIntoWorkDir as jest.Mock).mockRejectedValue(error);
    await expect(getOrCreateRequirementSandbox(params)).rejects.toBe(error);
    expect(retireSandboxWithoutSnapshots).not.toHaveBeenCalled();
    expect(Sandbox.get).toHaveBeenCalledTimes(1);
  });

  it('propagates refusal without retrying creation', async () => {
    (isMissingSandboxSnapshotError as jest.Mock).mockReturnValue(true);
    (Sandbox.get as jest.Mock).mockRejectedValue(new Error('missing snapshot'));
    (retireSandboxWithoutSnapshots as jest.Mock).mockRejectedValue(new Error('active session'));
    await expect(getOrCreateRequirementSandbox(params)).rejects.toThrow('active session');
    expect(Sandbox.get).toHaveBeenCalledTimes(1);
  });

  it('bounds recovery to one retry', async () => {
    const error = new Error('still missing');
    (isMissingSandboxSnapshotError as jest.Mock).mockReturnValue(true);
    (Sandbox.get as jest.Mock).mockRejectedValue(error);
    await expect(getOrCreateRequirementSandbox(params)).rejects.toBe(error);
    expect(retireSandboxWithoutSnapshots).toHaveBeenCalledTimes(1);
    expect(Sandbox.get).toHaveBeenCalledTimes(2);
  });
});
