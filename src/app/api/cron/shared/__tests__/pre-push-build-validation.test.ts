import {
  computeApplicationBuildFingerprint,
  consumePrePushBuildMarker,
  ensureApplicationBuildCurrent,
  validateApplicationBeforePush,
} from '../commit/pre-push-build-validation';
import { SandboxService } from '@/lib/services/sandbox-service';
import { logCronInfrastructureEvent } from '@/lib/services/cron-audit-log';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('fingerprints real product and QA files, but not generated evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gate-fingerprint-'));
    try {
      expect(spawnSync('git', ['init', '-q', cwd]).status).toBe(0);
      mkdirSync(join(cwd, '.qa'));
      mkdirSync(join(cwd, 'evidence'));
      writeFileSync(join(cwd, 'page.tsx'), 'product v1');
      writeFileSync(join(cwd, '.qa', 'scenario.json'), 'scenario v1');
      const sandbox = {
        runCommand: jest.fn(async (command: string, args: string[]) => {
          expect(command).toBe('node');
          const execution = spawnSync(process.execPath, args, { encoding: 'utf8' });
          return commandResult(execution.status ?? 1, execution.stdout, execution.stderr);
        }),
      };
      const fingerprint = () => computeApplicationBuildFingerprint(sandbox as any, cwd);
      const initial = await fingerprint();
      expect(initial).toMatch(/^[a-f0-9]{64}$/);
      writeFileSync(join(cwd, 'evidence', 'run.json'), 'new receipt');
      expect(await fingerprint()).toBe(initial);
      writeFileSync(join(cwd, '.qa', 'scenario.json'), 'scenario v2');
      const changedQa = await fingerprint();
      expect(changedQa).not.toBe(initial);
      writeFileSync(join(cwd, 'page.tsx'), 'product v2');
      expect(await fingerprint()).not.toBe(changedQa);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

  it.each(['empty', 'unreadable', 'stderr only', 'long output'])(
    'rejects nonzero exit with %s output and preserves exit evidence',
    async (mode) => {
      const failed = commandResult(137, mode === 'long output' ? 'x'.repeat(7_000) : '',
        mode === 'stderr only' ? 'killed build' : '');
      if (mode === 'unreadable') {
        failed.stdout.mockRejectedValue(new Error('stdout unavailable'));
        failed.stderr.mockRejectedValue(new Error('stderr unavailable'));
      }
      const sandbox = {
        runCommand: jest.fn()
          .mockResolvedValueOnce(failed)
          .mockResolvedValueOnce(commandResult(2)),
        writeFiles: jest.fn(),
        fs: { rm: jest.fn().mockResolvedValue(undefined) },
      };
      const validation = await validateApplicationBeforePush({ sandbox: sandbox as any, cwd: '/vercel/sandbox' });
      expect(validation).toMatchObject({ ok: false, exitCode: 137, error: expect.stringContaining('code 137') });
      if (mode === 'stderr only') expect(validation.error).toContain('killed build');
      if (mode === 'empty' || mode === 'unreadable') expect(validation.error).toContain('no readable build output');
      expect(sandbox.writeFiles).not.toHaveBeenCalled();
      expect(logCronInfrastructureEvent).toHaveBeenLastCalledWith(undefined,
        expect.objectContaining({ details: expect.objectContaining({ ok: false, exit_code: 137 }) }));
    },
  );

  it.each(['empty', 'unreadable'])('rejects %s output on the build after rollback', async (mode) => {
    const trackingTag = '<script src="https://files.uncodie.com/tracking.min.js" data-site-id="site-1" data-uncodie-harness="tracking"></script>';
    const originalSource = '<html><body>product</body></html>';
    const transformedSource = `<html><body>product${trackingTag}</body></html>`;
    const failed = commandResult(42);
    if (mode === 'unreadable') {
      failed.stdout.mockRejectedValue(new Error('stdout unavailable'));
      failed.stderr.mockRejectedValue(new Error('stderr unavailable'));
    }
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(1, 'initial error'))
        .mockResolvedValueOnce(commandResult(0, JSON.stringify({
          path: '/vercel/sandbox/src/app/layout.tsx', originalSource, transformedSource, siteId: 'site-1', reason: 'inserted',
        })))
        .mockResolvedValueOnce(commandResult(0, transformedSource))
        .mockResolvedValueOnce(failed),
      writeFiles: jest.fn().mockResolvedValue(undefined),
      fs: { rm: jest.fn().mockResolvedValue(undefined) },
    };
    await expect(validateApplicationBeforePush({ sandbox: sandbox as any, cwd: '/vercel/sandbox' })).resolves.toMatchObject({
      ok: false, exitCode: 42, rolledBackHarnessMutation: true, error: expect.stringContaining('code 42'),
    });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(4);
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1); // rollback, never a success marker
    expect(logCronInfrastructureEvent).toHaveBeenLastCalledWith(undefined,
      expect.objectContaining({ details: expect.objectContaining({ ok: false, exit_code: 42, initial_exit_code: 1 }) }));
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
