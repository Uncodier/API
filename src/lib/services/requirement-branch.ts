/**
 * Deterministic branch naming for a requirement.
 *
 * Canonical format:
 *   feature/req-<uuid>           (no title context)
 *   feature/req-<uuid>--<slug>   (human-readable suffix; cosmetic only)
 *
 * The system identifies the requirement strictly by the UUID segment after
 * `req-`. The `--<slug>` part is frozen at creation time for readability in
 * PR listings and MUST NOT be used to resolve the requirement.
 *
 * A legacy format (`feature/<8hex>-<slug>`) is still recognised for back-compat
 * with requirements created before this convention was introduced, but new
 * branches MUST be emitted in the canonical format.
 *
 * This module is intentionally pure (no DB / no sandbox imports) so it can be
 * unit-tested without network or Supabase mocks.
 */

const UUID_V4_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CANONICAL_BRANCH_RE = /(?:^|\/)req-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:--|$)/i;
const LEGACY_BRANCH_RE = /^feature\/([0-9a-f]{8})(?:-|$)/i;

export const REQUIREMENT_BRANCH_PREFIX = 'feature/req-';
export const REQUIREMENT_BRANCH_SLUG_SEP = '--';
export const REQUIREMENT_BRANCH_MAX_SLUG_LEN = 40;

export function isUuid(value: string | null | undefined): value is string {
  return !!value && UUID_V4_LIKE.test(String(value).trim()) && String(value).trim().length === 36;
}

/**
 * Produces a lowercase, url-safe slug from free-form text. Empty or non-alpha
 * titles collapse to an empty string — callers decide whether to append.
 */
export function slugifyRequirementTitle(title: string | null | undefined): string {
  if (!title) return '';
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, REQUIREMENT_BRANCH_MAX_SLUG_LEN)
    .replace(/-+$/, '');
}

/**
 * Builds the canonical branch name for a requirement. Slug is optional and
 * purely cosmetic; the UUID is always the identifier.
 */
export function buildRequirementBranchName(
  requirementId: string,
  title?: string | null,
): string {
  const id = String(requirementId || '').trim().toLowerCase();
  if (!isUuid(id)) {
    throw new Error(
      `buildRequirementBranchName: requirementId must be a valid UUID, received "${requirementId}"`,
    );
  }
  const slug = slugifyRequirementTitle(title);
  return slug
    ? `${REQUIREMENT_BRANCH_PREFIX}${id}${REQUIREMENT_BRANCH_SLUG_SEP}${slug}`
    : `${REQUIREMENT_BRANCH_PREFIX}${id}`;
}

/**
 * Returns the requirement UUID encoded inside a branch name, or `null` if the
 * branch is not a canonical requirement branch. Legacy branches cannot yield
 * the full UUID (they only carry 8 chars) — use `matchesLegacyRequirementBranch`
 * for those.
 */
export function extractRequirementIdFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const m = String(branch).match(CANONICAL_BRANCH_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * True when the branch follows the legacy `feature/<8hex>-<slug>` shape.
 */
export function isLegacyRequirementBranch(branch: string | null | undefined): boolean {
  if (!branch) return false;
  if (CANONICAL_BRANCH_RE.test(String(branch))) return false;
  return LEGACY_BRANCH_RE.test(String(branch));
}

/**
 * True when the legacy branch's short id prefix matches the requirement UUID's
 * first 8 characters. Used while migrating legacy branches to the new format.
 */
export function matchesLegacyRequirementBranch(
  branch: string | null | undefined,
  requirementId: string,
): boolean {
  if (!isLegacyRequirementBranch(branch)) return false;
  const m = String(branch).match(LEGACY_BRANCH_RE);
  if (!m) return false;
  const shortId = String(requirementId || '').slice(0, 8).toLowerCase();
  return shortId.length === 8 && m[1].toLowerCase() === shortId;
}

/**
 * True when the branch belongs to the given requirement, in either canonical
 * or legacy form.
 */
export function branchBelongsToRequirement(
  branch: string | null | undefined,
  requirementId: string,
): boolean {
  if (!branch) return false;
  const canonicalId = extractRequirementIdFromBranch(branch);
  if (canonicalId) {
    return canonicalId === String(requirementId || '').toLowerCase();
  }
  return matchesLegacyRequirementBranch(branch, requirementId);
}

/**
 * Parses the `owner/repo/branch` triple encoded in a GitHub tree URL.
 * Returns `null` when the URL does not match the expected shape.
 */
export function parseGithubTreeUrl(repoUrl: string | null | undefined): {
  org: string;
  repo: string;
  branch: string;
} | null {
  if (!repoUrl) return null;
  const m = String(repoUrl).match(/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)$/);
  if (!m) return null;
  const [, org, repo, rawBranch] = m;
  let branch = rawBranch;
  try {
    branch = decodeURIComponent(rawBranch);
  } catch {
    /* leave raw */
  }
  return { org, repo, branch };
}
