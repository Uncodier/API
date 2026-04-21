/**
 * Tests for the pure helpers in requirement-git-binding.ts.
 *
 * `getRequirementGitBinding` is excluded here because it hits Supabase;
 * its DB integration is covered by CRUD tests that mock supabaseAdmin.
 */

import {
  isGitBinding,
  normalizeGitBindingInput,
  parseGitBindingFromMetadata,
  resolveDefaultGitBinding,
  mergeGitBinding,
  instanceTypeFromGitKind,
  gitBindingRepoUrl,
  gitBindingBranchTreeUrl,
} from '../requirement-git-binding';

describe('isGitBinding', () => {
  test('accepts well-formed binding', () => {
    expect(
      isGitBinding({
        kind: 'applications',
        org: 'makinary',
        repo: 'apps',
        default_branch: 'main',
      }),
    ).toBe(true);
  });

  test('rejects unknown kind', () => {
    expect(
      isGitBinding({
        kind: 'other',
        org: 'makinary',
        repo: 'apps',
        default_branch: 'main',
      }),
    ).toBe(false);
  });

  test('rejects missing required fields', () => {
    expect(isGitBinding({ kind: 'applications', org: 'x' })).toBe(false);
    expect(isGitBinding(null)).toBe(false);
    expect(isGitBinding({})).toBe(false);
  });

  test('accepts optional preview object', () => {
    expect(
      isGitBinding({
        kind: 'automation',
        org: 'o',
        repo: 'r',
        default_branch: 'main',
        preview: { provider: 'vercel' },
      }),
    ).toBe(true);
  });
});

describe('normalizeGitBindingInput', () => {
  test('fills defaults from fallback when input is partial', () => {
    const out = normalizeGitBindingInput(
      { org: 'foo' },
      { kind: 'applications', repo: 'apps', default_branch: 'main' },
    );
    expect(out).toEqual({
      kind: 'applications',
      org: 'foo',
      repo: 'apps',
      default_branch: 'main',
    });
  });

  test('returns null when required fields cannot be filled', () => {
    expect(normalizeGitBindingInput({}, {})).toBeNull();
    expect(
      normalizeGitBindingInput({ kind: 'custom' }, {}),
    ).toBeNull();
  });

  test('preserves preview shallowly', () => {
    const out = normalizeGitBindingInput(
      { kind: 'applications', org: 'a', repo: 'b', default_branch: 'main', preview: { provider: 'vercel' } },
    );
    expect(out?.preview).toEqual({ provider: 'vercel' });
  });
});

describe('parseGitBindingFromMetadata', () => {
  test('returns null for null / non-objects', () => {
    expect(parseGitBindingFromMetadata(null)).toBeNull();
    expect(parseGitBindingFromMetadata('string')).toBeNull();
    expect(parseGitBindingFromMetadata({})).toBeNull();
  });

  test('extracts valid git binding', () => {
    const meta = {
      git: { kind: 'applications', org: 'm', repo: 'apps', default_branch: 'main' },
    };
    expect(parseGitBindingFromMetadata(meta)).toEqual(meta.git);
  });

  test('normalizes partial git sub-object', () => {
    const meta = { git: { kind: 'applications', org: 'm', repo: 'apps' } };
    const parsed = parseGitBindingFromMetadata(meta);
    expect(parsed?.default_branch).toBe('main');
  });
});

describe('resolveDefaultGitBinding', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  test('picks applications repo when instanceType is not automation', () => {
    process.env.GIT_ORG = 'makinary';
    process.env.GIT_APPLICATIONS_REPO = 'apps';
    delete process.env.GIT_AUTOMATIONS_REPO;
    delete process.env.GIT_DEFAULT_BRANCH;
    expect(resolveDefaultGitBinding('applications')).toEqual({
      kind: 'applications',
      org: 'makinary',
      repo: 'apps',
      default_branch: 'main',
      preview: { provider: 'vercel' },
    });
  });

  test('picks automation repo when instanceType=automation', () => {
    process.env.GIT_ORG = 'makinary';
    process.env.GIT_AUTOMATIONS_REPO = 'automations';
    expect(resolveDefaultGitBinding('automation').kind).toBe('automation');
    expect(resolveDefaultGitBinding('automation').repo).toBe('automations');
  });

  test('uses hardcoded fallbacks when env vars are missing', () => {
    delete process.env.GIT_ORG;
    delete process.env.GIT_APPLICATIONS_REPO;
    delete process.env.GIT_AUTOMATIONS_REPO;
    delete process.env.GIT_DEFAULT_BRANCH;
    const out = resolveDefaultGitBinding(undefined);
    expect(out.org).toBe('makinary');
    expect(out.repo).toBe('apps');
    expect(out.default_branch).toBe('main');
  });

  test('respects GIT_DEFAULT_BRANCH override', () => {
    process.env.GIT_DEFAULT_BRANCH = 'develop';
    expect(resolveDefaultGitBinding('applications').default_branch).toBe('develop');
  });
});

describe('mergeGitBinding', () => {
  const base = {
    kind: 'applications' as const,
    org: 'makinary',
    repo: 'apps',
    default_branch: 'main',
    preview: { provider: 'vercel' },
  };

  test('incoming overrides scalar fields', () => {
    expect(mergeGitBinding(base, { repo: 'sites' })?.repo).toBe('sites');
    expect(mergeGitBinding(base, { default_branch: 'develop' })?.default_branch).toBe('develop');
  });

  test('preview merges shallowly', () => {
    const out = mergeGitBinding(base, { preview: { provider: 'netlify' } });
    expect(out?.preview).toEqual({ provider: 'netlify' });
  });

  test('null incoming returns existing', () => {
    expect(mergeGitBinding(base, null)).toEqual(base);
  });

  test('null existing + full incoming normalizes', () => {
    expect(
      mergeGitBinding(null, { kind: 'automation', org: 'a', repo: 'b', default_branch: 'main' })?.kind,
    ).toBe('automation');
  });

  test('ignores unknown kind in incoming', () => {
    const out = mergeGitBinding(base, { kind: 'not-a-kind' as any });
    expect(out?.kind).toBe('applications');
  });
});

describe('instanceTypeFromGitKind', () => {
  test('maps kinds to instance types', () => {
    expect(instanceTypeFromGitKind('automation')).toBe('automation');
    expect(instanceTypeFromGitKind('applications')).toBe('applications');
    expect(instanceTypeFromGitKind('custom')).toBe('applications');
    expect(instanceTypeFromGitKind(undefined)).toBe('applications');
  });
});

describe('URL helpers', () => {
  const binding = {
    kind: 'applications' as const,
    org: 'makinary',
    repo: 'apps',
    default_branch: 'main',
  };

  test('gitBindingRepoUrl', () => {
    expect(gitBindingRepoUrl(binding)).toBe('https://github.com/makinary/apps');
  });

  test('gitBindingBranchTreeUrl encodes the branch', () => {
    expect(gitBindingBranchTreeUrl(binding, 'feature/req-abc')).toBe(
      'https://github.com/makinary/apps/tree/feature%2Freq-abc',
    );
  });
});
