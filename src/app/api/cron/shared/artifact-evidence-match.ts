import { analyzeAcceptanceArtifactPath } from '@/lib/services/acceptance-artifact-path';
import type { FeatureCoverageEvidence } from '@/lib/services/requirement-evidence-types';

type Artifact = NonNullable<FeatureCoverageEvidence['artifact_proofs']>[number];

/** Directory evidence is current only when an inspected, nonempty child changed.
 * A deleted/unreadable/uninspected descendant or similarly prefixed path is not proof.
 */
export function changedDirectoryEntries(artifact: Artifact, changedFiles: string[]) {
  const root = analyzeAcceptanceArtifactPath(artifact.path).normalized;
  if (!root || artifact.kind !== 'directory' || artifact.outcome !== 'pass' || artifact.truncated) return [];
  const changed = new Set(changedFiles.flatMap(file => {
    const path = analyzeAcceptanceArtifactPath(file).normalized;
    return path ? [path] : [];
  }));
  return (artifact.entries || []).filter(entry => {
    const path = analyzeAcceptanceArtifactPath(entry.path).normalized;
    return path && path.startsWith(`${root}/`) && changed.has(path) && entry.bytes > 0;
  });
}