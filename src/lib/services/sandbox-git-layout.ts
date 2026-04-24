import type { Sandbox } from '@vercel/sandbox';

/** Same as SandboxService.WORK_DIR — duplicated to avoid circular imports with sandbox-service. */
const WORK_DIR = '/vercel/sandbox';

function runInWorkDir(sandbox: Sandbox, command: string, args: string[], cwd: string = WORK_DIR) {
  return sandbox.runCommand({ cmd: command, args, cwd });
}

/**
 * Non-throwing check: git exists, clone root matches WORK_DIR, and the repo was not relocated under app/.
 */
export async function verifyPlatformGitLayout(
  sandbox: Sandbox,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cwd = WORK_DIR;
  const gitVer = await runInWorkDir(sandbox, 'git', ['--version'], cwd);
  if (gitVer.exitCode !== 0) {
    return { ok: false, reason: 'git CLI missing or not executable' };
  }
  const gdRes = await runInWorkDir(sandbox, 'git', ['rev-parse', '--git-dir'], cwd);
  if (gdRes.exitCode !== 0) {
    const err = ((await gdRes.stderr()) || (await gdRes.stdout()) || '').trim();
    return { ok: false, reason: `not a git work tree: ${err.slice(0, 200)}` };
  }
  const gitDirRaw = (await gdRes.stdout()).trim();
  const absGit = await runInWorkDir(
    sandbox,
    'sh',
    ['-c', `cd "${cwd}" && (realpath "${gitDirRaw}" 2>/dev/null || echo "${cwd}/${gitDirRaw}")`],
    cwd,
  );
  const gitDirAbs = ((await absGit.stdout()) || '').trim().replace(/\/$/, '');
  const appGitPrefix = `${cwd}/app/`;
  if (gitDirAbs.startsWith(appGitPrefix) || gitDirAbs === `${cwd}/app/.git`) {
    return {
      ok: false,
      reason:
        'Git directory lives under app/ — the repository must stay at /vercel/sandbox, not nested under app/. ' +
        'Do not move .git or the project into app/; use src/app/ for Next.js routes. This sandbox needs reprovision.',
    };
  }
  const topRes = await runInWorkDir(sandbox, 'git', ['rev-parse', '--show-toplevel'], cwd);
  if (topRes.exitCode !== 0) {
    return { ok: false, reason: 'git rev-parse --show-toplevel failed' };
  }
  const top = ((await topRes.stdout()) || '').trim().replace(/\/$/, '');
  // Compare *canonical* paths. `git rev-parse --show-toplevel` may return a
  // logical path while `pwd -P` resolves symlinks — a mismatch here caused
  // pingSandboxWorkspace to fail on every connectOrRecreate even for healthy
  // sandboxes, triggering endless reprovisions + zombie VMs.
  const topCanonRes = await runInWorkDir(
    sandbox,
    'sh',
    ['-c', 'cd "$(git rev-parse --show-toplevel)" && pwd -P'],
    cwd,
  );
  if (topCanonRes.exitCode !== 0) {
    return { ok: false, reason: 'failed to canonicalize git top-level (pwd -P)' };
  }
  const topCanon = ((await topCanonRes.stdout()) || '').trim().replace(/\/$/, '');
  const pwdRes = await runInWorkDir(sandbox, 'sh', ['-c', `cd "${cwd}" && pwd -P`], cwd);
  const here = ((await pwdRes.stdout()) || '').trim().replace(/\/$/, '');
  if (topCanon !== here) {
    return {
      ok: false,
      reason: `Git top-level canonical (${topCanon}) does not match workspace root canonical (${here}); raw top was (${top}). Keep the clone at ${cwd} only.`,
    };
  }
  return { ok: true };
}

export async function assertPlatformGitLayout(sandbox: Sandbox): Promise<void> {
  const v = await verifyPlatformGitLayout(sandbox);
  if (v.ok) return;
  throw new Error(`[git] Invalid sandbox layout: ${v.reason}`);
}
