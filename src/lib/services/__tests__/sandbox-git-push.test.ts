import { fetchOriginBranch } from '@/lib/services/sandbox-git-identity';
import { pushWithRebaseRetry } from '@/lib/services/sandbox-git-push';

jest.mock('@/lib/services/sandbox-git-identity', () => ({
  fetchOriginBranch: jest.fn(),
}));

function commandResult(exitCode: number, stderr = '') {
  return {
    exitCode,
    stdout: jest.fn().mockResolvedValue(''),
    stderr: jest.fn().mockResolvedValue(stderr),
  };
}

describe('pushWithRebaseRetry validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchOriginBranch as jest.Mock).mockResolvedValue(commandResult(0));
  });

  it('does not retry the push when the rebased tree fails validation', async () => {
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(1, 'non-fast-forward'))
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0)),
    };
    const validateBeforePush = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        '[pre-push-build] rebased application does not build',
      );

    await expect(pushWithRebaseRetry(
      sandbox as any,
      'feature/req-test',
      '/vercel/sandbox',
      { validateBeforePush },
    )).resolves.toEqual({
      ok: false,
      stderr: '[pre-push-build] rebased application does not build',
    });
    expect(validateBeforePush).toHaveBeenCalledTimes(2);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(3);
  });

  it('retries the push after the rebased tree passes validation', async () => {
    const sandbox = {
      runCommand: jest.fn()
        .mockResolvedValueOnce(commandResult(1, 'non-fast-forward'))
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0))
        .mockResolvedValueOnce(commandResult(0)),
    };
    const validateBeforePush = jest.fn().mockResolvedValue(null);

    await expect(pushWithRebaseRetry(
      sandbox as any,
      'feature/req-test',
      '/vercel/sandbox',
      { validateBeforePush },
    )).resolves.toEqual({ ok: true, rebased: true });
    expect(validateBeforePush).toHaveBeenCalledTimes(2);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(4);
  });

  it('does not attempt the initial push when validation fails', async () => {
    const sandbox = { runCommand: jest.fn() };
    const validateBeforePush = jest.fn().mockResolvedValue(
      '[pre-push-build] application does not build',
    );

    await expect(pushWithRebaseRetry(
      sandbox as any,
      'feature/req-test',
      '/vercel/sandbox',
      { validateBeforePush },
    )).resolves.toEqual({
      ok: false,
      stderr: '[pre-push-build] application does not build',
    });
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('revalidates before a force-with-lease fallback', async () => {
    (fetchOriginBranch as jest.Mock).mockResolvedValue(commandResult(1));
    const sandbox = {
      runCommand: jest.fn().mockResolvedValueOnce(
        commandResult(1, 'non-fast-forward'),
      ),
    };
    const validateBeforePush = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        '[pre-push-build] force-push candidate does not build',
      );

    await expect(pushWithRebaseRetry(
      sandbox as any,
      'feature/req-test',
      '/vercel/sandbox',
      { validateBeforePush },
    )).resolves.toEqual({
      ok: false,
      stderr: '[pre-push-build] force-push candidate does not build',
    });
    expect(validateBeforePush).toHaveBeenCalledTimes(2);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
  });
});
