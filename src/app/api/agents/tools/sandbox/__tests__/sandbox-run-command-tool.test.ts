const mockRunCommand = jest.fn();
const mockCaptureFingerprint = jest.fn();
const mockPersistReceipt = jest.fn();

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: {
    WORK_DIR: '/vercel/sandbox',
    runCommandInSandbox: mockRunCommand,
  },
}));
jest.mock('../sandbox-test-receipt', () => ({
  isSandboxTestCommand: (command: string) => command.includes('test'),
  captureSandboxTestFingerprint: mockCaptureFingerprint,
  persistSandboxTestReceipt: mockPersistReceipt,
}));

import { createSandboxRunCommandTool } from '../sandbox-run-command-tool';

const dependencies = {
  liveSandbox: (sandbox: any) => sandbox,
  resolvePath: (cwd: string | undefined, fallback: string) => cwd || fallback,
  deductCredits: jest.fn().mockResolvedValue({ success: true }),
};

describe('sandbox run command tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'PASS',
      stderr: '',
    });
    mockCaptureFingerprint.mockResolvedValue('a'.repeat(64));
    mockPersistReceipt.mockResolvedValue(undefined);
  });

  it('persists a successful direct test receipt', async () => {
    const sandbox = {};
    const tool = createSandboxRunCommandTool(
      sandbox as any,
      {
        active_step_id: 'step-1',
        backlog_item_id: 'item-1',
      },
      'req-1',
      dependencies,
    );

    await tool.execute({
      command: 'npm',
      args: ['test', '--', 'unit.test.ts'],
    });

    expect(mockPersistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      requirementId: 'req-1',
      backlogItemId: 'item-1',
      stepId: 'step-1',
      command: 'npm test -- unit.test.ts',
      exitCode: 0,
      ranAfterChanges: true,
    }));
  });

  it('keeps scaffolding commands blocked', async () => {
    const tool = createSandboxRunCommandTool(
      {} as any,
      undefined,
      undefined,
      dependencies,
    );

    await expect(tool.execute({
      command: 'npx create-next-app',
    })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('Scaffolding commands are forbidden'),
    });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});
