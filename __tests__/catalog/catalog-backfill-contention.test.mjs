import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile as execCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { id, names, migrationSql, vectorSubstitutes } from './catalog-search-sql-harness.mjs';

const execFile = promisify(execCallback);
const migration = new URL('../../supabase/migrations/20261114210100_catalog_backfill_contention.sql', import.meta.url);

test('native PG backfill rolls back busy document/job writes, durably defers, and drains later', { timeout: 60000 }, async t => {
  const bin = '/opt/homebrew/opt/postgresql@17/bin';
  try { await access(join(bin, 'initdb')); } catch { return t.skip('local PostgreSQL 17 unavailable'); }
  if (process.getuid?.() === 0) return t.skip('requires unprivileged PostgreSQL');
  const dir = await mkdtemp(join(process.cwd(), '.catalog-pg-'));
  const data = join(dir, 'data');
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
  const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', dir, '-p', '55441', '-d', 'postgres'];
  const query = async text => (await execFile(join(bin, 'psql'), [...args, '-c', `SET statement_timeout='3s'; ${text}`], { env, timeout: 10000 })).stdout.trim();
  let started = false;
  const children = new Set();
  const hold = async text => {
    const child = spawn(join(bin, 'psql'), args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => { children.delete(child); code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)); });
    });
    done.catch(() => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('holder lock timeout')), 5000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('held')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
      child.stdin.write(`BEGIN; ${text}; SELECT 'held';\n`);
    });
    return async () => { child.stdin.end('ROLLBACK;\n'); await done; };
  };
  try {
    await execFile(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8'], { env });
    await execFile(join(bin, 'pg_ctl'), ['-D', data, '-l', join(dir, 'server.log'), '-o', `-k ${dir} -h '' -p 55441`, '-w', 'start'], { env });
    started = true;
    await query(await readFile(new URL('./catalog-search-fixture.sql', import.meta.url), 'utf8'));
    await query(vectorSubstitutes);
    await query(`INSERT INTO sites VALUES ('${id(1)}','North',NULL),('${id(2)}','South',NULL)`);
    for (const i of names.keys()) await query(migrationSql(i));
    const metadata = () => query("SELECT json_build_object('oid',oid,'owner',proowner,'acl',proacl,'definer',prosecdef) FROM pg_proc WHERE oid='backfill_catalog_search(uuid,integer,uuid)'::regprocedure");
    const originalMetadata = await metadata();
    const refreshDefinition = await query("SELECT pg_get_functiondef('refresh_catalog_search_document(uuid)'::regprocedure)");
    await query(await readFile(migration, 'utf8'));
    assert.equal(await metadata(), originalMetadata, 'entry point identity/owner/ACL retained');
    assert.equal(await query("SELECT pg_get_functiondef('refresh_catalog_search_document(uuid)'::regprocedure)"), refreshDefinition);
    for (const [offset, relation] of [[20, 'catalog_items'], [30, 'catalog_search_documents'], [40, 'catalog_embedding_jobs']]) {
      const busy = id(offset), neighbor = id(offset + 1);
      await query(`INSERT INTO catalog_items(id,site_id,name) VALUES ('${busy}','${id(1)}','Busy'),('${neighbor}','${id(1)}','Neighbor');
        UPDATE catalog_embedding_jobs SET status='exhausted',attempts=8 WHERE catalog_item_id='${busy}';
        DELETE FROM catalog_search_refresh_events;`);
      // Queue-only relationship semantics; change input without synchronous refresh.
      await query(`INSERT INTO catalog_categories(id,site_id,name) VALUES ('${id(offset + 2)}','${id(1)}','Changed category');
        ALTER TABLE catalog_items DISABLE TRIGGER USER;
        UPDATE catalog_items SET category_id='${id(offset + 2)}' WHERE id IN ('${busy}','${neighbor}');
        ALTER TABLE catalog_items ENABLE TRIGGER USER;`);
      const evidence = () => query(`SELECT json_build_object('doc',to_jsonb(d),'job',to_jsonb(j)) FROM catalog_search_documents d JOIN catalog_embedding_jobs j USING(catalog_item_id) WHERE catalog_item_id='${busy}'`);
      const before = await evidence();
      const key = relation === 'catalog_items' ? 'id' : 'catalog_item_id';
      const release = await hold(`SELECT 1 FROM ${relation} WHERE ${key}='${busy}' FOR UPDATE`);
      const begin = Date.now();
      const result = await query(`SET ROLE service_role; SELECT catalog_item_id FROM backfill_catalog_search('${id(offset - 1)}',2,'${id(1)}')`);
      assert.equal(result, `${busy}\n${neighbor}`);
      assert.ok(Date.now() - begin < 1500, 'busy downstream lock cannot stall batch');
      assert.equal(await evidence(), before, 'partial refresh and job revival rolled back');
      assert.equal(await query(`SELECT count(*) FROM catalog_search_refresh_events WHERE catalog_item_id='${busy}' AND revive_exhausted`), '1');
      assert.equal(await query(`SELECT document_text LIKE '%Changed category%' FROM catalog_search_documents WHERE catalog_item_id='${neighbor}'`), 't');
      // Keep the outer transaction open to verify candidate rollback releases locks.
      const finish = await hold(`SELECT * FROM backfill_catalog_search('${id(offset - 1)}',1,'${id(1)}')`);
      if (relation !== 'catalog_items') await query(`BEGIN; SELECT 1 FROM catalog_items WHERE id='${busy}' FOR UPDATE NOWAIT; ROLLBACK;`);
      await finish();
      await release();
      await query('SET ROLE service_role; SELECT catalog_search_refresh_batch(100)');
      assert.equal(await query(`SELECT document_text LIKE '%Changed category%' FROM catalog_search_documents WHERE catalog_item_id='${busy}'`), 't');
      assert.equal(await query(`SELECT status||':'||attempts FROM catalog_embedding_jobs WHERE catalog_item_id='${busy}'`), 'pending:0');
      assert.equal(await query('SELECT count(*) FROM catalog_search_refresh_events'), '0');
    }
    // If durable deferral itself cannot commit, the RPC fails atomically rather
    // than advancing a cursor past lost work (including healthy neighbors).
    const allBefore = await query('SELECT json_agg(to_jsonb(d) ORDER BY catalog_item_id) FROM catalog_search_documents d');
    const releaseDocument = await hold(`SELECT 1 FROM catalog_search_documents WHERE catalog_item_id='${id(20)}' FOR UPDATE`);
    const releaseQueue = await hold('LOCK TABLE catalog_search_refresh_events IN SHARE MODE');
    await assert.rejects(() => query(`SET ROLE service_role; SELECT * FROM backfill_catalog_search('${id(19)}',2,'${id(1)}')`), /lock timeout/);
    assert.equal(await query('SELECT json_agg(to_jsonb(d) ORDER BY catalog_item_id) FROM catalog_search_documents d'), allBefore);
    await releaseQueue();
    await releaseDocument();
    assert.equal(await query('SHOW lock_timeout'), '0');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await query(`SELECT has_function_privilege('${role}','backfill_catalog_search(uuid,integer,uuid)','EXECUTE')`), role === 'service_role' ? 't' : 'f');
    }
    await assert.rejects(() => query('SET ROLE service_role; SELECT * FROM backfill_catalog_search(NULL,0,NULL)'), /invalid backfill limit/);
    await query(await readFile(migration, 'utf8'));
  } finally {
    for (const child of children) child.kill('SIGTERM');
    if (started) await execFile(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { env });
    await rm(dir, { recursive: true, force: true });
  }
});
