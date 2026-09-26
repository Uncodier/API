import type { Sandbox } from '@vercel/sandbox';
import { branchBelongsToRequirement } from './requirement-branch';
import { NPM_LOCK_HASH_MARKER, SANDBOX_WORK_DIR } from './sandbox-constants';

/** Session identity is workspace evidence, NEVER an authorization/ownership cache. */
export function runningSessionId(sandbox: Sandbox): string | null {
  try {
    const session = sandbox.currentSession();
    return session.status === 'running' ? session.sessionId : null;
  } catch {
    return null;
  }
}

/** Read-only, local checks only. No remote fetch, identity lookup, install or restart. */
export async function inspectFastAttachWorkspace(
  sandbox: Sandbox,
  requirementId: string,
  sessionId: string,
): Promise<string | null> {
  const signal = AbortSignal.timeout(5_000);
  try {
    const result = await sandbox.runCommand({
      cmd: 'sh',
      cwd: SANDBOX_WORK_DIR,
      timeoutMs: 4_000,
      signal,
      args: ['-c', `
set -eu
ROOT=$(pwd -P)
TOP=$(git rev-parse --show-toplevel)
[ "$(cd "$TOP" && pwd -P)" = "$ROOT" ]
GIT_DIR=$(git rev-parse --absolute-git-dir)
[ "$(cd "$GIT_DIR" && pwd -P)" = "$ROOT/.git" ]
BRANCH=$(git symbolic-ref --quiet --short HEAD)
[ -f package.json ] && [ -d node_modules ]
# A changed manifest can invalidate deps even when the lock hash is unchanged.
# Treat staged, unstaged and untracked manifests conservatively; no state cache.
[ -z "$(git status --porcelain --untracked-files=normal -- package.json package-lock.json npm-shrinkwrap.json)" ]
LOCK=''
if [ -f package-lock.json ]; then LOCK=package-lock.json
elif [ -f npm-shrinkwrap.json ]; then LOCK=npm-shrinkwrap.json
fi
if [ -n "$LOCK" ]; then
  HASH=$(sha256sum "$LOCK" | awk '{print $1}')
  [ -n "$HASH" ] && [ "$HASH" = "$(cat '${NPM_LOCK_HASH_MARKER}')" ]
fi
printf '%s\\n' "$BRANCH"
`],
    });
    if (result.exitCode !== 0) return null;
    const branch = (await result.stdout({ signal })).trim();
    // runCommand can auto-resume on a stopped-session response. That is recovery,
    // not fast attach, even if the restored filesystem happens to look healthy.
    if (runningSessionId(sandbox) !== sessionId) return null;
    return branchBelongsToRequirement(branch, requirementId) ? branch : null;
  } catch {
    return null;
  }
}