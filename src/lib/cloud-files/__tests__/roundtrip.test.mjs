import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';

// Execute the actual tools -> store -> service-role SQL pipeline, not hand-built
// revision mocks. Only external import locations/default provider clients change.
const source = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const moduleUrl = input => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(input, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64')}`;
const typesUrl = moduleUrl(source('../types.ts'));
const storeUrl = moduleUrl(source('../store.ts')
  .replace("import { supabaseAdmin } from '@/lib/database/supabase-client';",
    'const supabaseAdmin = { rpc() { throw new Error("Unexpected default database access"); } };')
  .replaceAll("'./types'", JSON.stringify(typesUrl)));
const screenUrl = moduleUrl(`
  export class ToolScreenAccessDenied extends Error {}
  export class ToolScreenAccessUnavailable extends Error {}
  export const checks = [];
  export let denied = false;
  export function deny(value) { denied = value; }
  export async function assertToolScreenAccess(name, scope) {
    checks.push({name, scope});
    if (denied) throw new ToolScreenAccessDenied();
  }
`);
const gitUrl = moduleUrl('export class CloudGitError extends Error {} export async function publishCloudRevision() { throw new Error("Unexpected network provider"); }');
const toolSource = source('../tools.ts');
// Fail if the production dependency graph tries to introduce workspace effects.
assert.doesNotMatch(toolSource, /(?:from\s*|import\s*\()["'][^"']*(?:sandbox|workspace|child_process)/);
const toolsUrl = moduleUrl(toolSource
  .replaceAll("'zod'", JSON.stringify(import.meta.resolve('zod')))
  .replaceAll("'zod-to-json-schema'", JSON.stringify(import.meta.resolve('zod-to-json-schema')))
  .replaceAll("'@/app/api/agents/tools/router/screen-access'", JSON.stringify(screenUrl))
  .replaceAll("'./types'", JSON.stringify(typesUrl))
  .replaceAll("'./store'", JSON.stringify(storeUrl))
  .replaceAll("'./git'", JSON.stringify(gitUrl)));
const { createCloudFileTools } = await import(toolsUrl);
const { createCloudFileStore } = await import(storeUrl);
const screen = await import(screenUrl);

test('connected cloud tools roundtrip: actual store and unmodified PostgreSQL migration', async t => {
  const db = new PGlite();
  const siteId = randomUUID(), userId = randomUUID(), instanceId = randomUUID();
  const requirementId = randomUUID(), otherRequirement = randomUUID(), siblingInstance = randomUUID();
  const scope = { siteId, userId, instanceId, requirementId };
  const calls = [], publications = [];
  let active = true;
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE sites(id uuid PRIMARY KEY);
      CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid,is_archived boolean);
      CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,metadata jsonb);
      CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid,instance_id uuid,metadata jsonb);
      CREATE TABLE access(site_id uuid,user_id uuid,effective boolean);
      CREATE FUNCTION site_user_has_effective_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS
        'SELECT effective FROM public.access WHERE site_id=$1 AND user_id=$2';`);
    await db.query('INSERT INTO sites VALUES ($1)', [siteId]);
    await db.query('INSERT INTO access VALUES ($1,$2,true)', [siteId, userId]);
    for (const id of [instanceId, siblingInstance]) {
      await db.query('INSERT INTO remote_instances VALUES ($1,$2,$3,false)', [id, siteId, userId]);
    }
    for (const id of [requirementId, otherRequirement]) {
      await db.query('INSERT INTO requirements VALUES ($1,$2,$3)', [id, siteId,
        { execution_environment: 'cloud', runner_instance_id: instanceId }]);
    }
    await db.exec(source('../../../../supabase/migrations/20261030010000_cloud_document_persistence.sql'));
    await db.exec('SET ROLE service_role');
    const store = createCloudFileStore({ rpc: async (name, args) => {
      assert.equal(name, 'cloud_file_store'); calls.push(args);
      try {
        const result = await db.query('SELECT public.cloud_file_store($1,$2,$3,$4,$5,$6) result',
          [args.p_site_id, args.p_user_id, args.p_instance_id, args.p_requirement_id, args.p_operation, args.p_input]);
        return { data: result.rows[0].result, error: null };
      } catch (error) { return { data: null, error: { code: error.code } }; }
    } });
    const assertActive = async () => { if (!active) throw new Error('No active execution'); };
    // Fake only the Git provider outcome: leave the real atomic SQL publish intent
    // pending. Git transport, target binding and byte verification have their own suite.
    const publish = async (bound, revision, deps) => {
      await deps.assertActive(); publications.push({ bound, revision });
      throw new Error('Offline Git provider unavailable');
    };
    const toolsFor = (bound = scope, extra = {}) => createCloudFileTools(bound, assertActive,
      { store, publish, allowRequirementWrite: true, ...extra });
    const call = (name, args, tools = toolsFor()) => tools.find(tool => tool.name === name).execute(args);
    const read = (file_id, version) => call('read_cloud_file', { file_id, ...(version ? { version } : {}) });
    let fileId;

    await t.test('1 create: exact immutable bytes/hash, requirement binding, pending Git and replay', async () => {
      const operation = randomUUID();
      const tools = toolsFor(scope, { operationId: () => operation });
      const args = { action: 'create', name: 'research.md', mime: 'text/markdown', content: '# Research\nUnique résumé 🌎' };
      const created = await call('write_cloud_file', args, tools);
      assert.equal(created.ok, true); fileId = created.output.file_id;
      assert.equal(created.output.saved, true); assert.equal(created.output.state, 'created');
      assert.equal(created.output.requirement_id, requirementId);
      assert.equal(created.output.version, 1); assert.equal(created.output.git_status, 'pending');
      assert.equal(created.output.git_commit_sha, null); assert.equal(created.output.git_repository, null);
      assert.equal(created.output.bytes, Buffer.byteLength(args.content));
      assert.equal(created.output.sha256, createHash('sha256').update(args.content).digest('hex'));
      assert.equal(created.output.archive_url, `/api/robots/instance/${instanceId}/cloud-files/${fileId}?version=1&format=zip`);
      assert.deepEqual(await call('write_cloud_file', args, tools), created);
      assert.equal((await store.listPendingGit(scope)).files.length, 1);
      assert.equal(publications.length, 2);
      assert.ok(calls.every(args => args.p_user_id === userId && args.p_site_id === siteId && args.p_instance_id === instanceId));
    });

    await t.test('2 read: exact content, Unicode pagination, immutable version, not found', async () => {
      const result = await read(fileId, 1);
      assert.equal(result.ok, true); assert.equal(result.output.content, '# Research\nUnique résumé 🌎');
      let offset = 0, collected = '';
      do {
        const page = await call('read_cloud_file', { file_id: fileId, version: 1, offset, max_chars: 1 });
        assert.equal(page.ok, true);
        assert.equal(Buffer.from(page.output.content).toString('utf8'), page.output.content);
        collected += page.output.content; offset = page.output.next_offset;
      } while (offset !== null);
      assert.equal(collected, result.output.content);
      assert.equal((await read(randomUUID())).error.code, 'not_found');
    });

    await t.test('3 list: actual name/content search, default/explicit requirement filter and pagination', async () => {
      const alternate = toolsFor({ ...scope, requirementId: otherRequirement });
      assert.equal((await call('write_cloud_file', { action: 'create', name: 'other.txt', content: 'Unrelated document' }, alternate)).ok, true);
      for (const query of ['RESEARCH', 'RÉSUMÉ', '🌎']) {
        const result = await call('list_cloud_files', { query });
        assert.deepEqual(result.output.files.map(file => file.file_id), [fileId]);
        assert.ok(result.output.files.every(file => !Object.hasOwn(file, 'content')));
      }
      const standalone = toolsFor({ siteId, userId, instanceId });
      assert.equal((await call('list_cloud_files', { query: 'Unrelated' }, standalone)).output.files.length, 1);
      assert.equal((await call('list_cloud_files', { requirement_id: requirementId }, standalone)).output.files[0].file_id, fileId);
      const first = await call('list_cloud_files', { limit: 1 }, standalone);
      assert.equal(first.output.next_offset, 1);
      const second = await call('list_cloud_files', { limit: 1, offset: 1 }, standalone);
      assert.equal(second.output.next_offset, null);
      assert.notEqual(first.output.files[0].file_id, second.output.files[0].file_id);
      const count = calls.length;
      assert.equal((await call('list_cloud_files', { requirement_id: otherRequirement })).error.code, 'forbidden');
      assert.equal(calls.length, count);
    });

    await t.test('4 replace: exact new revision and historical content retained', async () => {
      const result = await call('write_cloud_file', { action: 'replace', file_id: fileId, expected_version: 1, content: 'Hello universe' });
      assert.equal(result.ok, true); assert.equal(result.output.version, 2); assert.equal(result.output.state, 'updated');
      assert.equal((await read(fileId)).output.content, 'Hello universe');
      assert.equal((await read(fileId, 1)).output.content, '# Research\nUnique résumé 🌎');
    });

    await t.test('5 patch: ordered exact edits atomically persist and failed edit rolls back all', async () => {
      const result = await call('write_cloud_file', { action: 'patch', file_id: fileId, expected_version: 2,
        changes: [{ old_text: 'universe', new_text: 'world' }, { old_text: 'Hello', new_text: 'Greetings' }] });
      assert.equal(result.ok, true); assert.equal(result.output.version, 3);
      assert.equal((await read(fileId)).output.content, 'Greetings world');
      const failed = await call('write_cloud_file', { action: 'patch', file_id: fileId, expected_version: 3,
        changes: [{ old_text: 'Greetings', new_text: 'Lost' }, { old_text: 'absent', new_text: 'invalid' }] });
      assert.equal(failed.error.code, 'patch_conflict'); assert.equal(failed.error.effectStarted, false);
      assert.equal((await read(fileId)).output.content, 'Greetings world');
      assert.equal((await read(fileId)).output.version, 3);
    });

    await t.test('6 conflict: stale writer cannot overwrite, no-op creates no revision or lost publish intent', async () => {
      const before = publications.length;
      const stale = await call('write_cloud_file', { action: 'replace', file_id: fileId, expected_version: 1, content: 'stale' });
      assert.equal(stale.ok, false); assert.equal(stale.output.state, 'conflict'); assert.equal(stale.output.version, 3);
      assert.equal(stale.error.effectStarted, false); assert.equal(publications.length, before);
      const noop = await call('write_cloud_file', { action: 'replace', file_id: fileId, expected_version: 3, content: 'Greetings world' });
      assert.equal(noop.ok, true); assert.equal(noop.output.state, 'unchanged'); assert.equal(noop.output.version, 3);
      const pending = await store.listPendingGit(scope);
      assert.deepEqual(pending.files.map(file => file.version), [1, 2, 3]);
    });

    await t.test('authorization: screen/actor/owner denial is inert; SQL independently enforces access and scope', async () => {
      let before = calls.length;
      screen.deny(true);
      assert.equal((await read(fileId)).error.code, 'forbidden'); assert.equal(calls.length, before);
      screen.deny(false); active = false;
      assert.equal((await read(fileId)).error.code, 'inactive'); assert.equal(calls.length, before); active = true;
      assert.equal((await call('list_cloud_files', { user_id: randomUUID() })).error.code, 'invalid_input');
      assert.equal(calls.length, before);
      const interactive = toolsFor(scope, { allowRequirementWrite: false });
      assert.equal((await call('write_cloud_file', { action: 'create', name: 'forbidden.txt', content: '' }, interactive)).error.code, 'requirement_owner_required');
      assert.equal(calls.length, before);
      const sibling = toolsFor({ ...scope, instanceId: siblingInstance });
      assert.equal((await call('list_cloud_files', {}, sibling)).error.code, 'forbidden');
      assert.equal(calls.length, ++before);
      const stranger = toolsFor({ ...scope, userId: randomUUID() });
      assert.equal((await call('list_cloud_files', {}, stranger)).error.code, 'forbidden');
      assert.equal(calls.length, ++before);
      await db.exec('RESET ROLE');
      await db.query('UPDATE access SET effective=false WHERE site_id=$1 AND user_id=$2', [siteId, userId]);
      await db.exec('SET ROLE service_role');
      const published = publications.length;
      const deniedWrite = await call('write_cloud_file', { action: 'create', name: 'revoked.txt', content: '' });
      assert.equal(deniedWrite.error.code, 'forbidden'); assert.equal(publications.length, published);
      await db.exec('RESET ROLE');
      const count = await db.query('SELECT count(*)::int total FROM cloud_file_revisions');
      assert.equal(count.rows[0].total, 4);
      assert.ok(screen.checks.length > 0);
      assert.ok(screen.checks.every(check => ['read_cloud_file', 'list_cloud_files', 'write_cloud_file'].includes(check.name)));
    });
  } finally { screen.deny(false); await db.close(); }
});