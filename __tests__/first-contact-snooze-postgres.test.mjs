import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Never loads .env, a DSN, or an existing server. Each run owns a private
// /tmp socket and data directory, with TCP explicitly disabled.
const bin = ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin']
  .find(dir => ['initdb', 'pg_ctl', 'psql'].every(name => existsSync(join(dir, name))));
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');

test('first-contact snooze: isolated PostgreSQL multiconnection regressions', {
  skip: !bin || process.getuid?.() === 0 ? 'requires local Homebrew PostgreSQL and an unprivileged user' : false,
  timeout: 120_000,
}, async t => {
  const root = mkdtempSync('/tmp/snooze-pg-');
  const data = join(root, 'data');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  Object.assign(env, { LC_ALL: 'C', LANG: 'C', PGHOST: root, PGPORT: '55479',
    PGUSER: 'snooze_test', PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000' });
  const clients = new Set();
  function run(name, args) {
    const result = spawnSync(join(bin, name), args, { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${name}: ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  // Register cleanup before initdb/start, including setup failures.
  t.after(async () => {
    for (const client of clients) client.kill();
    await Promise.all([...clients].map(client => new Promise(resolve => {
      if (client.exitCode !== null || client.signalCode !== null) resolve();
      else client.once('close', resolve);
    })));
    if (existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  });
  run('initdb', ['-D', data, '-U', 'snooze_test', '-A', 'trust', '--no-locale', '--encoding=UTF8']);
  try {
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o',
      `-k ${root} -p 55479 -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  } catch (error) {
    throw new Error(`${error.message}\n${readFileSync(join(root, 'server.log'), 'utf8')}`);
  }
  function session() {
    const child = spawn(join(bin, 'psql'), ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { env });
    clients.add(child);
    let output = '', errors = '', pending;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; pending?.check(); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => pending?.reject(error));
    child.on('close', code => {
      clients.delete(child);
      pending?.reject(new Error(`psql exited ${code}: ${errors}\n${output}`));
    });
    return {
      command(sql) {
        assert.equal(pending, undefined, 'one outstanding command per connection');
        const marker = `done_${randomUUID().replaceAll('-', '')}`;
        const start = output.length;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending = undefined;
            child.kill();
            reject(new Error(`psql command timed out: ${errors}\n${output}`));
          }, 20_000);
          pending = {
            reject(error) { clearTimeout(timer); pending = undefined; reject(error); },
            check() {
              const end = output.indexOf(marker, start);
              if (end < 0) return;
              clearTimeout(timer);
              pending = undefined;
              resolve(output.slice(start, end).trim());
            },
          };
          child.stdin.write(`${sql}\n\\echo ${marker}\n`);
        });
      },
      close() { child.stdin.end('\\q\n'); },
    };
  }
  async function sql(text) {
    const client = session();
    try { return await client.command(text); }
    finally { client.close(); }
  }
  await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
    CREATE FUNCTION public.user_can(uuid,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE TABLE sites(id uuid PRIMARY KEY);
    CREATE TABLE leads(id uuid PRIMARY KEY,site_id uuid);
    CREATE TABLE settings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid UNIQUE,activities jsonb DEFAULT '{}',channels jsonb);
    CREATE TABLE conversations(id uuid PRIMARY KEY,site_id uuid,lead_id uuid);
    CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid REFERENCES conversations(id),role text,user_id uuid,created_at timestamptz,content text,custom_data jsonb);
    GRANT USAGE ON SCHEMA public, auth TO service_role;
    GRANT SELECT, INSERT, UPDATE ON leads, settings, conversations, messages TO service_role;`);
  for (const name of ['20261110230000_conversation_automation_snooze',
    '20261111040000_lead_site_automation_snooze', '20261111220000_first_contact_whatsapp_snooze']) await sql(migration(name));

  async function fixture() {
    const [site, connection, sender, conversation, message, provider] = Array.from({ length: 6 }, () => randomUUID());
    const recipient = '+5215512345678';
    await sql(`INSERT INTO sites(id) VALUES('${site}');
      INSERT INTO settings(site_id,channels) VALUES('${site}',
      '{"connections":[{"id":"${connection}","type":"whatsapp","zavu_sender_id":"${sender}"}]}');`);
    const inbound = `INSERT INTO conversations(id,site_id) VALUES('${conversation}','${site}');
      INSERT INTO messages(id,conversation_id,role,created_at,content,custom_data)
      VALUES(gen_random_uuid(),'${conversation}','user',clock_timestamp(),'inbound',
      '{"connection_id":"${connection}","zavu_sender_id":"${sender}","zavu_from":"${recipient}"}');`;
    const args = `'${site}','${connection}','${sender}','${recipient}'`;
    return { site, conversation, message, inbound,
      register: `SELECT register_conversation_human_event(${args},'${message}','${provider}','2026-11-11T12:00:00Z','human','{}');`,
      reconcile: `SELECT reconcile_conversation_human_events(${args},'${conversation}');` };
  }
  async function race(first, second) {
    const a = session(), b = session();
    let waiting;
    try {
      const pidA = Number(await a.command('SELECT pg_backend_pid();'));
      const pidB = Number(await b.command('SELECT pg_backend_pid();'));
      const firstResult = await a.command(`SET ROLE service_role; BEGIN; ${first}`);
      // A stays in an explicit transaction until B is observed blocked on A.
      // No timed sleep can cause A to commit before that observation.
      waiting = b.command(`SET ROLE service_role; BEGIN; ${second} COMMIT;`);
      let completed = false;
      waiting.then(() => { completed = true; }, () => { completed = true; });
      const deadline = Date.now() + 10_000;
      while (await sql(`SELECT ${pidA} = ANY(pg_blocking_pids(${pidB})) AND
        EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${pidB} AND wait_event_type='Lock');`) !== 't') {
        assert.equal(completed, false, 'second transaction must wait for first contact lock');
        assert.ok(Date.now() < deadline, 'second transaction never blocked on first');
        await delay(10); // poll condition only; never releases the first transaction
      }
      await a.command('COMMIT;');
      return [firstResult, await waiting];
    } finally {
      a.close(); b.close();
      await waiting?.catch(() => {});
    }
  }
  async function assertApplied(f) {
    assert.equal(await sql(`SELECT count(*) FROM messages WHERE id='${f.message}';`), '1');
    assert.equal(await sql(`SELECT applied_at IS NOT NULL FROM conversation_automation_events WHERE id='${f.message}';`), 't');
    assert.equal(await sql(`SELECT automation_paused_until='2026-11-11T16:00:00Z'
      AND last_human_reply_at='2026-11-11T12:00:00Z' FROM conversations WHERE id='${f.conversation}';`), 't');
  }
  await t.test('human-first: pending event is consumed after inbound lock resumes', async () => {
    const f = await fixture();
    const [a, b] = await race(f.register, f.inbound + f.reconcile);
    assert.equal(JSON.parse(a).state, 'pending');
    assert.equal(JSON.parse(b).applied_count, 1);
    await assertApplied(f);
  });
  await t.test('inbound-first: committed binding lets waiting human event apply immediately', async () => {
    const f = await fixture();
    const [a, b] = await race(f.inbound + f.reconcile, f.register);
    assert.equal(JSON.parse(a).applied_count, 0);
    assert.equal(JSON.parse(b).state, 'applied');
    await assertApplied(f);
  });
  await t.test('concurrent duplicate inserts one human message and cannot rearm manual resume', async () => {
    const f = await fixture();
    await sql(f.inbound + f.reconcile);
    const [a, b] = await race(f.register + `UPDATE conversations SET automation_paused_until=NULL WHERE id='${f.conversation}';`, f.register);
    assert.equal(JSON.parse(a).state, 'applied');
    assert.equal(JSON.parse(b).state, 'duplicate');
    await sql(f.register + f.reconcile);
    assert.equal(await sql(`SELECT automation_paused_until IS NULL FROM conversations WHERE id='${f.conversation}';`), 't');
    assert.equal(await sql(`SELECT count(*) FROM messages WHERE id='${f.message}';`), '1');
    assert.equal(await sql(`SELECT count(*) FROM conversation_automation_events WHERE id='${f.message}' AND applied_at IS NOT NULL;`), '1');
  });
  await t.test('conversation deletion permits rebind without replay; site deletion purges applied and pending ledgers', async () => {
    const f = await fixture();
    await sql(f.inbound + f.reconcile + f.register);
    await assertApplied(f);
    // Match explicit message cleanup without assuming the application's message FK action.
    await sql(`DELETE FROM messages WHERE conversation_id='${f.conversation}';
      DELETE FROM conversations WHERE id='${f.conversation}';`);
    assert.equal(await sql(`SELECT conversation_id IS NULL FROM conversation_automation_contacts WHERE site_id='${f.site}';`), 't');
    assert.equal(await sql(`SELECT applied_at IS NOT NULL FROM conversation_automation_events WHERE id='${f.message}';`), 't');
    assert.equal(JSON.parse(await sql(f.register)).state, 'duplicate');

    const replacement = randomUUID();
    await sql(f.inbound.replaceAll(f.conversation, replacement));
    const reconciled = JSON.parse(await sql(f.reconcile.replaceAll(f.conversation, replacement)));
    assert.equal(reconciled.applied_count, 0);
    assert.equal(reconciled.conversation_id, replacement);
    assert.equal(JSON.parse(await sql(f.register)).state, 'duplicate');
    assert.equal(await sql(`SELECT conversation_id='${replacement}' FROM conversation_automation_contacts WHERE site_id='${f.site}';`), 't');
    assert.equal(await sql(`SELECT count(*) FROM messages WHERE id='${f.message}';`), '0');
    assert.equal(await sql(`SELECT automation_paused_until IS NULL AND last_human_reply_at IS NULL
      FROM conversations WHERE id='${replacement}';`), 't');

    const pending = await fixture();
    assert.equal(JSON.parse(await sql(pending.register)).state, 'pending');
    await sql(`DELETE FROM sites WHERE id IN ('${f.site}','${pending.site}');`);
    for (const table of ['conversation_automation_contacts', 'conversation_automation_events']) {
      assert.equal(await sql(`SELECT count(*) FROM ${table} WHERE site_id IN ('${f.site}','${pending.site}');`), '0');
    }
  });
  await t.test('anon/authenticated cannot execute RPCs or access the RLS-protected ledger', async () => {
    const f = await fixture();
    for (const role of ['anon', 'authenticated']) {
      for (const statement of [f.register, f.reconcile, 'SELECT * FROM conversation_automation_events;',
        'SELECT * FROM conversation_automation_contacts;']) {
        await assert.rejects(sql(`SET ROLE ${role}; ${statement}`), /permission denied/);
      }
    }
    assert.equal(await sql(`SELECT count(*) FROM pg_class WHERE oid IN
      ('conversation_automation_contacts'::regclass,'conversation_automation_events'::regclass) AND relrowsecurity;`), '2');
  });
});