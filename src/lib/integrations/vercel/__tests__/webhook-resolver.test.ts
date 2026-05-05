import {
  classifyGitRepoKind,
  extractBranchFromPayload,
  isProductionBranch,
} from '../webhook-resolver';
import type { VercelWebhookPayloadBody } from '../webhook-types';

function payloadWith(
  overrides: Partial<VercelWebhookPayloadBody> = {},
  metaOverrides: Record<string, unknown> = {},
): VercelWebhookPayloadBody {
  return {
    deployment: {
      id: 'dpl_test',
      url: 'example-hash.vercel.app',
      meta: {
        githubCommitRef: 'feature/req-21c35450-1234-4abc-9def-0123456789ab',
        githubCommitSha: 'abc123',
        githubRepo: 'apps',
        ...metaOverrides,
      },
    },
    ...overrides,
  };
}

describe('extractBranchFromPayload', () => {
  test('returns the github ref when present', () => {
    expect(extractBranchFromPayload(payloadWith())).toBe(
      'feature/req-21c35450-1234-4abc-9def-0123456789ab',
    );
  });

  test('falls back to gitlab/bitbucket alt keys when github is missing', () => {
    const p = payloadWith({}, { githubCommitRef: null, gitlabProjectPath: 'feature/req-xyz' });
    expect(extractBranchFromPayload(p)).toBe('feature/req-xyz');
  });

  test('returns null when deployment/meta is missing', () => {
    expect(extractBranchFromPayload(undefined)).toBeNull();
    expect(extractBranchFromPayload({ deployment: {} })).toBeNull();
  });
});

describe('isProductionBranch', () => {
  test.each(['main', 'master', 'production', 'MAIN'])(
    'detects %s as production',
    (branch) => {
      expect(isProductionBranch(branch)).toBe(true);
    },
  );

  test.each([
    'feature/req-abc',
    'develop',
    null,
    undefined,
    '',
  ])('returns false for non-production branch %p', (branch) => {
    expect(isProductionBranch(branch)).toBe(false);
  });
});

describe('classifyGitRepoKind', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('classifies by project id when VERCEL_PROJECT_ID matches', () => {
    process.env.VERCEL_PROJECT_ID = 'prj_apps';
    const p = payloadWith({ projectId: 'prj_apps' });
    expect(classifyGitRepoKind(p)).toBe('applications');
  });

  test('classifies by project id when VERCEL_PROJECT_ID_AUTOMATION matches', () => {
    process.env.VERCEL_PROJECT_ID_AUTOMATION = 'prj_auto';
    const p = payloadWith({ projectId: 'prj_auto' });
    expect(classifyGitRepoKind(p)).toBe('automation');
  });

  test('falls back to repo name when project id does not match', () => {
    process.env.VERCEL_PROJECT_ID = 'prj_apps';
    process.env.GIT_AUTOMATIONS_REPO = 'automations';
    const p = payloadWith({ projectId: 'prj_other' }, { githubRepo: 'automations' });
    expect(classifyGitRepoKind(p)).toBe('automation');
  });

  test('defaults to applications when nothing matches', () => {
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_PROJECT_ID_AUTOMATION;
    delete process.env.GIT_APPLICATIONS_REPO;
    delete process.env.GIT_AUTOMATIONS_REPO;
    const p = payloadWith({ projectId: 'prj_unknown' }, { githubRepo: 'unrelated' });
    expect(classifyGitRepoKind(p)).toBe('applications');
  });
});
