import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, symlinkSync, linkSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SandboxService } from '@/lib/services/sandbox-service';
import { readArtifactProof } from '../feature-coverage-probes';
import { computeFeatureCoverage } from '../feature-coverage';
import { matchAcceptanceAgainstEvidence } from '../archetype-acceptance-match';
import type { EvidenceRecord } from '@/lib/services/requirement-evidence-types';
import type { AcceptanceContract } from '@/lib/services/requirement-acceptance-contract';

jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '' } }));

const directory = 'supabase/migrations';
const creation = `Creates ${directory} with users vehicles loads bids tables.`;
const application = 'Applies migrations to Supabase.';
const acceptance = [creation, application];
const contract: AcceptanceContract = {
  schema_version: 1,
  criteria: [
    { id: 'create', text: creation, all_of: [{ kind: 'file_artifact', path: directory }] },
    { id: 'apply', text: application, all_of: [{ kind: 'semantic_assertion', text: application }] },
  ],
};
const sql = ['users', 'vehicles', 'loads', 'bids']
  .map(table => `CREATE TABLE ${table} (id integer PRIMARY KEY);`).join('\n');

describe('artifact evidence (real sandbox scripts, offline filesystem)', () => {
  let root: string;
  let outside: string;
  let runCommand: jest.Mock;
  let injected: string;
  const file = (relative: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), content);
  };
  const proof = (relative = directory) => readArtifactProof({ runCommand } as any, relative);
  const record = (artifact: Awaited<ReturnType<typeof proof>>, changedFiles: string[]): EvidenceRecord => ({
    schema_version: 1, item_id: 'cargo-schema', captured_at: new Date().toISOString(), critic_passes: 0,
    changed_files: changedFiles,
    feature_coverage: { ok: artifact.outcome === 'pass', artifact_proofs: [artifact] },
    tests: [{ command: 'npm test -- schema', exit_code: 0, ran_after_changes: true,
      output_tail: 'PASS schema users vehicles loads bids. Applies migrations to Supabase.' }],
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-evidence-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-outside-')));
    (SandboxService as any).WORK_DIR = root;
    injected = '';
    runCommand = jest.fn(async ({ cmd, args, timeoutMs }) => {
      expect(cmd).toBe('node');
      const child = spawnSync(process.execPath, ['-e', injected + args[1], args[2]], {
        cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024,
        // No inherited secrets, NODE_OPTIONS, .env, Next config or provider calls.
        env: { NODE_ENV: 'test' },
      });
      expect(child.stderr).toBe('');
      return { exitCode: child.status ?? 1, stdout: async () => child.stdout };
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('collects bounded SQL child content, not directory metadata bytes', async () => {
    file(`${directory}/0002_other.sql`, 'ALTER TABLE users ADD COLUMN name text;');
    file(`${directory}/nested/0003.sql`, 'CREATE INDEX users_name ON users(name);');
    file(`${directory}/0001_core.sql`, sql);
    file(`${directory}/README.md`, 'not migration SQL');
    const artifact = await proof();
    expect(artifact).toMatchObject({ path: directory, kind: 'directory', exists: true, outcome: 'pass', truncated: false });
    expect(artifact.entries?.map(entry => entry.path)).toEqual([
      `${directory}/0001_core.sql`, `${directory}/0002_other.sql`, `${directory}/nested/0003.sql`,
    ]);
    expect(artifact.bytes).toBe(artifact.entries?.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(artifact.content_excerpt).toContain('CREATE TABLE bids');
    expect(artifact.content_excerpt).not.toContain('not migration SQL');
    expect(JSON.stringify(artifact)).not.toContain(root);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('removes the coverage evidence gap for a directory but keeps application unproven', async () => {
    const child = `${directory}/0001_core.sql`;
    file(child, sql);
    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any, contractScoped: true,
        item: { id: 'cargo-schema', title: 'NEX CARGO schema', kind: 'subtask', phase_id: 'build',
        status: 'in_progress', scope_level: 'full', attempts: 0, tier: 'core',
        acceptance, acceptance_contract: contract, touches: [directory] },
    });
    expect(coverage).toMatchObject({ ok: true, evaluable: true,
      present_touches: [directory], not_evaluable_touches: [], probe_errors: [] });
    const evidence = { ...record(coverage.artifact_proofs[0], [child]), feature_coverage: coverage };
    expect(matchAcceptanceAgainstEvidence(acceptance, evidence, contract)).toMatchObject({
      matched: [creation], unmatched: [application], contradicted: [],
      diagnostics: [
        { status: 'matched', gaps: [] },
        { status: 'missing', gaps: [{ code: 'missing_semantic_receipt', class: 'evidence' }] },
      ],
    });
    const compound = `${creation} ${application}`;
    expect(matchAcceptanceAgainstEvidence([compound], evidence, {
      schema_version: 1, criteria: [{ id: 'both', text: compound,
        all_of: [...contract.criteria[0].all_of, ...contract.criteria[1].all_of] }],
    }).matched).toEqual([]);
  });

  it.each([[], [directory], [`${directory}/deleted.sql`], ['supabase/migrations-old/0001_core.sql']].map(changed => ({ changed })))(
    'does not treat uninspected/deleted/similarly prefixed changes $changed as fresh evidence', async ({ changed }) => {
      file(`${directory}/0001_core.sql`, sql);
      const artifact = await proof();
      expect(matchAcceptanceAgainstEvidence(acceptance, record(artifact, changed), contract).matched).toEqual([]);
    },
  );

  it('does not borrow table words from an unchanged child or a filename', async () => {
    file(`${directory}/0001_users_vehicles_loads_bids.sql`, 'SELECT 1;');
    file(`${directory}/0002.sql`, sql);
    const artifact = await proof();
    expect(matchAcceptanceAgainstEvidence(acceptance,
      record(artifact, [`${directory}/0001_users_vehicles_loads_bids.sql`]), contract).matched).toEqual([]);
  });

  it('cannot turn a file-only application claim into applied success', async () => {
    const child = `${directory}/0001.sql`;
    file(child, sql);
    const text = `Applies ${directory} with users vehicles loads bids tables to Supabase.`;
    expect(matchAcceptanceAgainstEvidence([text], record(await proof(), [child]), {
      schema_version: 1, criteria: [{ id: 'apply-file-only', text,
        all_of: [{ kind: 'file_artifact', path: directory }] }],
    }).matched).toEqual([]);
  });

  it.each(['empty', 'placeholder', 'zero-byte'])('does not pass %s migration directories', async mode => {
    mkdirSync(join(root, directory), { recursive: true });
    if (mode === 'placeholder') file(`${directory}/.gitkeep`, '');
    if (mode === 'zero-byte') file(`${directory}/0001.sql`, '');
    const artifact = await proof();
    expect(artifact).toMatchObject({ exists: true, kind: 'directory', outcome: 'fail', bytes: 0 });
    expect(matchAcceptanceAgainstEvidence(acceptance, record(artifact, [`${directory}/0001.sql`]), contract).matched).toEqual([]);
  });

  it('distinguishes a missing path from command/permission failures', async () => {
    expect(await proof()).toMatchObject({ exists: false, outcome: 'fail' });
    file(`${directory}/0001.sql`, sql);
    injected = `const f = require('node:fs'); f.opendirSync = () => { throw Object.assign(new Error('private OS detail'), {code:'EACCES'}); };`;
    expect(await proof()).toMatchObject({ exists: true, kind: 'directory', outcome: 'not_evaluable', error: 'unavailable' });
    runCommand.mockResolvedValueOnce({ exitCode: 1, stdout: async () => '' });
    expect(await proof()).toMatchObject({ outcome: 'not_evaluable' });
    const marker = randomBytes(20).toString('hex');
    runCommand.mockRejectedValueOnce(new Error(marker));
    expect(JSON.stringify(await proof())).not.toContain(marker);
  });

  it.each(['file', 'parent', 'directory', 'internal'])('rejects %s symlinks without reading their target', async mode => {
    const marker = randomBytes(24).toString('hex');
    writeFileSync(join(outside, '0001.sql'), marker);
    file('safe/0001.sql', sql);
    mkdirSync(join(root, 'supabase'), { recursive: true });
    let relative = directory;
    if (mode === 'parent') {
      rmSync(join(root, 'supabase'), { recursive: true });
      symlinkSync(outside, join(root, 'supabase'));
      relative = 'supabase/0001.sql';
    } else if (mode === 'directory' || mode === 'internal') {
      symlinkSync(mode === 'internal' ? join(root, 'safe') : outside, join(root, directory));
    } else {
      mkdirSync(join(root, directory));
      symlinkSync(join(outside, '0001.sql'), join(root, directory, '0001.sql'));
      relative = `${directory}/0001.sql`;
    }
    const artifact = await proof(relative);
    expect(artifact.outcome).toBe('not_evaluable');
    expect(JSON.stringify(artifact)).not.toContain(marker);
  });

  it('skips symlink children and secret/generated trees before opening any contents', async () => {
    const marker = randomBytes(24).toString('hex');
    file(`${directory}/0001.sql`, sql);
    writeFileSync(join(outside, 'outside.sql'), marker);
    symlinkSync(join(outside, 'outside.sql'), join(root, directory, 'linked.sql'));
    symlinkSync(outside, join(root, directory, 'linked-dir'));
    for (const path of ['.env', '.env.local', '.git/config', '.hidden/hidden.sql', 'secrets/key.sql',
      'credentials.json', 'node_modules/pkg/code.sql', '.next/code.sql', 'dist/code.sql', 'key.pem']) {
      file(`${directory}/${path}`, marker);
    }
    // Observe actual reads, not just the returned output: excluded files must never be opened.
    injected = `const f = require('node:fs'), open = f.openSync;
      f.openSync = (name, ...args) => {
        if (/linked|\\.env|\\.git|\\.hidden|secrets|credentials|node_modules|\\.next|dist|key\\.pem/.test(String(name))) throw new Error('FORBIDDEN_READ');
        return open(name, ...args);
      };`;
    const artifact = await proof();
    expect(artifact.outcome).toBe('pass');
    expect(artifact.entries).toHaveLength(1);
    expect(JSON.stringify(artifact)).not.toContain(marker);
  });

  it('refuses direct secret paths, hardlinks, binary files and FIFOs', async () => {
    const marker = randomBytes(24).toString('hex');
    file(`${directory}/.env`, marker);
    expect(await proof(`${directory}/.env`)).toMatchObject({ outcome: 'not_evaluable' });
    writeFileSync(join(outside, 'outside.sql'), marker);
    linkSync(join(outside, 'outside.sql'), join(root, directory, 'hardlink.sql'));
    expect(await proof(`${directory}/hardlink.sql`)).toMatchObject({ outcome: 'not_evaluable' });
    file(`${directory}/binary.sql`, Buffer.from([0, 1, 2, 255]));
    expect(await proof(`${directory}/binary.sql`)).toMatchObject({ outcome: 'not_evaluable', error: 'not_text' });
    expect(spawnSync('/usr/bin/mkfifo', [join(root, directory, 'pipe.sql')]).status).toBe(0);
    expect(await proof(`${directory}/pipe.sql`)).toMatchObject({ outcome: 'not_evaluable', error: 'unsafe_file' });
  });

  it.each(['file', 'parent'])('rejects a concurrent %s symlink replacement before content reads', async mode => {
    file(`${directory}/0001.sql`, sql);
    const marker = randomBytes(24).toString('hex');
    writeFileSync(join(outside, '0001.sql'), marker);
    injected = `const f = require('node:fs'), open = f.openSync;
      f.openSync = (name, ...args) => {
        if (${JSON.stringify(mode)} === 'file') {
          f.unlinkSync(${JSON.stringify(join(root, directory, '0001.sql'))});
          f.symlinkSync(${JSON.stringify(join(outside, '0001.sql'))}, ${JSON.stringify(join(root, directory, '0001.sql'))});
        } else {
          f.renameSync(${JSON.stringify(join(root, directory))}, ${JSON.stringify(join(root, 'original'))});
          f.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(join(root, directory))});
        }
        return open(name, ...args);
      };
      f.readSync = () => { f.writeFileSync(${JSON.stringify(join(outside, 'read-attempt'))}, 'read'); throw new Error('FORBIDDEN_READ'); };`;
    const artifact = await proof(`${directory}/0001.sql`);
    expect(artifact).toMatchObject({ outcome: 'not_evaluable' });
    expect(existsSync(join(outside, 'read-attempt'))).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain(marker);
  });

  it('redacts synthetic credentials before clipping child excerpts, including read boundaries', async () => {
    const values = Array.from({ length: 7 }, () => randomBytes(24).toString('hex'));
    const url = new URL('https://example.invalid/source');
    url.username = values[0]; url.password = values[1];
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${values[2]}\n-----END PRIVATE KEY-----`;
    const source = `-- ${url}\n-- ${privateKey}\n-- api_key = '${values[3]}'\n-- secret = "${values[4]}\n${values[5]}"\n${sql}\n`;
    file(`${directory}/0001.sql`, source + ' '.repeat(3900 - Buffer.byteLength(source)) + `password = '${values[6].repeat(6)}`);
    const artifact = await proof();
    expect(artifact.outcome).toBe('pass');
    expect(artifact.content_excerpt).toContain('CREATE TABLE users');
    for (const value of values) expect(JSON.stringify(artifact)).not.toContain(value);
  });

  it.each(['files', 'entries', 'depth'])('fails closed on %s discovery limits', async mode => {
    if (mode === 'files') for (let i = 0; i < 21; i++) file(`${directory}/${i}.sql`, sql);
    if (mode === 'entries') for (let i = 0; i < 201; i++) file(`${directory}/${i}.log`, '');
    if (mode === 'depth') file(`${directory}/a/b/c/d/e.sql`, sql);
    expect(await proof()).toMatchObject({ exists: true, kind: 'directory', outcome: 'not_evaluable', truncated: true });
  });

  it('caps output and reads even for large SQL and exposes content truncation', async () => {
    file(`${directory}/0001.sql`, sql + '\n' + '-- bounded\n'.repeat(10000));
    const artifact = await proof();
    expect(artifact.outcome).toBe('pass');
    expect(artifact.content_excerpt!.length).toBeLessThanOrEqual(4000);
    expect(artifact.entries?.[0].content_truncated).toBe(true);
    expect(artifact.entries?.[0].content_excerpt.length).toBeLessThanOrEqual(3200);
  });

  it('keeps ordinary file evidence and legacy app path normalization', async () => {
    file('src/app/page.tsx', 'export default function Page() { return <main />; }');
    expect(await proof('/app/page.tsx')).toMatchObject({ path: 'src/app/page.tsx', kind: 'file', outcome: 'pass', bytes: 51 });
    file('docs/release/readme.md', 'Release notes');
    expect(await proof('docs/release')).toMatchObject({ kind: 'directory', outcome: 'pass' });
  });
});