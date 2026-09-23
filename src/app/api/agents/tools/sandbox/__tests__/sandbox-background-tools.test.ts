const mockRunCommandInSandbox = jest.fn();

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: {
    WORK_DIR: '/vercel/sandbox',
    runCommandInSandbox: mockRunCommandInSandbox,
  },
}));

import {
  createSandboxCheckBackgroundCommandTool,
  createSandboxStartBackgroundCommandTool,
} from '../sandbox-background-tools';

const dependencies = {
  liveSandbox: (sandbox: any) => sandbox,
  resolvePath: (cwd: string | undefined, fallback: string) => cwd || fallback,
  deductCredits: jest.fn().mockResolvedValue({ success: true }),
  isTestCommand: (command: string) => command.includes('test'),
  captureTestFingerprint: jest.fn().mockResolvedValue(undefined),
};

describe('sandbox background tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the SDK v3 detached command id', async () => {
    const sandbox = {
      runCommand: jest.fn().mockResolvedValue({ id: 'command-1' }),
      writeFiles: jest.fn().mockResolvedValue(undefined),
    };
    const tool = createSandboxStartBackgroundCommandTool(
      sandbox as any,
      undefined,
      dependencies,
    );

    await expect(
      tool.execute({ command: 'npm test' }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        pid: 'command-1',
        command_id: 'command-1',
      }),
    );
    expect(mockRunCommandInSandbox).not.toHaveBeenCalled();
    expect(sandbox.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining([
        expect.stringContaining('.exit'),
      ]),
      timeoutMs: expect.any(Number),
    }));
  });

  it('checks a detached command before falling back to a process id', async () => {
    const sandbox = {
      getCommand: jest.fn().mockResolvedValue({ exitCode: null }),
    };
    mockRunCommandInSandbox.mockResolvedValue({ stdout: 'still running' });
    const tool = createSandboxCheckBackgroundCommandTool(
      sandbox as any,
      undefined,
      dependencies,
    );

    await expect(
      tool.execute({
        pid: 'command-1',
        command_id: 'command-1',
        log_file: '/tmp/command.log',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'RUNNING',
        is_running: true,
      }),
    );
  });

  it('returns the detached process exit code for evidence capture', async () => {
    const sandbox = {
      getCommand: jest.fn().mockResolvedValue({ exitCode: 1 }),
    };
    mockRunCommandInSandbox.mockResolvedValue({ stdout: 'FAIL test suite' });
    const tool = createSandboxCheckBackgroundCommandTool(
      sandbox as any,
      undefined,
      dependencies,
    );

    await expect(tool.execute({
      pid: 'command-1',
      command_id: 'command-1',
      log_file: '/tmp/command.log',
    })).resolves.toEqual(expect.objectContaining({
      status: 'STOPPED',
      is_running: false,
      exit_code: 1,
      recent_output: 'FAIL test suite',
    }));
  });

  it('persists a completed test only when the workspace is unchanged', async () => {
    const fingerprint = 'a'.repeat(64);
    const persistCompletedTest = jest.fn().mockResolvedValue(undefined);
    const sandbox = {
      getCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
      fs: {
        readFile: jest.fn(async (path: string) =>
          path.endsWith('.command') ? 'npm test' : fingerprint
        ),
      },
    };
    mockRunCommandInSandbox.mockResolvedValue({ stdout: 'PASS suite' });
    const tool = createSandboxCheckBackgroundCommandTool(
      sandbox as any,
      undefined,
      {
        ...dependencies,
        isTestCommand: () => true,
        captureTestFingerprint: jest.fn().mockResolvedValue(fingerprint),
        persistCompletedTest,
      },
    );

    await tool.execute({
      pid: 'command-1',
      command_id: 'command-1',
      log_file: '/tmp/command.log',
    });

    expect(persistCompletedTest).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm test',
      exitCode: 0,
      output: 'PASS suite',
      workspaceFingerprint: fingerprint,
      ranAfterChanges: true,
    }));
  });
});
