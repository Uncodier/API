export interface AcceptanceArtifactPathAnalysis {
  valid: boolean;
  normalized?: string;
  reason?: string;
}

const FORBIDDEN_ARTIFACT_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//;

/**
 * Accepts repository-relative artifact paths and globs only.
 *
 * A single leading slash is treated as the repository root for backwards
 * compatibility. Traversal and platform-absolute paths are always rejected.
 */
export function analyzeAcceptanceArtifactPath(
  value: unknown,
): AcceptanceArtifactPathAnalysis {
  if (typeof value !== 'string') {
    return { valid: false, reason: 'Artifact path must be a string.' };
  }

  let candidate = value.trim();
  if (!candidate) {
    return { valid: false, reason: 'Artifact path cannot be empty.' };
  }
  if (FORBIDDEN_ARTIFACT_CHARACTERS.test(candidate)) {
    return {
      valid: false,
      reason: 'Artifact path contains control characters or a backslash.',
    };
  }

  if (candidate.startsWith('./')) candidate = candidate.slice(2);
  else if (candidate.startsWith('/')) candidate = candidate.slice(1);

  if (
    !candidate ||
    candidate.startsWith('/') ||
    WINDOWS_ABSOLUTE_PATH.test(candidate)
  ) {
    return {
      valid: false,
      reason: 'Artifact path must be relative to the repository.',
    };
  }

  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return {
      valid: false,
      reason: 'Artifact path cannot contain empty, current, or parent segments.',
    };
  }

  return { valid: true, normalized: segments.join('/') };
}
