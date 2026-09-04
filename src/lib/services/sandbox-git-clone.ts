import type { Sandbox } from '@vercel/sandbox';
import { SANDBOX_WORK_DIR } from '@/lib/services/sandbox-constants';

/**
 * Clone (or flatten a nested v3 git checkout) so the repo root is exactly
 * SANDBOX_WORK_DIR. Never leave the workspace in a repo-named subdirectory.
 */
/** Exported for unit tests — must keep WORK_DIR as the git toplevel. */
export function buildCloneIntoWorkDirScript(cwd: string, authRepoUrl: string): string {
  return `
set -e
WORKDIR="${cwd}"
mkdir -p "$WORKDIR"
if [ -d "$WORKDIR/.git" ]; then
  exit 0
fi
nested=$(find "$WORKDIR" -mindepth 2 -maxdepth 3 -type d -name .git 2>/dev/null | head -1)
if [ -n "$nested" ]; then
  repo=$(dirname "$nested")
  tmp=$(mktemp -d)
  mv "$repo" "$tmp/repo"
  find "$WORKDIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  mv "$tmp/repo"/.[!.]* "$WORKDIR"/ 2>/dev/null || true
  mv "$tmp/repo"/* "$WORKDIR"/ 2>/dev/null || true
  rm -rf "$tmp"
  exit 0
fi
git clone --depth 1 "${authRepoUrl}" "$WORKDIR"
`;
}

export async function cloneRepoIntoWorkDir(
  sandbox: Sandbox,
  authRepoUrl: string,
  cwd: string = SANDBOX_WORK_DIR,
): Promise<void> {
  const script = buildCloneIntoWorkDirScript(cwd, authRepoUrl);
  const res = await sandbox.runCommand({ cmd: 'sh', args: ['-c', script] });
  if (res.exitCode !== 0) {
    throw new Error(`Failed to clone repository into ${cwd}: ${await res.stderr()}`);
  }
}
