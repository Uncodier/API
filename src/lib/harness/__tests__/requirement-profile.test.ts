import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequirementProfile } from '../requirement-profile';
import type { RequirementContext, RequirementRun } from '../requirement-types';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: jest.fn() }));
import { supabaseAdmin } from '@/lib/database/supabase-client';

const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(),
  instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 1, sessionId: randomUUID() };
const repository = 'https://github.com/example/existing-app';
const existingBranch = `feature/req-${run.requirementId}--existing-landing`;
const context: RequirementContext = { requirement: { id: run.requirementId, site_id: run.siteId,
  user_id: run.userId, title: 'Existing app polish', status: 'in-progress', type: 'develop',
  metadata: { git: { kind: 'custom', org: 'example', repo: 'existing-app', default_branch: 'main' } } },
  plans: [], history: [], revision: '1' };
let history: Array<{ repo_url: string }>;
const queries: Record<string, jest.Mock> = {};
beforeEach(() => {
  history = []; jest.clearAllMocks();
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query: Record<string, jest.Mock> = {};
    for (const method of ['select', 'eq', 'not', 'order']) query[method] = jest.fn(() => query);
    query.limit = jest.fn(async () => ({ data: history, error: null }));
    queries[table] = query.eq;
    if (table === 'site_secrets') {
      // The final or() resolves the scoped secrets query, without any real secret.
      query.or = jest.fn(async () => ({ data: [], error: null }));
    }
    return query;
  });
});

it('uses the percent-encoded historical app branch, not a new scaffold branch', async () => {
  history = [{ repo_url: `${repository}/tree/${encodeURIComponent(existingBranch)}` }];
  const profile = await buildRequirementProfile(run, context);
  expect(profile.branch).toBe(existingBranch);
  expect(profile.repository.url).toBe(`${repository}.git`);
  expect(queries.requirement_status).toHaveBeenCalledWith('requirement_id', run.requirementId);
  expect(queries.requirement_status).toHaveBeenCalledWith('site_id', run.siteId);
  expect(queries.requirement_status).toHaveBeenCalledWith('instance_id', run.instanceId);
});
it('skips recent commit checkpoints to recover the older existing-app branch', async () => {
  history = [{ repo_url: `${repository}/tree/${'a'.repeat(40)}` },
    { repo_url: `${repository}/tree/${encodeURIComponent(existingBranch)}` }];
  expect((await buildRequirementProfile(run, context)).branch).toBe(existingBranch);
});
it('does not let another repo, requirement, malformed URL or unsafe ref mask valid history', async () => {
  history = [
    { repo_url: 'not a URL' },
    { repo_url: `${repository}/tree/%ZZ` },
    { repo_url: `https://github.com/example/other/tree/${existingBranch}` },
    { repo_url: `${repository}/tree/feature/req-${randomUUID()}` },
    { repo_url: `${repository}/tree/${existingBranch}%0Aunsafe` },
    { repo_url: `${repository}/tree/${existingBranch}?untrusted=1` },
    { repo_url: `${repository}/tree/${existingBranch}` },
  ];
  expect((await buildRequirementProfile(run, context)).branch).toBe(existingBranch);
});
it('retains the canonical branch for a new app without trusted branch history', async () => {
  history = [{ repo_url: `${repository}/tree/${'b'.repeat(40)}` }];
  expect((await buildRequirementProfile(run, context)).branch).toBe(`feature/req-${run.requirementId}`);
});
it('checks out the existing landing bytes rather than main scaffold using real local Git', async () => {
  const root = mkdtempSync(join(tmpdir(), 'requirement-existing-app-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error('Offline Git fixture failed');
  };
  try {
    git('init', '-b', 'main');
    writeFileSync(join(root, 'landing.html'), '<main>Base documentation scaffold</main>');
    git('add', '.'); git('-c', 'user.name=Offline', '-c', 'user.email=offline@example.invalid', 'commit', '-m', 'scaffold');
    git('switch', '-c', existingBranch);
    const landing = '<main><h1>Cedar Workshop</h1><a href="/reservations">Book</a></main>';
    writeFileSync(join(root, 'landing.html'), landing);
    git('add', '.'); git('-c', 'user.name=Offline', '-c', 'user.email=offline@example.invalid', 'commit', '-m', 'existing app');
    git('switch', 'main');
    history = [{ repo_url: `${repository}/tree/${'a'.repeat(40)}` },
      { repo_url: `${repository}/tree/${encodeURIComponent(existingBranch)}` }];
    const profile = await buildRequirementProfile(run, context);
    git('switch', profile.branch);
    expect(readFileSync(join(root, 'landing.html'), 'utf8')).toBe(landing);
  } finally { rmSync(root, { recursive: true, force: true }); }
});