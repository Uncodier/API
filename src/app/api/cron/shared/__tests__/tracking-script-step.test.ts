import { getSandboxHandle } from '@/lib/services/sandbox-sdk';
import { provisionTrackingScriptStep } from '../tracking-script-step';

jest.mock('@/lib/services/sandbox-sdk', () => ({
  getSandboxHandle: jest.fn(),
}));
jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: { GIT_WORKSPACE_READY: 'git_workspace_ready' },
  logCronInfrastructureEvent: jest.fn().mockResolvedValue(undefined),
}));

function commandResult(stdout: string, exitCode = 0) {
  return {
    exitCode,
    stdout: jest.fn().mockResolvedValue(stdout),
    stderr: jest.fn().mockResolvedValue(''),
  };
}

describe('tracking script provisioning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks a newly injected tracking script as harness-owned', async () => {
    const layout = [
      'export default function Layout({ children }) {',
      '  return <html><body>{children}</body></html>;',
      '}',
    ].join('\n');
    const runCommand = jest.fn()
      .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
      .mockResolvedValueOnce(commandResult(layout))
      .mockResolvedValueOnce(commandResult(''));
    const writeFiles = jest.fn().mockResolvedValue(undefined);
    const rm = jest.fn().mockResolvedValue(undefined);
    (getSandboxHandle as jest.Mock).mockResolvedValue({
      runCommand,
      writeFiles,
      fs: { rm },
    });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      siteId: 'site-1',
    })).resolves.toEqual({ injected: true });

    expect(writeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/vercel/sandbox/src/app/layout.tsx',
          content: expect.stringContaining(
            'data-uncodie-harness="tracking"',
          ),
        }),
      ]),
    );
  });

  it('rolls back when the transformed TSX does not parse', async () => {
    const layout = '<html><body>content</body></html>';
    const runCommand = jest.fn()
      .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
      .mockResolvedValueOnce(commandResult(layout))
      .mockResolvedValueOnce(commandResult('', 1));
    const writeFiles = jest.fn().mockResolvedValue(undefined);
    const rm = jest.fn().mockResolvedValue(undefined);
    (getSandboxHandle as jest.Mock).mockResolvedValue({
      runCommand,
      writeFiles,
      fs: { rm },
    });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      siteId: 'site-1',
    })).resolves.toEqual(expect.objectContaining({
      injected: false,
      error: expect.stringContaining('rolled back'),
    }));

    expect(writeFiles).toHaveBeenLastCalledWith(
      [{ path: '/vercel/sandbox/src/app/layout.tsx', content: layout }],
    );
  });
});
