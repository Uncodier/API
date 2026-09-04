import type { Sandbox } from '@vercel/sandbox';
import { SANDBOX_VISUAL_PROBE_PORT, SANDBOX_WORK_DIR } from '@/lib/services/sandbox-constants';
import { fetchOriginBranch, installGitIdentity } from '@/lib/services/sandbox-git-identity';
import { ensureNpmDeps } from '@/lib/services/sandbox-npm';
import { getRequirementGitBinding, resolveDefaultGitBinding } from '@/lib/services/requirement-git-binding';

export type ResumeWorkspaceOpts = {
  authRepoUrl?: string | null;
  /** When true (default), reset --hard to origin if the tree is clean. */
  syncToOrigin?: boolean;
};

/**
 * Warm start. Identity is applied before fetch so a tokenless remote that
 * lost proxy auth is restored before we talk to origin.
 */
export async function resumeRequirementWorkspace(
  sandbox: Sandbox,
  cwd: string = SANDBOX_WORK_DIR,
  opts?: ResumeWorkspaceOpts,
): Promise<void> {
  if (opts?.authRepoUrl) {
    await installGitIdentity(sandbox, opts.authRepoUrl, cwd);
  }

  const branchRes = await sandbox.runCommand({
    cmd: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd,
  });
  const branch = ((await branchRes.stdout()) || '').trim();
  const usableBranch = branch && branch !== 'HEAD' ? branch : null;

  await fetchOriginBranch(sandbox, usableBranch, cwd);

  const dirty = await sandbox.runCommand({
    cmd: 'git',
    args: ['status', '--porcelain'],
    cwd,
  });
  const porcelain = ((await dirty.stdout()) || '').trim();
  if (opts?.syncToOrigin !== false && !porcelain && usableBranch) {
    const reset = await sandbox.runCommand({
      cmd: 'git',
      args: ['reset', '--hard', `origin/${usableBranch}`],
      cwd,
    });
    if (reset.exitCode !== 0) {
      console.warn('[Sandbox] onResume reset --hard skipped:', await reset.stderr());
    }
  } else if (porcelain) {
    console.log('[Sandbox] onResume: local changes present — not resetting to origin');
  }

  try {
    await ensureNpmDeps(sandbox, cwd, { preferOffline: true });
  } catch (e: unknown) {
    console.warn(
      '[Sandbox] ensureNpmDeps failed (continuing without reinstall):',
      e instanceof Error ? e.message : e,
    );
  }

  const update = (sandbox as Sandbox & { update?: (opts: { ports?: number[] }) => Promise<void> }).update;
  if (typeof update === 'function') {
    try {
      await update.call(sandbox, { ports: [SANDBOX_VISUAL_PROBE_PORT] });
    } catch {
      /* older sessions may ignore ports */
    }
  }

  await restartNextIfBuilt(sandbox, cwd);
}

export async function resolveRequirementAuthRepoUrl(
  requirementId: string,
  instanceType: string,
): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return null;
  const binding = await getRequirementGitBinding(requirementId, instanceType).catch(() =>
    resolveDefaultGitBinding(instanceType),
  );
  if (!binding.org || !binding.repo) return null;
  return `https://x-access-token:${token}@github.com/${binding.org}/${binding.repo}.git`;
}

export type WarmStartOpts = {
  cwd?: string;
  /** Start-of-cycle: sync to origin if clean. Mid-cycle reconnect: false. */
  syncToOrigin?: boolean;
};

/**
 * Fast-path reuse (`Sandbox.get` + ping) does not run getOrCreate onResume.
 * Identity first, then fetch / npm / next.
 */
export async function warmStartNamedSandbox(
  sandbox: Sandbox,
  requirementId: string,
  instanceType: string,
  opts?: WarmStartOpts,
): Promise<void> {
  const cwd = opts?.cwd ?? SANDBOX_WORK_DIR;
  let authRepoUrl: string | null = null;
  try {
    authRepoUrl = await resolveRequirementAuthRepoUrl(requirementId, instanceType);
  } catch (e: unknown) {
    console.warn(
      '[Sandbox] warmStart identity lookup skipped:',
      e instanceof Error ? e.message : e,
    );
  }
  await resumeRequirementWorkspace(sandbox, cwd, {
    authRepoUrl,
    syncToOrigin: opts?.syncToOrigin !== false,
  });
}

async function restartNextIfBuilt(sandbox: Sandbox, cwd: string): Promise<void> {
  const probe = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `cd "${cwd}" && [ -f package.json ] && [ -d .next ] && grep -q '"next"' package.json && echo READY || echo SKIP`,
    ],
  });
  if (!((await probe.stdout()) || '').includes('READY')) return;

  try {
    await (sandbox as Sandbox & { runCommand: (opts: Record<string, unknown>) => Promise<unknown> }).runCommand({
      cmd: 'sh',
      args: ['-c', 'pkill -f "next start" >/dev/null 2>&1 || true; npx next start -p 3000'],
      cwd,
      detached: true,
    });
  } catch {
    /* next restart is best-effort */
  }
}
