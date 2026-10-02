import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { getHarnessReference, HARNESS_SOURCE_ALLOWLIST } from '@/lib/services/harness-diagnostics/reference';
import { HARNESS_SOURCE_LIMITS, readHarnessSource } from '@/lib/services/harness-diagnostics/source';
import { HARNESS_DIAGNOSTIC_GUIDANCE } from '@/lib/services/harness-diagnostics/guidance';

// Importing the reference/reader must not initialize either runtime.
jest.mock('@/lib/database/supabase-client', () => { throw new Error('DB must not load'); });
jest.mock('next/server', () => { throw new Error('Next routes must not load'); });
jest.mock('@vercel/sandbox', () => { throw new Error('Sandbox must not load'); });

const repoRoot = process.cwd();
const originalRevision = process.env.VERCEL_GIT_COMMIT_SHA;
const sourcePath = HARNESS_SOURCE_ALLOWLIST[0];
const sqlPaths = [
  'supabase/migrations/20260930010000_requirement_migration_lifecycle.sql',
  'supabase/migrations/20261001220000_harness_diagnostic_decisions.sql',
  'supabase/migrations/20261002100000_apps_migration_feedback.sql',
];
const causalPaths = [
  'src/app/api/cron/shared/step-probe-validation-targets.ts',
  'src/app/api/cron/shared/step-probe-policy.ts',
  'src/app/api/cron/shared/step-runtime-probe.ts',
  'src/app/api/cron/shared/cycle-wrapup-step.ts',
  'src/lib/services/cycle-wrapup-prompt.ts',
  'src/lib/services/cycle-wrapup-state.ts',
  'src/lib/services/harness-diagnostics/cycle-escalation.ts',
  'src/app/api/cron/requirements-apps/workflow.ts',
  'src/app/api/cron/requirements-apps/route-state.ts',
  'src/lib/services/requirement-status-recovery.ts',
  'src/lib/helpers/plan-lifecycle-cancellation.ts',
  'src/lib/services/apps-platform/migration-applier.ts',
  'src/lib/services/apps-platform/migration-lifecycle.ts',
  ...sqlPaths,
];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
let root: string;

async function fixture(path: string, content: string | Buffer) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'harness-reference-')));
  jest.spyOn(process, 'cwd').mockReturnValue(root);
  delete process.env.VERCEL_GIT_COMMIT_SHA;
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (originalRevision === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = originalRevision;
  await rm(root, { recursive: true, force: true });
});

describe('getHarnessReference', () => {
  it('returns actionable architecture and topic discovery, not live-state claims', () => {
    const result = getHarnessReference();
    expect(result).toMatchObject({ read_only: true, build_revision: 'unknown' });
    expect(result.topics).toEqual(expect.arrayContaining([
      'architecture', 'status', 'execute_step', 'recover', 'diagnose',
      'report_blocker', 'acceptance', 'migrations', 'runtime', 'capabilities',
    ]));
    expect(result.scope).toContain('not verification');
    expect(JSON.stringify(result.reference)).not.toMatch(/judge/i);
    expect(JSON.stringify(getHarnessReference('execute_step'))).toContain('does not start');
    expect(JSON.stringify(getHarnessReference('report_blocker'))).toContain('plan-cancellation');
    expect(JSON.stringify(getHarnessReference('acceptance'))).toContain('do not weaken');
    expect(JSON.stringify(getHarnessReference('migrations'))).toContain('Never apply migrations');
    expect(JSON.stringify(getHarnessReference('capabilities'))).toContain('do not register themselves');
    expect(JSON.stringify(getHarnessReference('decisions'))).toContain('stored is not sent');
  });

  it('links causal admission, cancellation and migration sources without claiming live DB state', () => {
    const result = getHarnessReference();
    for (const path of causalPaths) {
      expect(HARNESS_SOURCE_ALLOWLIST).toContain(path);
      expect(JSON.stringify(result.reference)).toContain(path);
    }
    expect(JSON.stringify(getHarnessReference('recover'))).toContain('migration_review_pending');
    expect(JSON.stringify(getHarnessReference('report_blocker'))).toContain('cancellation receipts');
    expect(JSON.stringify(getHarnessReference('migrations'))).toContain('Reading it must not apply it');
  });

  it('describes the simplified executor separately from historical migration holds', () => {
    const migrations = JSON.stringify(getHarnessReference('migrations'));
    expect(migrations).toContain('same implementation step');
    expect(migrations).toContain('not an LLM review');
    expect(migrations).toContain('deployment does not release');
    for (const path of ['src/lib/services/apps-platform/migration-execution.ts',
      'src/lib/services/apps-platform/migration-feedback.ts',
      'src/app/api/cron/shared/gates/gate-database.ts']) {
      expect(HARNESS_SOURCE_ALLOWLIST).toContain(path);
      expect(migrations).toContain(path);
    }
  });

  it('distinguishes local tool exposure from runner provisioning and links the actual implementation', () => {
    const runtime = getHarnessReference('runtime');
    const capabilities = JSON.stringify(getHarnessReference('capabilities'));
    for (const path of [
      'src/app/api/cron/shared/cron-sandbox-lifecycle-steps.ts',
      'src/lib/services/sandbox-recovery.ts',
      'src/app/api/cron/shared/cron-orchestrator-step.ts',
      'src/lib/services/workflow-robot/sandbox-workspace.ts',
      'src/lib/services/apps-platform/migration-diagnostic-agent.ts',
    ]) {
      expect(HARNESS_SOURCE_ALLOWLIST).toContain(path);
      expect(JSON.stringify(runtime)).toContain(path);
    }
    expect(JSON.stringify(runtime)).toContain('After admission/preflight gates');
    expect(JSON.stringify(runtime)).toContain('sandbox-backed restricted migration_read_context reader');
    expect(JSON.stringify(runtime)).toContain('role name alone does not determine exposure');
    expect(capabilities).toContain('not a health probe or dispatch gate');
    expect(capabilities).toContain('false does not prove global incapability');
    expect(capabilities).toContain('true does not prove every sandbox operation is exposed or authorized');
    expect(capabilities).toContain('Missing receipts remain unknown, not permanently unavailable');
    expect(capabilities).toContain('Never auto-expose tools, bypass holds, reset budgets or change ownership');
    expect(JSON.stringify(getHarnessReference('migrations'))).toContain('not proof of sensitive SQL or an already-applied migration');
  });

  it('keeps shared prompt and orchestration skill guidance invocation-local without bypass instructions', async () => {
    const skill = await readFile(join(repoRoot, 'src/skills/makinari-rol-orchestrator/SKILL.md'), 'utf8');
    expect(HARNESS_DIAGNOSTIC_GUIDANCE).toContain('sandbox_tools_exposed=false is invocation-local');
    expect(HARNESS_DIAGNOSTIC_GUIDANCE).toContain('even the same instance can expose different tools on another invocation');
    expect(HARNESS_DIAGNOSTIC_GUIDANCE).toContain('Missing evidence means unknown, not permanently unavailable');
    expect(HARNESS_DIAGNOSTIC_GUIDANCE).toContain('Never invent or auto-expose tools');
    expect(HARNESS_DIAGNOSTIC_GUIDANCE).toContain('unknowns do not release the hold');
    expect(skill).toContain('Loading this skill does not provision it or expose tools');
    expect(skill).toContain('sandbox_tools_exposed=false');
    expect(skill).toContain('Missing observations remain unknown');
    expect(skill).toContain('not proof of sensitive SQL or a previously applied migration');
    expect(skill).toContain('Do not invent tools, auto-expose them');
  });

  it('selects exact normalized topics, rejects prototype keys and returns detached objects', () => {
    expect(Object.keys(getHarnessReference(' STATUS ').reference)).toEqual(['status']);
    for (const topic of ['unknown', '__proto__', 'constructor']) {
      expect(getHarnessReference(topic)).toMatchObject({ error: 'unknown_topic', reference: {} });
    }
    const result = getHarnessReference();
    (result.reference as any).status.checks.length = 0;
    expect((getHarnessReference().reference as any).status.checks.length).toBeGreaterThan(0);
    expect(Object.isFrozen(HARNESS_SOURCE_ALLOWLIST)).toBe(true);
  });

  it('uses only the declared revision env var, without treating it as deployment/DB proof', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'test-build-revision';
    expect(getHarnessReference().build_revision).toBe('test-build-revision');
    const result = await readHarnessSource({ action: 'search', query: 'needle' });
    expect(result.build_revision).toBe('test-build-revision');
    expect(result.scope).toContain('not verified');
  });
});

describe('readHarnessSource', () => {
  it.each([
    '../.env', '.env', '.env.local', '/etc/passwd', `${repoRoot}/${sourcePath}`,
    `./${sourcePath}`, 'src/../.env', 'src/%2e%2e/.env', 'src\\..\\.env',
    `${sourcePath}\0`, `${sourcePath}/../assistantProtocol.ts`,
    'src/lib/database/supabase-client.ts', 'customer/private.json', 'src/**',
    'supabase/migrations/20261001220001_customer_data.sql', 'supabase/migrations/*.sql',
  ])('denies non-allowlisted model path %s for both actions', async path => {
    await expect(readHarnessSource({ action: 'read', path })).rejects.toBeInstanceOf(z.ZodError);
    await expect(readHarnessSource({ action: 'search', query: 'x', path })).rejects.toBeInstanceOf(z.ZodError);
  });

  it.each([
    {}, { action: 'write', path: sourcePath }, { action: 'read' },
    { action: 'read', path: sourcePath, start_line: 0 },
    { action: 'read', path: sourcePath, start_line: 1.5 },
    { action: 'read', path: sourcePath, limit: 201 },
    { action: 'read', path: sourcePath, limit: '2' },
    { action: 'read', path: sourcePath, query: 'x' },
    { action: 'search', query: '' }, { action: 'search', query: '   ' },
    { action: 'search', query: 'x\ny' }, { action: 'search', query: 'x'.repeat(201) },
    { action: 'search', query: 'x', limit: 51 },
    { action: 'search', query: 'x', start_line: 2 },
    { action: 'search', query: 'x', root: '/etc' },
  ])('validates strict bounded input: %j', async input => {
    await expect(readHarnessSource(input)).rejects.toBeInstanceOf(z.ZodError);
  });

  it('reads one-based pages with stable redacted-file and exact page hashes', async () => {
    await fixture(sourcePath, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
    const first = await readHarnessSource({ action: 'read', path: sourcePath, limit: 2 });
    expect(first).toMatchObject({ action: 'read', start_line: 1, end_line: 2,
      next_start_line: 3, total_lines: 5, content: 'one\ntwo',
      content_sha256: sha256('one\ntwo'), sha256: sha256('one\ntwo\nthree\nfour\nfive\n') });
    const second = await readHarnessSource({ action: 'read', path: sourcePath, start_line: 3, limit: 2 });
    expect(second).toMatchObject({ content: 'three\nfour', next_start_line: 5, end_line: 4 });
    expect((second as any).sha256).toBe((first as any).sha256);
    expect(await readHarnessSource({ action: 'read', path: sourcePath, start_line: 5 })).toMatchObject({
      content: 'five', next_start_line: null, end_line: 5,
    });
    expect(await readHarnessSource({ action: 'read', path: sourcePath, start_line: 99 })).toMatchObject({
      content: '', next_start_line: null, end_line: null, total_lines: 5,
    });
    await fixture(sourcePath, '');
    expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ total_lines: 0, content: '' });
  });

  it('bounds page content, flags oversized lines and makes forward progress', async () => {
    await fixture(sourcePath, Array(30).fill('x'.repeat(3_000)).join('\n'));
    const result = await readHarnessSource({ action: 'read', path: sourcePath, limit: 200 }) as any;
    expect(result.content.length).toBeLessThanOrEqual(HARNESS_SOURCE_LIMITS.response_chars);
    expect(result.truncated_lines.length).toBeGreaterThan(0);
    expect(result.next_start_line).toBe(result.end_line + 1);
    expect(result.content.split('\n')[0].length).toBe(HARNESS_SOURCE_LIMITS.line_chars);
  });

  it('searches literal metacharacters, returns an allowlist-only index and bounds matches', async () => {
    await fixture(sourcePath, 'literal .* [x] (a+)+$\nplain aaaaa\nliteral .* again\n');
    await fixture('.env', 'UNINDEXED_ENV_NEEDLE');
    await fixture('customer/data.ts', 'UNINDEXED_CUSTOMER_NEEDLE');
    await fixture('src/lib/services/not-allowlisted.ts', 'UNINDEXED_SOURCE_NEEDLE');
    const result = await readHarnessSource({ action: 'search', query: '.*', limit: 1 }) as any;
    expect(result).toMatchObject({ total_matches: 2, truncated: true });
    expect(result.matches).toEqual([expect.objectContaining({ path: sourcePath, line: 1, content: 'literal .* [x] (a+)+$' })]);
    expect(result.index).toEqual([expect.objectContaining({ path: sourcePath, total_lines: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    for (const query of ['[x]', '(a+)+$']) {
      expect(await readHarnessSource({ action: 'search', path: sourcePath, query })).toMatchObject({ total_matches: 1 });
    }
    expect(await readHarnessSource({ action: 'search', query: 'UNINDEXED' })).toMatchObject({ total_matches: 0 });
    expect(JSON.stringify(result)).not.toContain(root);
    await fixture(sourcePath, Array(40).fill('x'.repeat(2_500)).join('\n'));
    const bounded = await readHarnessSource({ action: 'search', query: 'x', limit: 50 }) as any;
    expect(bounded.total_matches).toBe(40);
    expect(bounded.truncated).toBe(true);
    expect(bounded.matches.reduce((sum: number, match: any) => sum + match.content.length, 0)).toBeLessThanOrEqual(HARNESS_SOURCE_LIMITS.response_chars);
  });

  it('redacts before pagination and literal search, retaining multiline source coordinates', async () => {
    // Keep realistic syntax, but generate all credential values at test runtime.
    const literal = randomBytes(16).toString('hex');
    const bearer = randomBytes(16).toString('hex');
    const cookie = randomBytes(16).toString('hex');
    const param = randomBytes(16).toString('hex');
    const provider = `ghp_${randomBytes(16).toString('hex')}`;
    const multiline = randomBytes(16).toString('hex');
    const databaseUrl = new URL('postgres://example.invalid/db');
    databaseUrl.username = 'fixture-reader';
    databaseUrl.password = randomBytes(16).toString('hex');
    databaseUrl.searchParams.set('token', param);
    const secrets = [literal, bearer, cookie, databaseUrl.username, databaseUrl.password, param,
      provider, 'person@example.test', 'private-line', 'second-private-line', multiline];
    const text = [
      `const SERVICE_ROLE_KEY = '${literal}';`,
      `Authorization: Bearer ${bearer}`, `Cookie: ${cookie}`,
      databaseUrl.href,
      provider, 'person@example.test',
      '-----BEGIN PRIVATE KEY-----', 'private-line', 'second-private-line', '-----END PRIVATE KEY-----',
      'const password = `', multiline, '`;', 'SAFE_END',
    ].join('\n');
    await fixture(sourcePath, text);
    const full = await readHarnessSource({ action: 'read', path: sourcePath }) as any;
    expect(full.content).toContain('[REDACTED');
    expect(full.total_lines).toBe(14);
    expect(full.sha256).not.toBe(sha256(text));
    for (const secret of secrets) {
      expect(JSON.stringify(full)).not.toContain(secret);
      expect(await readHarnessSource({ action: 'search', path: sourcePath, query: secret })).toMatchObject({ total_matches: 0 });
    }
    expect(await readHarnessSource({ action: 'read', path: sourcePath, start_line: 8, limit: 1 })).toMatchObject({ content: '[REDACTED]' });
    expect(await readHarnessSource({ action: 'search', query: 'SAFE_END' })).toMatchObject({ matches: [expect.objectContaining({ line: 14 })] });
  });

  it('fails closed on symlinked files and parent directories, including in-root aliases', async () => {
    const secret = await fixture('.env', 'SYMLINK_SECRET');
    const absolute = join(root, sourcePath);
    await mkdir(dirname(absolute), { recursive: true });
    for (const target of [secret, join(repoRoot, sourcePath)]) {
      await symlink(target, absolute);
      expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ error: 'unsafe_file' });
      expect(await readHarnessSource({ action: 'search', query: 'SYMLINK_SECRET' })).toMatchObject({ total_matches: 0 });
      await rm(absolute);
    }
    const alias = join(root, 'alias');
    await mkdir(alias);
    await writeFile(join(alias, 'assistantProtocol.ts'), 'SYMLINK_SECRET');
    await rm(dirname(absolute), { recursive: true });
    await symlink(alias, dirname(absolute), 'dir');
    expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ error: 'unsafe_file' });
  });

  it('redacts quoted assignments split across lines and known provider tokens', async () => {
    const split = randomBytes(16).toString('hex');
    const provider = `sk-${randomBytes(16).toString('hex')}`;
    const jwtHeader = `eyJ${randomBytes(16).toString('hex')}`;
    const jwt = `${jwtHeader}.${randomBytes(16).toString('hex')}.${randomBytes(16).toString('hex')}`;
    const text = `const apiKey =\n "${split}";\nconst key = "${provider}";\nconst t = "${jwt}";`;
    await fixture(sourcePath, text);
    const result = await readHarnessSource({ action: 'read', path: sourcePath }) as any;
    expect(result.total_lines).toBe(4);
    expect(result.content).not.toContain(split);
    expect(result.content).not.toContain(provider);
    expect(result.content).not.toContain(jwtHeader);
  });

  it('rejects oversized, binary, invalid UTF-8, directory and hardlinked files', async () => {
    await fixture(sourcePath, Buffer.alloc(HARNESS_SOURCE_LIMITS.file_bytes + 1, 120));
    expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ error: 'file_too_large' });
    for (const content of [Buffer.from([0, 1]), Buffer.from([0xff, 0xfe])]) {
      await fixture(sourcePath, content);
      expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ error: 'not_text' });
    }
    await rm(join(root, sourcePath));
    await mkdir(join(root, sourcePath));
    expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ error: 'unsafe_file' });
    await rm(join(root, sourcePath), { recursive: true });
    await link(await fixture('.env', 'hardlink-secret'), join(root, sourcePath));
    expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ error: 'unsafe_file' });
  });

  it('reports missing deployment sources without absolute paths or fallback', async () => {
    expect(await readHarnessSource({ action: 'read', path: sourcePath })).toMatchObject({ path: sourcePath, error: 'unavailable' });
    const result = await readHarnessSource({ action: 'search', query: 'needle' }) as any;
    expect(result.index).toEqual([]);
    expect(result.unavailable).toHaveLength(HARNESS_SOURCE_ALLOWLIST.length);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it.each(sqlPaths)('reads only the exact platform SQL file as redacted text: %s', async path => {
    await fixture(path, '-- PLATFORM_SCHEMA_REFERENCE\n-- Bearer fixture-sql-secret\nSELECT 1;\n');
    expect(await readHarnessSource({ action: 'read', path, start_line: 2, limit: 1 })).toMatchObject({
      content: '-- Bearer [REDACTED]', start_line: 2, end_line: 2, next_start_line: 3,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await readHarnessSource({ action: 'search', path, query: 'PLATFORM_SCHEMA_REFERENCE' })).toMatchObject({
      total_matches: 1, matches: [expect.objectContaining({ path, line: 1 })],
    });
    expect(await readHarnessSource({ action: 'search', path, query: 'fixture-sql-secret' })).toMatchObject({ total_matches: 0 });
  });

  it('keeps every citation in the exact tracing allowlist and honors repository file-size limits', async () => {
    jest.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    expect(new Set(HARNESS_SOURCE_ALLOWLIST).size).toBe(HARNESS_SOURCE_ALLOWLIST.length);
    for (const section of Object.values(getHarnessReference().reference) as any[]) {
      for (const path of section.sources) expect(HARNESS_SOURCE_ALLOWLIST).toContain(path);
    }
    for (const path of HARNESS_SOURCE_ALLOWLIST) {
      if (!sqlPaths.includes(path)) expect(path).toMatch(/^src\/.*\.ts$/);
      expect(path).not.toMatch(/(?:^|\/)(?:route\.ts|\.env|customers?|secrets?)$/);
      const text = await readFile(join(repoRoot, path), 'utf8');
      expect(text.length).toBeGreaterThan(0);
      const result = await readHarnessSource({ action: 'read', path, limit: 1 }) as any;
      if (Buffer.byteLength(text, 'utf8') > HARNESS_SOURCE_LIMITS.file_bytes) {
        expect(result.error).toBe('file_too_large');
        expect(await readHarnessSource({ action: 'search', path, query: 'export' })).toMatchObject({
          index: [], unavailable: [{ path, error: 'file_too_large' }], total_matches: 0,
        });
        continue;
      }
      expect(result.error).toBeUndefined();
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});