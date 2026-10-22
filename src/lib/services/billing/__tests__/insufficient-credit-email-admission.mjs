import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Disposable memory-only PostgreSQL. No .env, database URL, network or credentials.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const migration = readFileSync(resolve(root,
  'supabase/migrations/20261021230000_insufficient_credit_email_admission.sql'), 'utf8');
const siteTable = 'public.insufficient_credit_email_site_gates';
const recipientTable = 'public.insufficient_credit_email_recipient_gates';
const signature = 'public.claim_insufficient_credit_email(uuid,text,uuid)';
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
// Capture owner at fixture creation, like the service's read BEFORE admission.
// Never refresh from the database during claim: that would hide ownership races.
const capturedOwners = new Map();
const claim = async (site, hash, owner = capturedOwners.get(site) ?? null) => (await one(
  'SELECT public.claim_insufficient_credit_email($1::uuid,$2::text,$3::uuid) result', [site, hash, owner])).result;
const hash = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const site = async (owner = randomUUID(), archived = null) => {
  const id = randomUUID();
  await db.query('INSERT INTO public.sites(id,user_id,archived_at) VALUES($1,$2,$3)', [id, owner, archived]);
  capturedOwners.set(id, owner);
  return id;
};
const siteGate = id => one(`SELECT * FROM ${siteTable} WHERE site_id=$1`, [id]);
const recipientGate = h => one(`SELECT * FROM ${recipientTable} WHERE recipient_hash=$1`, [h]);
const state = async () => ({
  sites: (await db.query(`SELECT * FROM ${siteTable} ORDER BY site_id`)).rows,
  recipients: (await db.query(`SELECT * FROM ${recipientTable} ORDER BY recipient_hash`)).rows,
});
const denied = (result, reason) => assert.deepEqual(result, { acquired: false, reason });
const acquired = result => {
  assert.deepEqual(Object.keys(result).sort(), ['acquired', 'idempotency_key']);
  assert.equal(result.acquired, true);
  assert.match(result.idempotency_key,
    /^insufficient-credit-email:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return result.idempotency_key;
};
const withRole = async (role, fn) => {
  // All role names below are fixed fixture identifiers, never untrusted input.
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
};
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

try {
  // Include Supabase-like broad default grants to prove explicit revocation wins.
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE admission_public_probe NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, admission_public_probe;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated;
    CREATE TABLE public.sites(id uuid PRIMARY KEY,user_id uuid,archived_at timestamptz);
    CREATE TABLE public.notifications(id uuid PRIMARY KEY,created_at timestamptz,metadata jsonb);
    INSERT INTO public.notifications VALUES(gen_random_uuid(),clock_timestamp(),'{"type":"insufficient_credits"}');
  `);
  const legacyBefore = (await db.query('SELECT * FROM public.notifications')).rows;
  await db.exec(migration);

  await check('acquired contract persists a unique UUID key and identical reservation timestamps', async () => {
    const id = await site(), h = hash();
    const key = acquired(await withRole('service_role', () => claim(id, h)));
    assert.equal((await siteGate(id)).idempotency_key, key);
    assert.equal((await recipientGate(h)).attempted_at.length, 1);
    assert.equal((await one(`SELECT s.last_attempt_at=r.attempted_at[1] same
      FROM ${siteTable} s,${recipientTable} r WHERE s.site_id=$1 AND r.recipient_hash=$2`, [id, h])).same, true);
    assert.notEqual(acquired(await claim(await site(), hash())), key);
  });

  await check('malformed or null hashes and site IDs cannot mutate gates', async () => {
    const id = await site(), h = hash(), before = await state();
    for (const invalid of [null, '', h.slice(1), h + '0', h.toUpperCase(), 'g'.repeat(64),
      ' ' + h, h + '\n', h.slice(0, 63) + '\n']) denied(await claim(id, invalid), 'invalid_input');
    denied(await claim(null, h), 'invalid_input');
    denied(await claim(id, h, null), 'invalid_input');
    // uuid is a typed RPC argument: malformed UUIDs fail PostgreSQL input casting.
    await assert.rejects(() => claim('not-a-uuid', h), /invalid input syntax for type uuid/);
    await assert.rejects(() => claim(id, h, 'not-a-uuid'), /invalid input syntax for type uuid/);
    assert.deepEqual(await state(), before);
  });

  await check('absent archived ownerless and stale captured owner sites deny without any reservation', async () => {
    const archived = await site(randomUUID(), new Date().toISOString()), ownerless = await site(null);
    const active = await site(), h = hash();
    acquired(await claim(active, h));
    await db.query('UPDATE public.sites SET archived_at=clock_timestamp() WHERE id=$1', [active]);
    const before = await state();
    denied(await claim(randomUUID(), h, randomUUID()), 'site_unavailable');
    denied(await claim(ownerless, h, randomUUID()), 'site_unavailable');
    denied(await claim(ownerless, h), 'invalid_input');
    for (const id of [archived, active]) denied(await claim(id, h), 'site_unavailable');
    assert.deepEqual(await state(), before);

    const transferred = await site(), oldOwner = capturedOwners.get(transferred), nextOwner = randomUUID(), nextHash = hash();
    await db.query('UPDATE public.sites SET user_id=$1 WHERE id=$2', [nextOwner, transferred]);
    const transferBefore = await state();
    denied(await claim(transferred, nextHash, oldOwner), 'site_unavailable');
    denied(await claim(transferred, nextHash), 'site_unavailable');
    assert.deepEqual(await state(), transferBefore);
    assert.equal(await siteGate(transferred), undefined);
    assert.equal(await recipientGate(nextHash), undefined);
    // Only an explicit newly captured owner can authorize a fresh reservation.
    acquired(await claim(transferred, nextHash, nextOwner));
  });

  console.log('PGlite serializes Promise.all; not true multi-connection concurrency');
  await check('Promise.all same-site retries acquire once and deny without exposing the key', async () => {
    const id = await site(), h = hash();
    const results = await Promise.all(Array.from({ length: 12 }, () => claim(id, h)));
    assert.equal(results.filter(r => r.acquired).length, 1);
    acquired(results.find(r => r.acquired));
    for (const result of results.filter(r => !r.acquired)) denied(result, 'site_rate_limited');
    assert.equal((await recipientGate(h)).attempted_at.length, 1);
  });

  await check('Promise.all burst across different sites shares a three-attempt recipient budget', async () => {
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await site());
    const h = hash(), results = await Promise.all(ids.map(id => claim(id, h)));
    assert.equal(results.filter(r => r.acquired).length, 3);
    assert.equal(new Set(results.filter(r => r.acquired).map(acquired)).size, 3);
    for (let i = 0; i < ids.length; i++) {
      if (!results[i].acquired) {
        denied(results[i], 'recipient_rate_limited');
        assert.equal(await siteGate(ids[i]), undefined);
      }
    }
    assert.equal((await recipientGate(h)).attempted_at.length, 3);
  });

  await check('duplicates including recipient changes consume neither recipient budget nor new rows', async () => {
    const id = await site(), h = hash(), other = hash();
    acquired(await claim(id, h));
    const before = await state();
    for (let i = 0; i < 5; i++) denied(await claim(id, h), 'site_rate_limited');
    denied(await claim(id, other), 'site_rate_limited');
    assert.deepEqual(await state(), before);
    assert.equal(await recipientGate(other), undefined);
    acquired(await claim(await site(), h));
    acquired(await claim(await site(), h));
    denied(await claim(await site(), h), 'recipient_rate_limited');
  });

  await check('recipient denials leave fresh and expired site gates completely unchanged', async () => {
    const h = hash();
    for (let i = 0; i < 3; i++) acquired(await claim(await site(), h));
    const fresh = await site(), expired = await site();
    acquired(await claim(expired, hash()));
    await db.query(`UPDATE ${siteTable} SET last_attempt_at=clock_timestamp()-interval '25 hours' WHERE site_id=$1`, [expired]);
    const before = await state();
    denied(await claim(fresh, h), 'recipient_rate_limited');
    denied(await claim(expired, h), 'recipient_rate_limited');
    assert.deepEqual(await state(), before);
    assert.equal(await siteGate(fresh), undefined);
  });

  await check('rolling 24-hour boundary denies just inside and acquires at the elapsed boundary', async () => {
    const id = await site(), h = hash(), first = acquired(await claim(id, h));
    await db.query(`UPDATE ${siteTable} SET last_attempt_at=clock_timestamp()-interval '24 hours'+interval '1 minute' WHERE site_id=$1`, [id]);
    const before = await state();
    denied(await claim(id, hash()), 'site_rate_limited');
    assert.deepEqual(await state(), before);
    // Exactly 24h at fixture setup, hence >=24h at the post-lock RPC clock; no sleep.
    await db.query(`UPDATE ${siteTable} SET last_attempt_at=clock_timestamp()-interval '24 hours' WHERE site_id=$1`, [id]);
    const boundary = await siteGate(id), next = acquired(await claim(id, h));
    assert.notEqual(next, first);
    assert.ok(new Date((await siteGate(id)).last_attempt_at) - new Date(boundary.last_attempt_at) >= 24 * 3600000);
    denied(await claim(id, h), 'site_rate_limited');
  });

  await check('rolling recipient boundary expires only old timestamps and uses post-wait wall-clock time', async () => {
    const h = hash();
    for (let i = 0; i < 3; i++) acquired(await claim(await site(), h));
    await db.query(`UPDATE ${recipientTable} SET attempted_at=ARRAY[
      clock_timestamp()-interval '10 minutes'+interval '1 minute',
      clock_timestamp()-interval '5 minutes',clock_timestamp()] WHERE recipient_hash=$1`, [h]);
    const id = await site(), before = await state();
    denied(await claim(id, h), 'recipient_rate_limited');
    assert.deepEqual(await state(), before);
    await db.query(`UPDATE ${recipientTable} SET attempted_at[1]=clock_timestamp()-interval '10 minutes' WHERE recipient_hash=$1`, [h]);
    const recent = (await recipientGate(h)).attempted_at.slice(1);
    acquired(await claim(id, h));
    assert.deepEqual((await recipientGate(h)).attempted_at.slice(0, 2), recent);
    denied(await claim(await site(), h), 'recipient_rate_limited');

    // Begin a transaction whose timestamp is stale by the time the RPC runs.
    // PGlite cannot model a lock waiter, but this rejects now()/transaction time.
    await db.exec('BEGIN');
    try {
      await db.query(`UPDATE ${siteTable} SET last_attempt_at=transaction_timestamp()-interval '24 hours'+interval '100 milliseconds' WHERE site_id=$1`, [id]);
      await db.query(`UPDATE ${recipientTable} SET attempted_at=ARRAY[
        transaction_timestamp()-interval '10 minutes'+interval '100 milliseconds',
        transaction_timestamp()-interval '5 minutes',transaction_timestamp()] WHERE recipient_hash=$1`, [h]);
      await db.query('SELECT pg_sleep(0.15)');
      acquired(await claim(id, h));
      await db.exec('COMMIT');
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
  });

  await check('external failure or unconfirmed send preserves committed reservations with no release RPC', async () => {
    for (const outcome of ['failure', 'unconfirmed']) {
      const id = await site(), h = hash(), key = acquired(await claim(id, h)), before = await state();
      // Synthetic provider stub only; admission must already be durable before send.
      const send = async () => {
        assert.equal((await siteGate(id)).idempotency_key, key);
        if (outcome === 'failure') throw new Error('Synthetic provider failure');
        return { confirmed: false };
      };
      if (outcome === 'failure') await assert.rejects(send, /Synthetic provider failure/);
      else assert.deepEqual(await send(), { confirmed: false });
      denied(await claim(id, h), 'site_rate_limited');
      assert.deepEqual(await state(), before);
    }
    assert.deepEqual((await db.query(`SELECT proname FROM pg_catalog.pg_proc
      WHERE pronamespace='public'::regnamespace AND proname LIKE '%insufficient_credit_email%'
      ORDER BY proname`)).rows, [{ proname: 'claim_insufficient_credit_email' }]);
  });

  await check('database persistence failure rolls back both gates rather than reserving a partial attempt', async () => {
    const id = await site(), h = hash(), before = await state();
    await db.exec(`CREATE FUNCTION public.synthetic_admission_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic gate persistence failure'; END $$;
      CREATE TRIGGER synthetic_admission_failure BEFORE INSERT OR UPDATE ON ${recipientTable}
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_admission_failure();`);
    try { await assert.rejects(() => claim(id, h), /Synthetic gate persistence failure/); }
    finally { await db.exec(`DROP TRIGGER synthetic_admission_failure ON ${recipientTable}; DROP FUNCTION public.synthetic_admission_failure()`); }
    assert.deepEqual(await state(), before);
    acquired(await claim(id, h));
  });

  await check('repeated rolling attempts keep one row per identity and at most three timestamps', async () => {
    const id = await site(), h = hash(), keys = new Set();
    acquired(await claim(id, h));
    const before = await state();
    for (let i = 0; i < 12; i++) {
      await db.query(`UPDATE ${siteTable} SET last_attempt_at=clock_timestamp()-interval '24 hours' WHERE site_id=$1`, [id]);
      await db.query(`UPDATE ${recipientTable} SET attempted_at=ARRAY[clock_timestamp()-interval '10 minutes'] WHERE recipient_hash=$1`, [h]);
      keys.add(acquired(await claim(id, h)));
      assert.equal((await recipientGate(h)).attempted_at.length, 1);
    }
    const after = await state();
    assert.equal(keys.size, 12);
    assert.equal(after.sites.length, before.sites.length);
    assert.equal(after.recipients.length, before.recipients.length);
    assert.ok(after.recipients.every(r => r.attempted_at.length <= 3));
    for (const attempted of [[], [null], [new Date(), new Date(), new Date(), new Date()]]) {
      await assert.rejects(() => db.query(`INSERT INTO ${recipientTable} VALUES($1,$2::timestamptz[])`,
        [hash(), attempted.map(value => value?.toISOString() ?? null)]), /check constraint/);
    }
    await db.query('DELETE FROM public.sites WHERE id=$1', [id]);
    const gate = await siteGate(id);
    assert.ok(gate);
    await db.query('INSERT INTO public.sites(id,user_id) VALUES($1,$2)', [id, capturedOwners.get(id)]);
    denied(await claim(id, h), 'site_rate_limited');
    assert.deepEqual(await siteGate(id), gate);
  });

  await check('RLS search_path and ACLs permit only service RPC and no direct gate access', async () => {
    const proc = await one(`SELECT prosecdef,proconfig,proargnames FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure`, [signature]);
    assert.equal(proc.prosecdef, true);
    assert.deepEqual(proc.proconfig, ['search_path=pg_catalog']);
    assert.deepEqual(proc.proargnames, ['p_site_id', 'p_recipient_hash', 'p_owner_id']);
    assert.equal((await one("SELECT to_regprocedure('public.claim_insufficient_credit_email(uuid,text)') old_rpc")).old_rpc, null);
    for (const table of [siteTable, recipientTable]) {
      const rls = await one('SELECT relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class WHERE oid=$1::regclass', [table]);
      assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
      assert.equal((await one('SELECT count(*)::int n FROM pg_catalog.pg_policy WHERE polrelid=$1::regclass', [table])).n, 0);
    }
    const id = await site(), h = hash();
    for (const role of ['anon', 'authenticated', 'service_role', 'admission_public_probe']) {
      assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok', [role, signature])).ok, role === 'service_role');
      for (const table of [siteTable, recipientTable]) {
        for (const access of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          assert.equal((await one('SELECT has_table_privilege($1,$2,$3) ok', [role, table, access])).ok, false);
        }
      }
      await withRole(role, async () => {
        for (const table of [siteTable, recipientTable]) {
          for (const sql of [`SELECT * FROM ${table}`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
            await assert.rejects(() => db.query(sql), /permission denied/);
          }
        }
        await assert.rejects(() => db.query(`INSERT INTO ${siteTable} VALUES($1,clock_timestamp(),$2)`, [id, randomUUID()]), /permission denied/);
        await assert.rejects(() => db.query(`UPDATE ${recipientTable} SET attempted_at=ARRAY[clock_timestamp()]`), /permission denied/);
        if (role === 'service_role') acquired(await claim(id, h));
        else await assert.rejects(() => claim(id, h), /permission denied/);
      });
    }
    // pg_temp is implicitly searched for relations even with a pinned search_path;
    // schema-qualification must prevent shadowing of the trusted public tables.
    const shadowSite = await site();
    await db.exec(`CREATE TEMP TABLE sites(id uuid,user_id uuid,archived_at timestamptz);
      CREATE TEMP TABLE insufficient_credit_email_site_gates(site_id uuid);
      CREATE TEMP TABLE insufficient_credit_email_recipient_gates(recipient_hash text);`);
    acquired(await withRole('service_role', () => claim(shadowSite, hash())));
  });

  await check('migration replay preserves reservations ACLs and legacy notification cooldown data', async () => {
    const before = await state();
    // Simulate the earlier owner-unbound overload, which must be removed rather
    // than left executable as a bypass when replaying the hardened migration.
    await db.exec(`CREATE FUNCTION public.claim_insufficient_credit_email(uuid,text)
      RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"acquired":true}'::jsonb $$;`);
    await db.exec(migration);
    assert.equal((await one("SELECT to_regprocedure('public.claim_insufficient_credit_email(uuid,text)') old_rpc")).old_rpc, null);
    assert.deepEqual(await state(), before);
    assert.deepEqual((await db.query('SELECT * FROM public.notifications')).rows, legacyBefore);
    for (const table of [siteTable, recipientTable]) assert.equal((await one(
      "SELECT has_table_privilege('service_role',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') ok", [table])).ok, false);
    assert.equal((await one("SELECT has_function_privilege('authenticated',$1,'EXECUTE') ok", [signature])).ok, false);
    const id = await site(), h = hash();
    await db.exec("SET TIME ZONE 'America/New_York'");
    acquired(await withRole('service_role', () => claim(id, h)));
    await db.exec("SET TIME ZONE 'UTC'");
    denied(await claim(id, h), 'site_rate_limited');
    // Structural checks supplement (not replace) executing the real migration.
    const body = (await one('SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure', [signature])).prosrc;
    const siteLock = body.indexOf('pg_advisory_xact_lock(1768121701');
    const recipientLock = body.indexOf('pg_advisory_xact_lock(1768121702');
    const clock = body.indexOf('v_now := pg_catalog.clock_timestamp()');
    assert.ok(siteLock >= 0 && recipientLock > siteLock && clock > recipientLock);
  });

  console.log(`Validated ${checks} insufficient-credit email admission scenarios`);
} finally { await db.close(); }

// Explicit opt-in adds real independent backend coverage on a NEW local cluster.
// Never discover/reuse a developer database or accept a connection URL/PG env.
if (process.argv.includes('--local-postgres')) await localConcurrency();

async function localConcurrency() {
  const bin = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin'].find(dir =>
    ['initdb', 'pg_ctl', 'psql'].every(name => existsSync(resolve(dir, name))));
  assert.ok(bin, '--local-postgres requires locally installed PostgreSQL 15+ binaries');
  const temp = mkdtempSync('/tmp/email-admission-pg-'), data = resolve(temp, 'data');
  const port = String(randomInt(20000, 60000)); // Unix socket filename, not a TCP listener.
  const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C', HOME: temp };
  const args = ['-X', '-qAt', '-h', temp, '-p', port, '-U', 'admission_test_admin',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  const active = new Set();
  let started = false, cleaned = false, count = 0;
  const command = (name, argv) => {
    const result = spawnSync(resolve(bin, name), argv, { env, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || result.error?.message);
    return result.stdout.trim();
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const child of active) child.kill('SIGKILL');
    if (started || existsSync(resolve(data, 'postmaster.pid'))) {
      const result = spawnSync(resolve(bin, 'pg_ctl'), ['-D', data, '-w', '-t', '10', '-m', 'immediate', 'stop'],
        { env, encoding: 'utf8', timeout: 15_000 });
      if (result.status !== 0 && existsSync(resolve(data, 'postmaster.pid'))) {
        process.exitCode = 1;
        process.stderr.write('Disposable admission PostgreSQL cleanup failed; retained data directory\n');
        return;
      }
    }
    rmSync(temp, { recursive: true, force: true });
  };
  const interrupted = () => { cleanup(); process.exit(1); };
  process.on('exit', cleanup);
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const client = (sql, hold = false) => {
    const name = `admission_${randomUUID()}`;
    const child = spawn(resolve(bin, 'psql'), args, {
      env: { ...env, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    active.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    const done = new Promise((resolveDone, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        active.delete(child);
        if (code === 0) resolveDone(stdout.trim());
        else reject(new Error(stderr || stdout || `Disposable psql exited ${code}`));
      });
    });
    done.catch(() => {});
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    done.finally(() => clearTimeout(timeout)).catch(() => {});
    if (hold) child.stdin.write(`${sql}\n`);
    else child.stdin.end(`${sql}\n`);
    return { child, name, done, output: () => stdout };
  };
  const sql = statement => client(statement).done;
  const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, 'Timed out observing real backend lock wait');
      await pause(10);
    }
  };
  const localCapturedOwners = new Map();
  const newSite = async () => {
    const id = randomUUID(), owner = randomUUID();
    await sql(`INSERT INTO public.sites VALUES(${quote(id)},${quote(owner)},NULL);`);
    localCapturedOwners.set(id, owner);
    return id;
  };
  const rpc = (id, h, owner = localCapturedOwners.get(id) ?? null) =>
    `SELECT public.claim_insufficient_credit_email(${quote(id)}::uuid,${quote(h)},${owner === null ? 'NULL' : quote(owner)}::uuid);`;
  const result = text => JSON.parse(text.split('\n').find(line => line.startsWith('{')));
  const race = async (holderSql, contenderSql, verifyWait = async () => {}) => {
    const holder = client(`BEGIN; ${holderSql} SELECT 'holding';`, true);
    let contender;
    try {
      await waitFor(async () => holder.output().includes('holding'));
      contender = client(`BEGIN; ${contenderSql} COMMIT;`);
      await waitFor(async () => await sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name=${quote(contender.name)} AND wait_event='advisory');`) === 't');
      await verifyWait(holder, contender);
      holder.child.stdin.end('COMMIT;\n');
      return await Promise.all([holder.done, contender.done]);
    } finally {
      if (!holder.child.stdin.writableEnded) holder.child.stdin.end('ROLLBACK;\n');
      await holder.done.catch(() => {});
      if (contender) await contender.done.catch(() => {});
    }
  };
  const localCheck = async (name, fn) => { await fn(); count++; console.log(`PASS local PostgreSQL: ${name}`); };
  try {
    command('initdb', ['-D', data, '-U', 'admission_test_admin', '-A', 'trust', '--no-instructions', '--locale=C']);
    command('pg_ctl', ['-D', data, '-l', resolve(temp, 'server.log'), '-w', '-t', '15', '-o',
      `-c listen_addresses='' -c unix_socket_directories='${temp}' -c port=${port}`, 'start']);
    started = true;
    assert.equal(await sql('SHOW listen_addresses;'), '');
    assert.equal(await sql('SHOW data_directory;'), data);
    await sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE TABLE public.sites(id uuid PRIMARY KEY,user_id uuid,archived_at timestamptz);`);
    await sql(migration);

    await localCheck('same-site workers really wait on advisory locks and acquire exactly once', async () => {
      const id = await newSite(), h = hash();
      const outputs = await race(rpc(id, h), rpc(id, h), async holder => {
        assert.equal(await sql(`SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING(pid)
          WHERE a.application_name=${quote(holder.name)} AND l.locktype='advisory' AND l.granted;`), '2');
      });
      acquired(result(outputs[0]));
      denied(result(outputs[1]), 'site_rate_limited');
      assert.equal(await sql(`SELECT cardinality(attempted_at) FROM ${recipientTable} WHERE recipient_hash=${quote(h)};`), '1');
    });

    await localCheck('different-site workers serialize on recipient and do not reserve a denied site', async () => {
      const h = hash();
      for (let i = 0; i < 2; i++) acquired(result(await sql(rpc(await newSite(), h))));
      const holder = await newSite(), contender = await newSite();
      const outputs = await race(rpc(holder, h), rpc(contender, h));
      acquired(result(outputs[0]));
      denied(result(outputs[1]), 'recipient_rate_limited');
      assert.equal(await sql(`SELECT count(*) FROM ${siteTable} WHERE site_id=${quote(contender)};`), '0');
      assert.equal(await sql(`SELECT cardinality(attempted_at) FROM ${recipientTable} WHERE recipient_hash=${quote(h)};`), '3');
    });

    await localCheck('owner transfer while claimant waits denies stale captured owner without writing gates', async () => {
      const id = await newSite(), h = hash(), oldOwner = localCapturedOwners.get(id), nextOwner = randomUUID();
      const outputs = await race(`SELECT pg_advisory_xact_lock(1768121701,hashtext(${quote(id)}));
        UPDATE public.sites SET user_id=${quote(nextOwner)} WHERE id=${quote(id)};`, rpc(id, h, oldOwner));
      denied(result(outputs[1]), 'site_unavailable');
      denied(result(await sql(rpc(id, h))), 'site_unavailable');
      assert.equal(await sql(`SELECT count(*) FROM ${siteTable} WHERE site_id=${quote(id)};`), '0');
      assert.equal(await sql(`SELECT count(*) FROM ${recipientTable} WHERE recipient_hash=${quote(h)};`), '0');
      acquired(result(await sql(rpc(id, h, nextOwner))));
    });

    await localCheck('actual lock waiter uses clock after locks rather than its earlier transaction time', async () => {
      const id = await newSite(), h = hash();
      acquired(result(await sql(rpc(id, h))));
      await sql(`UPDATE ${siteTable} SET last_attempt_at=clock_timestamp()-interval '24 hours'+interval '1 second' WHERE site_id=${quote(id)};
        UPDATE ${recipientTable} SET attempted_at=ARRAY[clock_timestamp()-interval '10 minutes'+interval '1 second',
        clock_timestamp()-interval '5 minutes',clock_timestamp()] WHERE recipient_hash=${quote(h)};`);
      const outputs = await race(`SELECT pg_advisory_xact_lock(1768121701,hashtext(${quote(id)}));`, rpc(id, h),
        async (_holder, contender) => {
          // Prove transaction time is inside BOTH limits; only a post-lock wall
          // clock can admit this worker after waiting for their expiry.
          assert.equal(await sql(`SELECT a.xact_start < s.last_attempt_at+interval '24 hours'
            AND a.xact_start < r.attempted_at[1]+interval '10 minutes'
            FROM pg_stat_activity a,${siteTable} s,${recipientTable} r
            WHERE a.application_name=${quote(contender.name)} AND s.site_id=${quote(id)}
            AND r.recipient_hash=${quote(h)};`), 't');
          await pause(1200);
        });
      acquired(result(outputs[1]));
      assert.equal(await sql(`SELECT cardinality(attempted_at) FROM ${recipientTable} WHERE recipient_hash=${quote(h)};`), '3');
    });

    await localCheck('simultaneous independent backend burst acquires three unique keys across eight sites', async () => {
      const h = hash(), ids = [];
      for (let i = 0; i < 8; i++) ids.push(await newSite());
      const results = (await Promise.all(ids.map(id => sql(rpc(id, h))))).map(result);
      assert.equal(results.filter(r => r.acquired).length, 3);
      assert.equal(new Set(results.filter(r => r.acquired).map(acquired)).size, 3);
      for (const deniedResult of results.filter(r => !r.acquired)) denied(deniedResult, 'recipient_rate_limited');
      assert.equal(await sql(`SELECT count(*) FROM ${siteTable} WHERE site_id=ANY(ARRAY[${ids.map(quote).join(',')}]::uuid[]);`), '3');
    });

    await localCheck('reservation persists across connections replay and a real server restart', async () => {
      const id = await newSite(), h = hash(), key = acquired(result(await sql(rpc(id, h))));
      await sql(migration);
      command('pg_ctl', ['-D', data, '-l', resolve(temp, 'server.log'), '-w', '-t', '15', '-m', 'fast', 'restart']);
      assert.equal(await sql(`SELECT idempotency_key FROM ${siteTable} WHERE site_id=${quote(id)};`), key);
      denied(result(await sql(rpc(id, h))), 'site_rate_limited');
    });
    console.log(`Validated ${count} real multi-connection admission scenarios (isolated Unix socket, no TCP)`);
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}