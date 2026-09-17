import {
  consumePrePushBuildMarker,
  ensureApplicationBuildCurrent,
  validateApplicationBeforePush,
} from '../commit/pre-push-build-validation';
import { SandboxService } from '@/lib/services/sandbox-service';

jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: { PRE_PUSH_BUILD: 'cron_infra_pre_push_build' },
  logCronInfrastructureEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: {
    hasWorkingTreeChanges: jest.fn(),
    getCurrentBranch: jest.fn(),
    countCommitsAheadOfRemote: jest.fn(),
  },
}));

function commandResult(
  exitCode: number,
  stdout = '',
  stderr = '',
) {
  return {
    exitCode,
    stdout: jest.fn().mockResolvedValue(stdout),
    stderr: jest.fn().mockResolvedValue(stderr),
  };
}

const FINGERPRINT = 'a'.repeat(64);

describe('pre-push build validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (SandboxService.hasWorkingTreeChanges as jest.Mock).mockResolvedValue(true);
    (SandboxService.getCurrentBranch as jest.Mock).mockResolvedValue(
      'feature/req-test',
    );
    (
      SandboxService.countCommitsAheadOfRemote as jest.Mock
    ).mockResolvedValue(0);
  });

  it('allows a valid application and removes the transient backup', async () => {
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0, FINGERPRINT)),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };

    await expect(validateApplicationBeforePush({
      sandbox: sandbox as any,
      cwd: '/vercel/sandbox',
    })).resolves.toEqual({
      ok: true,
      rolledBackHarnessMutation: false,
    });
    expect(sandbox.fs.rm).toHaveBeenCalled();
  });

  it('rolls back a harness mutation and retries before allowing push', async () => {
    const trackingTag =
      '<script src="https://files.uncodie.com/tracking.min.js" data-site-id="site-1" data-uncodie-harness="tracking"></script>';
    const backup = JSON.stringify({
      path: '/vercel/sandbox/src/app/layout.tsx',
      originalSource: '<html><body>valid</body></html>',
      transformedSource: `<html><body>valid${trackingTag}</body></html>`,
      reason: 'inserted',
      siteId: 'site-1',
    });
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(1, 'invalid transformed layout'))
        .mockResolvedValueOnce(commandResult(0, backup))
        .mockResolvedValueOnce(commandResult(
          0,
          `<html><body>valid changed${trackingTag}</body></html>`,
        ))
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0, FINGERPRINT)),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };

    await expect(validateApplicationBeforePush({
      sandbox: sandbox as any,
      cwd: '/vercel/sandbox',
    })).resolves.toEqual({
      ok: true,
      rolledBackHarnessMutation: true,
    });
    expect(sandbox.writeFiles).toHaveBeenCalledWith([{
      path: '/vercel/sandbox/src/app/layout.tsx',
      content: '<html><body>valid changed</body></html>',
    }]);
  });

  it('prevents push when the build remains invalid', async () => {
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(1, 'product syntax error'))
        .mockResolvedValueOnce(commandResult(2)),
      writeFiles: jest.fn(),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };

    await expect(validateApplicationBeforePush({
      sandbox: sandbox as any,
      cwd: '/vercel/sandbox',
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('no commit was pushed'),
    }));
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('reports the remaining product error after a safe harness rollback', async () => {
    const trackingTag =
      '<script src="https://files.uncodie.com/tracking.min.js" data-site-id="site-1" data-uncodie-harness="tracking"></script>';
    const transformedSource =
      `<html><body>broken product${trackingTag}</body></html>`;
    const backup = JSON.stringify({
      path: '/vercel/sandbox/src/app/layout.tsx',
      originalSource: '<html><body>broken product</body></html>',
      transformedSource,
      reason: 'inserted',
      siteId: 'site-1',
    });
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(1, 'tracking-adjacent error'))
        .mockResolvedValueOnce(commandResult(0, backup))
        .mockResolvedValueOnce(commandResult(0, transformedSource))
        .mockResolvedValueOnce(commandResult(1, 'remaining product error')),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };

    await expect(validateApplicationBeforePush({
      sandbox: sandbox as any,
      cwd: '/vercel/sandbox',
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('remaining product error'),
      rolledBackHarnessMutation: true,
    }));
  });

  it('skips validation when the workspace has nothing to push', async () => {
    (SandboxService.hasWorkingTreeChanges as jest.Mock).mockResolvedValue(
      false,
    );
    const sandbox = {
      runCommand: jest.fn().mockResolvedValueOnce(
        commandResult(0, FINGERPRINT),
      ),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };

    await expect(validateApplicationBeforePush({
      sandbox: sandbox as any,
      cwd: '/vercel/sandbox',
    })).resolves.toEqual({
      ok: true,
      rolledBackHarnessMutation: false,
    });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
  });

  it('builds a clean workspace when local commits remain ahead of origin', async () => {
    (SandboxService.hasWorkingTreeChanges as jest.Mock).mockResolvedValue(
      false,
    );
    (
      SandboxService.countCommitsAheadOfRemote as jest.Mock
    ).mockResolvedValue(2);
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0, FINGERPRINT)),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };

    await expect(validateApplicationBeforePush({
      sandbox: sandbox as any,
      cwd: '/vercel/sandbox',
    })).resolves.toEqual({
      ok: true,
      rolledBackHarnessMutation: false,
    });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2);
  });

  it('consumes a successful pre-push marker exactly once', async () => {
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(
          0,
          JSON.stringify({ workspaceFingerprint: FINGERPRINT }),
        ))
        .mockResolvedValueOnce(commandResult(0, FINGERPRINT)),
    };

    await expect(
      consumePrePushBuildMarker(sandbox as any, '/vercel/sandbox'),
    ).resolves.toBe(true);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2);
  });

  it('does not reuse the build after the workspace changes', async () => {
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(
          0,
          JSON.stringify({ workspaceFingerprint: FINGERPRINT }),
        ))
        .mockResolvedValueOnce(commandResult(0, 'b'.repeat(64))),
    };

    await expect(
      consumePrePushBuildMarker(sandbox as any, '/vercel/sandbox'),
    ).resolves.toBe(false);
  });

  it('reuses and refreshes a matching marker before the push', async () => {
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(
          0,
          JSON.stringify({ workspaceFingerprint: FINGERPRINT }),
        ))
        .mockResolvedValueOnce(commandResult(0, FINGERPRINT))
        .mockResolvedValueOnce(commandResult(0, FINGERPRINT)),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };

    await expect(ensureApplicationBuildCurrent({
      sandbox: sandbox as any,
      cwd: '/vercel/sandbox',
    })).resolves.toEqual({
      ok: true,
      rolledBackHarnessMutation: false,
    });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(3);
    expect(SandboxService.hasWorkingTreeChanges).not.toHaveBeenCalled();
  });
});
