import type { Sandbox } from '@vercel/sandbox';
import { SANDBOX_WORK_DIR } from '@/lib/services/sandbox-constants';

export function stripGitHubTokenFromRemote(url: string): string {
  return url.replace(/https:\/\/x-access-token:[^@]+@github\.com/i, 'https://github.com');
}

export function buildFetchOriginArgs(branch?: string | null, shallow = false): string[] {
  const args = ['fetch', 'origin'];
  if (branch?.trim()) args.push(branch.trim());
  if (shallow) args.push('--depth=1');
  args.push('--prune');
  return args;
}

export async function installGitIdentity(sandbox: Sandbox, authRepoUrl: string, cwd: string = SANDBOX_WORK_DIR): Promise<void> {
  const name = process.env.GIT_AUTHOR_NAME || 'Assistant Runner';
  const email = process.env.GIT_AUTHOR_EMAIL || 'assistant@makinari.com';
  await Promise.all([
    sandbox.runCommand({ cmd: 'git', args: ['config', '--global', 'user.name', name] }),
    sandbox.runCommand({ cmd: 'git', args: ['config', '--global', 'user.email', email] }),
  ]);

  const setRemote = await sandbox.runCommand({
    cmd: 'git',
    args: ['remote', 'set-url', 'origin', authRepoUrl],
    cwd,
  });
  if (setRemote.exitCode !== 0) {
    const addRemote = await sandbox.runCommand({
      cmd: 'git',
      args: ['remote', 'add', 'origin', authRepoUrl],
      cwd,
    });
    if (addRemote.exitCode !== 0) {
      throw new Error(`Failed to configure git remote: ${await addRemote.stderr()}`);
    }
  }

  await tryTokenlessRemoteAfterProbe(sandbox, authRepoUrl, cwd);
}

/**
 * Keep the credential URL unless a tokenless `ls-remote` actually works
 * (network-policy header injection). set-url itself always succeeds.
 */
async function tryTokenlessRemoteAfterProbe(
  sandbox: Sandbox,
  authRepoUrl: string,
  cwd: string,
): Promise<void> {
  const tokenless = stripGitHubTokenFromRemote(authRepoUrl);
  if (tokenless === authRepoUrl) return;

  await sandbox.runCommand({ cmd: 'git', args: ['remote', 'set-url', 'origin', tokenless], cwd });
  const probe = await sandbox.runCommand({
    cmd: 'git',
    args: ['ls-remote', '--heads', 'origin'],
    cwd,
  });
  if (probe.exitCode === 0) {
    console.log('[Sandbox] origin is tokenless (proxy auth works)');
    return;
  }
  console.warn('[Sandbox] tokenless ls-remote failed — restoring credential URL');
  await sandbox.runCommand({ cmd: 'git', args: ['remote', 'set-url', 'origin', authRepoUrl], cwd });
}

export async function fetchOriginBranch(
  sandbox: Sandbox,
  branch?: string | null,
  cwd: string = SANDBOX_WORK_DIR,
  opts?: { shallow?: boolean },
): Promise<{ exitCode: number; stderr: string }> {
  const args = buildFetchOriginArgs(branch, opts?.shallow === true);
  const res = await sandbox.runCommand({ cmd: 'git', args, cwd });
  return { exitCode: res.exitCode, stderr: await res.stderr() };
}
