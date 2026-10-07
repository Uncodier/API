import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A disposable real PostgreSQL server, never Supabase or a developer cluster.
// No .env, connection URL, passwords, TCP listeners, or inherited PG variables.
const here = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const candidates = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin'];
const bin = candidates.find(path => existsSync(join(path, 'initdb')) && existsSync(join(path, 'psql')));
if (!bin) throw new Error('Real PostgreSQL regression requires local initdb, pg_ctl and psql (PostgreSQL 15+).');
const temp = mkdtempSync('/tmp/setup-email-pg-');
const data = join(temp, 'data');
const port = String(randomInt(20000, 60000));
const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C', HOME: temp };
const args = ['-X', '-qAt', '-h', temp, '-p', port, '-U', 'setup_email_test_admin', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1'];
const active = new Set();
let started = false;
let cleaned = false;
let checks = 0;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const uuid = () => quote(randomUUID());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(name, argv) {
  const result = spawnSync(join(bin, name), argv, { env, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${name}: ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout;
}
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of active) child.kill('SIGKILL');
  if (started || existsSync(join(data, 'postmaster.pid'))) {
    const result = spawnSync(join(bin, 'pg_ctl'), ['-D', data, '-w', '-t', '10', '-m', 'immediate', 'stop'],
      { env, encoding: 'utf8', timeout: 15_000 });
    if (result.status !== 0 && existsSync(join(data, 'postmaster.pid'))) {
      // Do not erase an un-stopped server's data directory or hide cleanup failure.
      process.stderr.write(`Disposable PostgreSQL cleanup failed: ${result.stderr || result.stdout}\n`);
      process.exitCode = 1;
      return;
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(1); });

function client(sql, name = `setup_email_${randomUUID()}`, keepOpen = false) {
  const child = spawn(join(bin, 'psql'), args, { env: { ...env, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      active.delete(child);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql ${name}: ${stderr || stdout} (exit ${code})`));
    });
  });
  // Holding clients can fail while the controller waits for their lock marker.
  done.catch(() => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  done.finally(() => clearTimeout(timeout)).catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write("SET statement_timeout='10s'; SET lock_timeout='5s'; SET deadlock_timeout='100ms';\n" + sql + '\n');
  if (!keepOpen) child.stdin.end();
  return { child, done, name, output: () => stdout };
}
const sql = async text => (await client(text).done).split('\n').filter(Boolean).at(-1);
const json = async text => JSON.parse(await sql(text));
const row = site => json(`SELECT row_to_json(b) FROM billing b WHERE site_id=${site};`);
const rpc = (name, params) => `SELECT public.${name}(${params.join(',')});`;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const count = text => sql(`SELECT count(*) FROM ${text};`).then(Number);
async function waitFor(predicate, description) {
  const until = Date.now() + 7_000;
  while (Date.now() < until) { if (await predicate()) return; await sleep(20); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function race(first, second, beforeCommit = '') {
  // Keep transaction A open until PostgreSQL proves B is actually lock-blocked.
  // This exercises real locks rather than Promise.all against a serialized engine.
  const holder = client(`BEGIN;\n${first}\n\\echo SETUP_EMAIL_LOCK_HELD`, undefined, true);
  let contender;
  try {
    await waitFor(() => holder.output().includes('SETUP_EMAIL_LOCK_HELD'), 'holder transaction');
    contender = client(`BEGIN;\n${second}\nCOMMIT;`);
    await waitFor(async () => (await sql(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE application_name=${quote(contender.name)} AND wait_event_type='Lock');`)) === 't', 'contender lock wait');
    holder.child.stdin.end(`${beforeCommit}\nCOMMIT;\n`);
    return await Promise.all([holder.done, contender.done]);
  } finally {
    if (!holder.child.stdin.writableEnded) holder.child.stdin.end('ROLLBACK;\n');
    await holder.done.catch(() => {});
    if (contender) await contender.done.catch(() => {});
  }
}

const migration = readFileSync(join(root, 'supabase/migrations/20261007004000_setup_email_delivery_receipts.sql'), 'utf8');
const payload = quote(JSON.stringify({ email: 'owner@example.test', subject: 'Setup', message: 'Ready' })) + '::jsonb';
const claim = (key, site, token, content = payload) => rpc('claim_setup_email_delivery', [quote(key), site, content, token]);
const final = (key, site, token, state = 'sent') => rpc('finalize_setup_email_delivery', [quote(key), site, payload, token, quote(state), quote(JSON.stringify(state === 'sent'
  ? { success: true, status: state, messageId: 'actual-id', recipient: 'owner@example.test', sent_at: '2026-10-07T00:00:00.000Z' }
  : { success: false, status: state })) + '::jsonb']);
try {
  command('initdb', ['-D', data, '-U', 'setup_email_test_admin', '-A', 'trust', '--no-instructions', '--locale=C']);
  // This port is only a Unix socket filename; listen_addresses disables all TCP.
  command('pg_ctl', ['-D', data, '-l', join(temp, 'server.log'), '-w', '-t', '15', '-o',
    `-c listen_addresses='' -c unix_socket_directories='${temp}' -c port=${port} -c fsync=off`, 'start']);
  started = true;
  assert.equal(await sql('SHOW listen_addresses;'), undefined);
  assert.equal(await sql('SHOW data_directory;'), data);
  await sql(readFileSync(join(here, 'receipt-fixture.sql'), 'utf8'));
  await sql(migration);
  const site = uuid(), tokenA = uuid(), tokenB = uuid();
  await sql(`INSERT INTO sites(id,user_id) VALUES(${site},${uuid()});`);
  await check('concurrent first claims lock-block and acquire exactly once', async () => {
    const outputs = await race(claim('first', site, tokenA), claim('first', site, tokenB));
    const outcomes = outputs.map(text => JSON.parse(text.split('\n').find(line => line.startsWith('{'))).outcome).sort();
    assert.deepEqual(outcomes, ['acquired', 'claimed']);
    assert.equal(await count('setup_email_delivery_receipts'), 1);
  });
  await check('concurrent same-key different payload is conflict, never second claim', async () => {
    const different = quote(JSON.stringify({ email: 'other@example.test', subject: 'Setup', message: 'Ready' })) + '::jsonb';
    const outputs = await race(claim('conflict', site, tokenA), claim('conflict', site, tokenB, different));
    const outcomes = outputs.map(text => JSON.parse(text.split('\n').find(line => line.startsWith('{'))).outcome).sort();
    assert.deepEqual(outcomes, ['acquired', 'conflict']);
  });
  await check('send finalization racing retry replays actual sent receipt', async () => {
    await sql(claim('sent', site, tokenA));
    const outputs = await race(final('sent', site, tokenA), claim('sent', site, tokenB));
    for (const text of outputs) {
      const result = JSON.parse(text.split('\n').find(line => line.startsWith('{')));
      assert.equal(result.outcome, 'sent'); assert.equal(result.receipt.messageId, 'actual-id');
    }
  });
  await check('lost-confirmation finalization racing retry stays uncertain, never acquired', async () => {
    await sql(claim('unknown', site, tokenA));
    const outputs = await race(final('unknown', site, tokenA, 'uncertain'), claim('unknown', site, tokenB));
    for (const text of outputs) assert.equal(JSON.parse(text.split('\n').find(line => line.startsWith('{'))).outcome, 'uncertain');
  });
  console.log(`Validated ${checks} real PostgreSQL setup email concurrency scenarios`);
} finally { cleanup(); }
