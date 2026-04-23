import { parseGithubTreeUrl, branchBelongsToRequirement } from '@/lib/services/requirement-branch';
import type { GitBinding } from '@/lib/services/requirement-git-binding';

/** When repo_url is missing on the row, we still attempt snapshot restore (binding was validated at persist time). */
export function persistedSnapshotMatchesBinding(
  requirementId: string,
  binding: GitBinding,
  repoUrl: string | null,
): boolean {
  if (!repoUrl?.trim()) return true;
  const parsed = parseGithubTreeUrl(repoUrl);
  if (!parsed) return false;
  if (binding.org.toLowerCase() !== parsed.org.toLowerCase()) return false;
  if (binding.repo.toLowerCase() !== parsed.repo.toLowerCase()) return false;
  if (!branchBelongsToRequirement(parsed.branch, requirementId)) return false;
  return true;
}
