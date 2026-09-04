import type { Sandbox } from '@vercel/sandbox';
import { SANDBOX_WORK_DIR } from '@/lib/services/sandbox-constants';
import { fetchOriginBranch } from '@/lib/services/sandbox-git-identity';

export type FeatureAttachAction = 'noop' | 'checkout-B-head';

/**
 * Attach to the requirement feature branch from current HEAD.
 * Never reset onto origin/<feature> — that wipes just-written work.
 */
export function decideFeatureBranchAttach(input: {
  detached: boolean;
  currentBranch: string;
}): FeatureAttachAction {
  const current = String(input.currentBranch || '').trim();
  if (!input.detached && current !== 'main' && current !== 'master') {
    return 'noop';
  }
  return 'checkout-B-head';
}

export function isInvalidOriginBranchName(name: string): boolean {
  const b = String(name).trim();
  if (!b) return true;
  if (b === 'HEAD' || b.toLowerCase() === 'head') return true;
  return false;
}

async function runGit(sandbox: Sandbox, args: string[], cwd: string) {
  return sandbox.runCommand({ cmd: 'git', args, cwd });
}

export async function clearStuckGitOperationState(
  sandbox: Sandbox,
  cwd: string = SANDBOX_WORK_DIR,
): Promise<void> {
  const sh = `
[ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ] || exit 0
git rebase --abort 2>/dev/null || true
git rebase --quit 2>/dev/null || true
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  rm -rf .git/rebase-merge .git/rebase-apply
fi
[ -f .git/MERGE_HEAD ] && git merge --abort 2>/dev/null || true
exit 0
`;
  await sandbox.runCommand({ cmd: 'sh', args: ['-c', sh], cwd });
}

/**
 * Push and, on non-fast-forward, rebase once. On feature/req-* / req-*
 * branches the harness is the sole writer: after abort, force-with-lease.
 */
export async function pushWithRebaseRetry(
  sandbox: Sandbox,
  branch: string,
  cwd: string = SANDBOX_WORK_DIR,
): Promise<{ ok: true; rebased: boolean } | { ok: false; stderr: string }> {
  const b = String(branch).trim();
  if (isInvalidOriginBranchName(b)) {
    return {
      ok: false,
      stderr:
        'Refusing to push: target branch is empty, HEAD, or not a real branch name. Attach with `git checkout -B <branch>` or pass requirementId in commit options.',
    };
  }
  const refspec = `HEAD:refs/heads/${b}`;
  const first = await runGit(sandbox, ['push', '-u', 'origin', refspec], cwd);
  if (first.exitCode === 0) {
    return { ok: true, rebased: false };
  }

  const firstStderr = await first.stderr();
  const isNonFastForward = /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(firstStderr);
  if (!isNonFastForward) {
    return { ok: false, stderr: firstStderr };
  }

  console.warn(`[Sandbox] push rejected (non-fast-forward) on ${b} — fetching + rebasing onto origin and retrying once`);

  const fetchRes = await fetchOriginBranch(sandbox, b, cwd);
  if (fetchRes.exitCode !== 0) {
    const isReqBranch = /^feature\/req-|^req-/.test(b);
    if (isReqBranch) {
      const lease = await runGit(sandbox, ['push', '--force-with-lease', '-u', 'origin', refspec], cwd);
      if (lease.exitCode === 0) return { ok: true, rebased: true };
    }
    return { ok: false, stderr: `Initial push rejected and fetch origin ${b} failed: ${fetchRes.stderr}\n---\n${firstStderr}` };
  }

  await clearStuckGitOperationState(sandbox, cwd);
  const rebaseRes = await runGit(sandbox, ['rebase', `origin/${b}`], cwd);
  if (rebaseRes.exitCode !== 0) {
    const rebaseErr = await rebaseRes.stderr();
    await runGit(sandbox, ['rebase', '--abort'], cwd);
    await clearStuckGitOperationState(sandbox, cwd);
    const isReqBranch = /^feature\/req-|^req-/.test(b);
    if (isReqBranch) {
      console.warn(`[Sandbox] rebase conflict on ${b} — force-with-lease (harness is the sole writer)`);
      const lease = await runGit(sandbox, ['push', '--force-with-lease', '-u', 'origin', refspec], cwd);
      if (lease.exitCode === 0) {
        return { ok: true, rebased: true };
      }
      return {
        ok: false,
        stderr: `Push rejected, rebase conflicted, and force-with-lease failed on ${b}: ${await lease.stderr()}\n---\n${rebaseErr}\n---\n${firstStderr}`,
      };
    }
    return {
      ok: false,
      stderr: `Push rejected and automatic rebase on origin/${b} produced conflicts — manual resolution required: ${rebaseErr}\n---\n${firstStderr}`,
    };
  }

  const retry = await runGit(sandbox, ['push', '-u', 'origin', refspec], cwd);
  if (retry.exitCode === 0) {
    return { ok: true, rebased: true };
  }
  const retryStderr = await retry.stderr();
  return { ok: false, stderr: `Push still rejected after rebase on origin/${b}: ${retryStderr}\n---\nInitial rejection: ${firstStderr}` };
}
