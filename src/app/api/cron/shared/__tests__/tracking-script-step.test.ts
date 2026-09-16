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
    const runCommand = jest.fn()
      .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
      .mockResolvedValueOnce(commandResult('NO\n'))
      .mockResolvedValueOnce(commandResult(''));
    (getSandboxHandle as jest.Mock).mockResolvedValue({ runCommand });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      siteId: 'site-1',
    })).resolves.toEqual({ injected: true });

    expect(runCommand.mock.calls[2][0].args.join(' ')).toContain(
      'data-uncodie-harness="tracking"',
    );
  });

  it('upgrades only the exact legacy harness tag', async () => {
    const runCommand = jest.fn()
      .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
      .mockResolvedValueOnce(commandResult('YES\n'))
      .mockResolvedValueOnce(commandResult('UPDATED'));
    (getSandboxHandle as jest.Mock).mockResolvedValue({ runCommand });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      siteId: 'site-1',
    })).resolves.toEqual({ injected: true });

    const upgradeArgs = runCommand.mock.calls[2][0].args;
    expect(upgradeArgs).toContain(
      '<script src="https://files.uncodie.com/tracking.min.js" data-site-id="site-1"></script>',
    );
    expect(upgradeArgs).toContain(
      '<script src="https://files.uncodie.com/tracking.min.js" data-site-id="site-1" data-uncodie-harness="tracking"></script>',
    );
  });
});
