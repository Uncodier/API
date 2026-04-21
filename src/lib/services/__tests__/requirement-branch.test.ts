import {
  REQUIREMENT_BRANCH_PREFIX,
  buildRequirementBranchName,
  extractRequirementIdFromBranch,
  isLegacyRequirementBranch,
  matchesLegacyRequirementBranch,
  branchBelongsToRequirement,
  parseGithubTreeUrl,
  slugifyRequirementTitle,
  isUuid,
} from '../requirement-branch';

const REQ_ID = '21c35450-1234-4abc-9def-0123456789ab';
const REQ_ID_B = 'abcdef01-2345-4abc-9def-0123456789ab';

describe('requirement-branch: slugifyRequirementTitle', () => {
  test('normalizes spaces, casing, punctuation', () => {
    expect(slugifyRequirementTitle('Hello WORLD! ¿Qué tal?')).toBe('hello-world-qu-tal');
  });

  test('trims surrounding hyphens and collapses repeats', () => {
    expect(slugifyRequirementTitle('---Lead  Magnet---')).toBe('lead-magnet');
  });

  test('truncates at 40 chars and drops trailing dash', () => {
    const long = 'a'.repeat(60);
    const slug = slugifyRequirementTitle(long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  test('returns empty string for null/empty', () => {
    expect(slugifyRequirementTitle(undefined)).toBe('');
    expect(slugifyRequirementTitle('')).toBe('');
    expect(slugifyRequirementTitle('   ')).toBe('');
  });
});

describe('requirement-branch: isUuid', () => {
  test('accepts full UUID', () => {
    expect(isUuid(REQ_ID)).toBe(true);
  });
  test('rejects short / malformed ids', () => {
    expect(isUuid('21c35450')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('requirement-branch: buildRequirementBranchName', () => {
  test('emits canonical format with slug', () => {
    expect(buildRequirementBranchName(REQ_ID, 'Landing Step 4')).toBe(
      `${REQUIREMENT_BRANCH_PREFIX}${REQ_ID}--landing-step-4`,
    );
  });

  test('emits canonical format without slug when title is empty', () => {
    expect(buildRequirementBranchName(REQ_ID, '')).toBe(`${REQUIREMENT_BRANCH_PREFIX}${REQ_ID}`);
    expect(buildRequirementBranchName(REQ_ID)).toBe(`${REQUIREMENT_BRANCH_PREFIX}${REQ_ID}`);
  });

  test('lowercases the UUID even if caller passes uppercase', () => {
    const upper = REQ_ID.toUpperCase();
    expect(buildRequirementBranchName(upper)).toBe(`${REQUIREMENT_BRANCH_PREFIX}${REQ_ID}`);
  });

  test('throws on invalid UUID', () => {
    expect(() => buildRequirementBranchName('not-a-uuid')).toThrow(/valid UUID/);
  });
});

describe('requirement-branch: extractRequirementIdFromBranch', () => {
  test('extracts from canonical branch with slug', () => {
    expect(
      extractRequirementIdFromBranch(`feature/req-${REQ_ID}--landing-step-4`),
    ).toBe(REQ_ID);
  });

  test('extracts from canonical branch without slug', () => {
    expect(extractRequirementIdFromBranch(`feature/req-${REQ_ID}`)).toBe(REQ_ID);
  });

  test('case-insensitive UUID match', () => {
    const branch = `feature/req-${REQ_ID.toUpperCase()}--Slug`;
    expect(extractRequirementIdFromBranch(branch)).toBe(REQ_ID);
  });

  test('returns null for legacy branches (no full UUID present)', () => {
    expect(extractRequirementIdFromBranch('feature/21c35450-wework-clone')).toBeNull();
  });

  test('returns null for unrelated branches', () => {
    expect(extractRequirementIdFromBranch('main')).toBeNull();
    expect(extractRequirementIdFromBranch('release/v1.0')).toBeNull();
    expect(extractRequirementIdFromBranch(undefined)).toBeNull();
  });
});

describe('requirement-branch: legacy format helpers', () => {
  test('isLegacyRequirementBranch detects feature/<8hex>-...', () => {
    expect(isLegacyRequirementBranch('feature/21c35450-wework-clone')).toBe(true);
    expect(isLegacyRequirementBranch('feature/21c35450')).toBe(true);
  });

  test('isLegacyRequirementBranch rejects canonical', () => {
    expect(isLegacyRequirementBranch(`feature/req-${REQ_ID}--slug`)).toBe(false);
  });

  test('matchesLegacyRequirementBranch matches the 8-char prefix', () => {
    expect(matchesLegacyRequirementBranch('feature/21c35450-wework', REQ_ID)).toBe(true);
  });

  test('matchesLegacyRequirementBranch rejects different prefix', () => {
    expect(matchesLegacyRequirementBranch('feature/aabbccdd-wework', REQ_ID)).toBe(false);
  });
});

describe('requirement-branch: branchBelongsToRequirement', () => {
  test('canonical match', () => {
    expect(branchBelongsToRequirement(`feature/req-${REQ_ID}--slug`, REQ_ID)).toBe(true);
  });

  test('canonical mismatch', () => {
    expect(branchBelongsToRequirement(`feature/req-${REQ_ID_B}`, REQ_ID)).toBe(false);
  });

  test('legacy match', () => {
    expect(branchBelongsToRequirement('feature/21c35450-wework', REQ_ID)).toBe(true);
  });

  test('unrelated branch', () => {
    expect(branchBelongsToRequirement('main', REQ_ID)).toBe(false);
    expect(branchBelongsToRequirement(null, REQ_ID)).toBe(false);
  });
});

describe('requirement-branch: parseGithubTreeUrl', () => {
  test('parses org/repo/branch', () => {
    expect(parseGithubTreeUrl('https://github.com/makinary/apps/tree/feature/req-xyz')).toEqual({
      org: 'makinary',
      repo: 'apps',
      branch: 'feature/req-xyz',
    });
  });

  test('decodes URL-encoded branch', () => {
    const url = `https://github.com/makinary/apps/tree/${encodeURIComponent(`feature/req-${REQ_ID}--slug`)}`;
    const p = parseGithubTreeUrl(url);
    expect(p?.branch).toBe(`feature/req-${REQ_ID}--slug`);
  });

  test('returns null for non-tree URLs', () => {
    expect(parseGithubTreeUrl('https://github.com/foo/bar')).toBeNull();
    expect(parseGithubTreeUrl(undefined)).toBeNull();
  });
});
