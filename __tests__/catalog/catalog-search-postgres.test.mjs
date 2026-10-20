import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id, names, migrationSql, vectorSubstitutes } from './catalog-search-sql-harness.mjs';

const execFile = promisify(execFileCallback);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function localBin() {
  for (const dir of ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin']) {
    try { await access(join(dir, 'initdb')); return dir; } catch {}
  }
  return null;
}

test('disposable real PostgreSQL: independent writes, reverse commits and fanout/backfill avoid inversions', { timeout: 45000 }, async t => {
  const bin = await localBin();
  if (!bin || process.getuid?.() === 0) return t.skip('local unprivileged PostgreSQL 16/17 binaries unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'catalog-pg-'));
  const data = join(dir, 'data');
  const socket = dir;
  // Never use PGHOST/PGDATABASE/credentials or a preexisting server. Unix socket only.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  let started = false;
  const children = new Set();
  const psql = (sql, label = 'observer') => execFile(join(bin, 'psql'),
    ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-d', 'postgres', '-c',
      `SET application_name='${label}'; SET statement_timeout='8s'; ${sql}`], { env, timeout: 12000 });
  const session = (sql, label) => {
    const child = spawn(join(bin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-d', 'postgres'], { env });
    children.add(child);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => { children.delete(child); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)); });
    });
    // Attach handler immediately so an early failure is never unhandled.
    done.catch(() => {});
    child.stdin.end(`SET application_name='${label}'; SET statement_timeout='8s'; ${sql}`);
    return done;
  };
  const sleeping = async label => {
    for (let n = 0; n < 100; n++) {
      const { stdout } = await psql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${label}' AND wait_event='PgSleep'`);
      if (stdout.trim() === '1') return;
      await wait(20);
    }
    throw new Error(`session ${label} never reached synchronization barrier`);
  };
  try {
    await execFile(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8'], { env });
    await execFile(join(bin, 'pg_ctl'), ['-D', data, '-l', join(dir, 'server.log'), '-o', `-k ${socket} -h '' -p 5432`, '-w', 'start'], { env });
    started = true;
    await psql(await readFile(new URL('./catalog-search-fixture.sql', import.meta.url), 'utf8'));
    await psql(vectorSubstitutes);
    await psql(`INSERT INTO sites VALUES ('${id(1)}','North',NULL),('${id(2)}','South',NULL)`);
    for (const i of names.keys()) await psql(migrationSql(i));
    await psql(`INSERT INTO catalog_categories(id,site_id,name) VALUES ('${id(3)}','${id(1)}','Initialcategory');
      INSERT INTO catalog_items(id,site_id,name,category_id) VALUES
      ('${id(10)}','${id(1)}','First','${id(3)}'),('${id(11)}','${id(1)}','Second','${id(3)}');
      INSERT INTO catalog_items(id,site_id,name,sku) VALUES ('${id(12)}','${id(1)}',repeat('界',5000),'LONG-SKU');`);

    // A obtains the smaller sequence but B commits first. B must not wait for A's
    // revision row, and A's subsequent commit must change count despite same max.
    const first = session(`BEGIN; UPDATE catalog_items SET name='Firstedited' WHERE id='${id(10)}'; SELECT pg_sleep(1.5); COMMIT;`, 'reverse-first');
    await sleeping('reverse-first');
    assert.equal((await psql(`SELECT count(*) FROM pg_locks WHERE relation='catalog_search_revisions'::regclass AND mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock')`)).stdout.trim(), '0');
    await psql(`SET lock_timeout='500ms'; UPDATE catalog_items SET name='Secondedited' WHERE id='${id(11)}'`, 'reverse-second');
    const intermediate = (await psql(`SELECT catalog_search_revision('${id(1)}')`)).stdout.trim();
    await first;
    const final = (await psql(`SELECT catalog_search_revision('${id(1)}')`)).stdout.trim();
    assert.notEqual(intermediate, final);
    assert.equal(intermediate.split(':')[2], final.split(':')[2]);
    assert.equal(BigInt(final.split(':')[1]), BigInt(intermediate.split(':')[1]) + 1n);

    // While an edit owns item B and later edits A, category fanout must never
    // acquire A then block on B. It appends requests without source locks.
    const editor = session(`BEGIN; UPDATE catalog_items SET name='Secondmulti' WHERE id='${id(11)}';
      SELECT pg_sleep(1.5); UPDATE catalog_items SET name='Firstmulti' WHERE id='${id(10)}'; COMMIT;`, 'multi-editor');
    await sleeping('multi-editor');
    await psql(`SET lock_timeout='500ms'; UPDATE catalog_categories SET name='Changedcategory' WHERE id='${id(3)}'`);
    // Backfill skips locked B yet advances cursor and retains durable refresh.
    await psql(`SET lock_timeout='500ms'; SELECT * FROM backfill_catalog_search(NULL,500,'${id(1)}')`);
    assert.ok(Number((await psql('SELECT count(*) FROM catalog_search_refresh_events')).stdout.trim()) > 0);
    await psql(`SET lock_timeout='500ms'; SELECT * FROM claim_catalog_embedding_jobs(1,180)`);
    assert.ok(Number((await psql('SELECT count(*) FROM catalog_search_refresh_events')).stdout.trim()) > 0);
    await editor;
    await psql('SELECT * FROM claim_catalog_embedding_jobs(100,180)');
    assert.equal((await psql('SELECT count(*) FROM catalog_search_refresh_events')).stdout.trim(), '0');
    assert.equal((await psql(`SELECT count(*) FROM catalog_search_documents WHERE document_text LIKE '%Changedcategory%'`)).stdout.trim(), '2');
    assert.equal((await psql(`SELECT count(*) FROM pg_locks WHERE relation='catalog_search_revisions'::regclass AND mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock')`)).stdout.trim(), '0');
  } finally {
    for (const child of children) child.kill('SIGTERM');
    if (started) await execFile(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { env });
    await rm(dir, { recursive: true, force: true });
  }
});