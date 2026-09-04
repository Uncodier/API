/**
 * Pure helpers for resume: attach to feature/req-* and never wipe it with origin/main.
 */

export function isDefaultGitBranch(name: string | null | undefined): boolean {
  const b = String(name || '').trim();
  return !b || b === 'HEAD' || b === 'main' || b === 'master';
}

export function pickRemoteFeatureBranch(
  lsRemoteStdout: string,
  requirementId: string,
): string | null {
  const idStr = String(requirementId || '').trim().toLowerCase();
  if (!idStr) return null;
  const lines = String(lsRemoteStdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/refs\/heads\/(.*)$/);
    if (!match) continue;
    const branchName = match[1];
    if (
      branchName.startsWith(`feature/req-${idStr}`) ||
      branchName.startsWith(`req-${idStr}`)
    ) {
      return branchName;
    }
  }
  return null;
}

export function pickResumeFeatureBranch(opts: {
  requirementId: string;
  lsRemoteStdout?: string;
  knownBranches?: string[];
}): string | null {
  const fromRemote = pickRemoteFeatureBranch(opts.lsRemoteStdout || '', opts.requirementId);
  if (fromRemote) return fromRemote;
  const id = String(opts.requirementId || '').trim().toLowerCase();
  if (!id) return null;
  const known = opts.knownBranches || [];
  for (let i = 0; i < known.length; i++) {
    const branch = known[i];
    if (branch.startsWith(`feature/req-${id}`) || branch.startsWith(`req-${id}`)) {
      return branch;
    }
  }
  return null;
}

/**
 * Never `reset --hard origin/main` when this requirement already has a feature branch.
 * Reset to origin/<feature> after checkout is fine.
 */
export function shouldResetResumeToOrigin(opts: {
  syncToOrigin: boolean;
  porcelain: string;
  currentBranch: string | null;
  featureBranch: string | null;
}): boolean {
  if (!opts.syncToOrigin) return false;
  if (String(opts.porcelain || '').trim()) return false;
  if (!opts.currentBranch) return false;
  if (isDefaultGitBranch(opts.currentBranch) && opts.featureBranch) return false;
  return true;
}
