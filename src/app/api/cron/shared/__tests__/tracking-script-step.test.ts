import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as trackingContract from '../tracking-script-contract';

const getSandboxHandle = jest.fn<(...args: any[]) => Promise<any>>();
const ensureRequirementTrackingSite = jest.fn<(...args: any[]) => Promise<string>>();
let provisionTrackingScriptStep: typeof import('../tracking-script-step').provisionTrackingScriptStep;

function commandResult(stdout: string, exitCode = 0) {
  return {
    exitCode,
    stdout: jest.fn(async () => stdout),
    stderr: jest.fn(async () => ''),
  };
}

describe('tracking script provisioning', () => {
  beforeAll(() => {
    ({ provisionTrackingScriptStep } = loadRuntimeModule<typeof import('../tracking-script-step')>(
      'src/app/api/cron/shared/tracking-script-step.ts', {
        '@/lib/services/sandbox-sdk': { getSandboxHandle },
        '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/vercel/sandbox' } },
        '@/lib/services/requirement-tracking-site': { ensureRequirementTrackingSite },
        '@/lib/services/cron-audit-log': {
          CronInfraEvent: { GIT_WORKSPACE_READY: 'git_workspace_ready' },
          logCronInfrastructureEvent: jest.fn(async () => {}),
        },
        './tracking-script-contract': trackingContract,
      },
    ));
  });
  beforeEach(() => {
    jest.clearAllMocks();
    ensureRequirementTrackingSite.mockResolvedValue('site-1');
  });

  it('marks a newly injected tracking script as harness-owned and uses the requirement site', async () => {
    const layout = [
      'export default function Layout({ children }) {',
      '  return <html><body>{children}</body></html>;',
      '}',
    ].join('\n');
    const runCommand = jest.fn<(...args: any[]) => Promise<ReturnType<typeof commandResult>>>()
      .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
      .mockResolvedValueOnce(commandResult(layout))
      .mockResolvedValueOnce(commandResult(''));
    const writeFiles = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
    const rm = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
    getSandboxHandle.mockResolvedValue({
      runCommand,
      writeFiles,
      fs: { rm },
    });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      requirementId: 'requirement-1',
      originSiteId: 'site-1',
    })).resolves.toEqual({ injected: true });

    expect(ensureRequirementTrackingSite).toHaveBeenCalledWith('requirement-1', 'site-1');
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
    const writes = writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>;
    expect(writes[1].content).toContain('data-site-id="site-1"');
    expect(JSON.parse(writes[0].content).siteId).toBe('site-1');
  });

  it('does not resolve a tracking site if the sandbox has no root layout', async () => {
    getSandboxHandle.mockResolvedValue({
      runCommand: jest.fn(async () => commandResult('MISSING\n')),
    });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      requirementId: 'requirement-1',
      originSiteId: 'site-1',
    })).resolves.toEqual({ injected: false });
    expect(ensureRequirementTrackingSite).not.toHaveBeenCalled();
  });

  it('replaces a previously generated application site id with the requirement site id', async () => {
    const layout = '<html><body><script src="https://files.uncodie.com/tracking.min.js?v=1.959" data-site-id="legacy-app-site" data-uncodie-harness="tracking"></script></body></html>';
    const writeFiles = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
    getSandboxHandle.mockResolvedValue({
      runCommand: jest.fn<(...args: any[]) => Promise<ReturnType<typeof commandResult>>>()
        .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
        .mockResolvedValueOnce(commandResult(layout))
        .mockResolvedValueOnce(commandResult('')),
      writeFiles,
      fs: { rm: jest.fn(async () => {}) },
    });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1', requirementId: 'requirement-1', originSiteId: 'site-1',
    })).resolves.toEqual({ injected: true });
    const writes = writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>;
    expect(writes[1].content).toContain('data-site-id="site-1"');
    expect(writes[1].content).not.toContain('legacy-app-site');
    expect(JSON.parse(writes[0].content).siteId).toBe('site-1');
  });

  it('does not inject an unverified site when the requirement site cannot be resolved', async () => {
    getSandboxHandle.mockResolvedValue({
      runCommand: jest.fn<(...args: any[]) => Promise<ReturnType<typeof commandResult>>>()
        .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
        .mockResolvedValueOnce(commandResult('<html><body>content</body></html>')),
      writeFiles: jest.fn(),
      fs: { rm: jest.fn() },
    });
    ensureRequirementTrackingSite.mockRejectedValue(new Error('database unavailable'));

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      requirementId: 'requirement-1',
      originSiteId: 'site-1',
    })).resolves.toEqual({ injected: false, error: expect.stringContaining('database unavailable') });
  });

  it('rolls back when the transformed TSX does not parse', async () => {
    const layout = '<html><body>content</body></html>';
    const runCommand = jest.fn<(...args: any[]) => Promise<ReturnType<typeof commandResult>>>()
      .mockResolvedValueOnce(commandResult('src/app/layout.tsx\n'))
      .mockResolvedValueOnce(commandResult(layout))
      .mockResolvedValueOnce(commandResult('', 1));
    const writeFiles = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
    const rm = jest.fn<(...args: any[]) => Promise<void>>(async () => {});
    getSandboxHandle.mockResolvedValue({
      runCommand,
      writeFiles,
      fs: { rm },
    });

    await expect(provisionTrackingScriptStep({
      sandboxId: 'sandbox-1',
      requirementId: 'requirement-1',
      originSiteId: 'site-1',
    })).resolves.toEqual(expect.objectContaining({
      injected: false,
      error: expect.stringContaining('rolled back'),
    }));

    expect(writeFiles).toHaveBeenLastCalledWith(
      [{ path: '/vercel/sandbox/src/app/layout.tsx', content: layout }],
    );
  });
});
