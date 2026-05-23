import { parseGithubTreeUrl, branchBelongsToRequirement } from '@/lib/services/requirement-branch';
import type { GitBinding } from '@/lib/services/requirement-git-binding';

/**
 * Decides whether a persisted snapshot row may be reused to bootstrap a sandbox
 * for the given requirement + git binding.
 *
 * IMPORTANT: a row without `repo_url` is NOT safe to restore. We used to allow
 * it on the assumption that the binding was validated at persist time, but in
 * practice it let cross-project snapshots leak into freshly-created
 * requirements (a new requirement would boot from another project's filesystem).
 * Refusing the bootstrap forces a clean git clone instead, which is the only
 * sound behavior when we cannot prove the snapshot belongs to this requirement.
 */
export function persistedSnapshotMatchesBinding(
  requirementId: string,
  binding: GitBinding,
  repoUrl: string | null,
): boolean {
  if (!repoUrl?.trim()) return false;
  const parsed = parseGithubTreeUrl(repoUrl);
  if (!parsed) return false;
  if (binding.org.toLowerCase() !== parsed.org.toLowerCase()) return false;
  if (binding.repo.toLowerCase() !== parsed.repo.toLowerCase()) return false;
  if (!branchBelongsToRequirement(parsed.branch, requirementId)) return false;
  return true;
}
