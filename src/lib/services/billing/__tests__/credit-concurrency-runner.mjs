import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A disposable real PostgreSQL server, never Supabase or a developer cluster.
// No .env, connection URL, passwords, TCP listeners, or inherited PG variables.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const candidates = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin'];
const bin = candidates.find(path => existsSync(join(path, 'initdb')) && existsSync(join(path, 'psql')));
if (!bin) throw new Error('Real PostgreSQL regression requires local initdb, pg_ctl and psql (PostgreSQL 15+).');
const temp = mkdtempSync('/tmp/credit-pg-');
const data = join(temp, 'data');
const port = String(randomInt(20000, 60000));
const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C', HOME: temp };
const args = ['-X', '-qAt', '-h', temp, '-p', port, '-U', 'credit_test_admin', '-d', 'postgres',
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

function client(sql, name = `credit_${randomUUID()}`, keepOpen = false) {
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
  const holder = client(`BEGIN;\n${first}\n\\echo CREDIT_LOCK_HELD`, undefined, true);
  let contender;
  try {
    await waitFor(() => holder.output().includes('CREDIT_LOCK_HELD'), 'holder transaction');
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
async function createSite(plan = 'engine') {
  const site = uuid();
  await sql(`INSERT INTO sites(id,name) VALUES(${site},'Synthetic concurrency fixture');
    ${rpc('initialize_site_billing', [site])}
    UPDATE billing SET plan=${quote(plan)} WHERE site_id=${site};
    UPDATE billing SET plan_credits_available=2,purchased_credits_available=20,
      legacy_credits_available=7,credits_available=29,account_balance=17.42,credits_used=13,
      plan_credit_allowance=public.site_plan_credit_allowance(${quote(plan)},0),monthly_credits_used=18,
      plan_credit_period_start=now()-interval '2 months',plan_credit_period_end=now()-interval '1 month'
      WHERE site_id=${site};`);
  return site;
}
function balances(b, plan, purchased = 20, legacy = 7, used = 13) {
  assert.equal(Number(b.plan_credits_available), plan);
  assert.equal(Number(b.purchased_credits_available), purchased);
  assert.equal(Number(b.legacy_credits_available), legacy);
  assert.equal(Number(b.credits_available), plan + purchased + legacy);
  assert.equal(Number(b.account_balance), 17.42);
  assert.equal(Number(b.credits_used), used);
}
const spend = (site, amount = 3) => rpc('deduct_credits', [site, String(amount), "'usage'", "'Synthetic usage'", "'{}'::jsonb"]);
const purchase = (site, key, amount = 20) => rpc('grant_purchased_site_credits', [site, String(amount), key, "'{}'::jsonb"]);

try {
  command('initdb', ['-D', data, '-U', 'credit_test_admin', '-A', 'trust', '--no-instructions', '--locale=C']);
  // This port is only a Unix socket filename; listen_addresses disables all TCP.
  command('pg_ctl', ['-D', data, '-l', join(temp, 'server.log'), '-w', '-t', '15', '-o',
    `-c listen_addresses='' -c unix_socket_directories='${temp}' -c port=${port} -c fsync=off`, 'start']);
  started = true;
  assert.equal(await sql('SHOW listen_addresses;'), undefined);
  assert.equal(await sql('SHOW data_directory;'), data);
  await sql(readFileSync(join(here, 'credit-fixture.sql'), 'utf8'));
  const unverified = [uuid(), uuid()];
  for (const [index, site] of unverified.entries()) {
    await sql(`INSERT INTO sites(id,name) VALUES(${site},'Synthetic unverified Stripe');
      INSERT INTO billing(site_id,plan,credits_available,account_balance,subscription_status,
        stripe_subscription_id,subscription_current_period_end)
      VALUES(${site},'foundry',55,17.42,'active',${quote(`sub_${randomUUID().replaceAll('-', '')}`)},
        ${index ? "now()-interval '1 day'" : 'NULL'});
      INSERT INTO payments(site_id,transaction_id,credits,status,transaction_type,payment_method)
      VALUES(${site},${quote(`purchase_${randomUUID()}`)},20,'completed','credits_purchase','stripe'),
        (${site},${quote(`renewal_${randomUUID()}`)},100,'completed','subscription','stripe');
      INSERT INTO credit_transactions(site_id,amount,transaction_type) VALUES(${site},7,'credit_restore');`);
  }
  for (const file of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql', '20261003230002_classified_credit_operations.sql'])
    await sql(readFileSync(resolve(root, 'supabase/migrations', file), 'utf8'));

  await check('precision migration invalidates warmed pooled trigger typmods across real PostgreSQL sessions', async () => {
    const site = uuid();
    // Keep the same backend open across DDL from a different backend, just as
    // a pooled API connection survives a production migration. No row locks held.
    const warmed = client(`INSERT INTO sites(id,name) VALUES(${site},'Synthetic warmed precision');
      ${rpc('initialize_site_billing', [site])}
      UPDATE billing SET plan='foundry' WHERE site_id=${site};
      UPDATE billing SET plan_credits_available=96,purchased_credits_available=20 WHERE site_id=${site};
      DO $$ BEGIN
        PERFORM deduct_credits(${site},0.502249,'credit_usage','Synthetic','{}');
        RAISE EXCEPTION 'Expected original precision CHECK failure';
      EXCEPTION WHEN check_violation THEN NULL; END $$;
      \\echo CREDIT_PRECISION_WARMED`, undefined, true);
    try {
      await waitFor(() => warmed.output().includes('CREDIT_PRECISION_WARMED'), 'original warmed CHECK failure');
      await sql(readFileSync(resolve(root, 'supabase/migrations',
        '20261005230000_exact_credit_accounting_precision.sql'), 'utf8'));
      warmed.child.stdin.end(`SELECT deduct_credits(${site},0.502249,'credit_usage','Synthetic','{}');
        SELECT deduct_credits(${site},0.00000007,'credit_usage','Synthetic','{}');
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM billing WHERE site_id=${site} AND credits_available=115.49775093
            AND credits_used=0.50224907 AND monthly_credits_used=0.50224907
            AND credits_available=plan_credits_available+purchased_credits_available+legacy_credits_available)
            OR (SELECT sum(amount) FROM credit_transactions WHERE site_id=${site}) <> -0.50224907 THEN
            RAISE EXCEPTION 'Warmed precision balance/ledger not conserved';
          END IF;
        END $$;
        \\echo CREDIT_PRECISION_EXACT\n`);
      assert.ok((await warmed.done).includes('CREDIT_PRECISION_EXACT'));
    } finally {
      if (!warmed.child.stdin.writableEnded) warmed.child.stdin.end();
      await warmed.done.catch(() => {});
    }
  });

  await check('migration cannot fabricate paid Stripe periods from missing or expired dates', async () => {
    for (const site of unverified) {
      balances(await row(site), 0, 20, 7, 0);
      await sql(spend(site)); balances(await row(site), 0, 20, 4, 3);
      assert.equal(Number(await sql(`SELECT expired_plan_credits FROM billing_credit_migration_audit WHERE site_id=${site};`)), 28);
    }
  });

  await check('signup versus fallback serializes a single grant and payment', async () => {
    const site = uuid();
    await sql(`INSERT INTO sites(id,name) VALUES(${site},'Synthetic signup');`);
    const [a, b] = await race(rpc('initialize_site_billing', [site]), rpc('initialize_site_billing', [site]));
    assert.match(a, /"credits_granted": 30/); assert.match(b, /"credits_granted": 0/);
    await Promise.all(Array.from({ length: 8 }, () => sql(rpc('initialize_site_billing', [site]))));
    assert.equal(await count(`billing WHERE site_id=${site}`), 1);
    assert.equal(await count(`payments WHERE site_id=${site} AND payment_method='initial_credit'`), 1);
    assert.equal(Number((await row(site)).credits_available), 30);
    // Existing saldo without a payment marker is not permission to grant again.
    await sql(`DELETE FROM payments WHERE site_id=${site};`);
    await race(rpc('initialize_site_billing', [site]), rpc('initialize_site_billing', [site]));
    assert.equal(Number((await row(site)).credits_available), 30);
    assert.equal(Number(await sql(`SELECT credits FROM payments WHERE site_id=${site};`)), 0);
  });

  await check('simultaneous purchase duplicates deliver money exactly once', async () => {
    const site = await createSite(), key = quote(`purchase_${randomUUID()}`);
    await race(purchase(site, key), purchase(site, key));
    await Promise.all(Array.from({ length: 8 }, () => sql(purchase(site, key))));
    balances(await row(site), 2, 40);
    assert.equal(await count(`billing_credit_grant_keys WHERE idempotency_key=${key}`), 1);
    assert.equal(await count(`credit_transactions WHERE site_id=${site} AND transaction_type='credits_purchase'`), 1);
    const other = await createSite();
    await assert.rejects(() => sql(purchase(other, key)), /idempotency conflict/);
    await assert.rejects(() => sql(purchase(site, key, 21)), /idempotency conflict/);
    balances(await row(other), 2); balances(await row(site), 2, 40);
  });

  await check('initialization retry cannot deadlock an existing credit operation on the site foreign key', async () => {
    for (const operation of ['purchase', 'spend', 'renew']) {
      const site = await createSite();
      const continuation = operation === 'purchase' ? purchase(site, quote(`purchase_${randomUUID()}`))
        : operation === 'spend' ? spend(site) : rpc('renew_site_plan_credits', [site]);
      await race(`SELECT id FROM billing WHERE site_id=${site} FOR UPDATE;`,
        rpc('initialize_site_billing', [site]), continuation);
      balances(await row(site), operation === 'purchase' ? 2 : operation === 'spend' ? 17 : 20,
        operation === 'purchase' ? 40 : 20, 7, operation === 'spend' ? 16 : 13);
    }
  });

  await check('renewal versus spend preserves bought balances in both lock orders', async () => {
    for (const reversed of [false, true]) {
      const site = await createSite();
      const operations = [rpc('renew_site_plan_credits', [site]), spend(site)];
      await race(...(reversed ? operations.reverse() : operations));
      balances(await row(site), 17, 20, 7, 16);
      assert.equal(Number((await row(site)).monthly_credits_used), 3);
      assert.equal(await count(`credit_transactions WHERE site_id=${site} AND transaction_type='plan_credit_reset'`), 1);
    }
  });

  await check('cancellation versus purchase cannot erase bought or withdrawable money', async () => {
    for (const reversed of [false, true]) {
      const site = await createSite(), key = quote(`purchase_${randomUUID()}`);
      const operations = [`UPDATE billing SET subscription_status='canceled' WHERE site_id=${site};`, purchase(site, key)];
      await race(...(reversed ? operations.reverse() : operations));
      let b = await row(site); balances(b, 1, 40); assert.equal(b.plan, 'commission');
      await sql(spend(site, 0.5));
      await sql(`UPDATE billing SET subscription_status='canceled' WHERE site_id=${site};`);
      b = await row(site); balances(b, 0.5, 40, 7, 13.5);
    }
  });

  await check('failed ledger writes roll back grants and purchase idempotency keys', async () => {
    const site = await createSite(), key = quote(`purchase_${randomUUID()}`);
    await sql(`CREATE FUNCTION public.reject_synthetic_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.site_id=${site} THEN RAISE EXCEPTION 'Synthetic ledger failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_synthetic_ledger BEFORE INSERT ON credit_transactions
      FOR EACH ROW EXECUTE FUNCTION public.reject_synthetic_ledger();`);
    await assert.rejects(() => sql(purchase(site, key)), /Synthetic ledger failure/);
    balances(await row(site), 2);
    assert.equal(await count(`billing_credit_grant_keys WHERE idempotency_key=${key}`), 0);
    await sql('DROP TRIGGER reject_synthetic_ledger ON credit_transactions; DROP FUNCTION reject_synthetic_ledger();');
    await sql(purchase(site, key)); balances(await row(site), 2, 40);
  });

  await check('paid Stripe renewal versus spend serializes verified refill and expiry', async () => {
    for (const reversed of [false, true]) {
      const site = await createSite('foundry');
      const customer = `cus_${randomUUID().replaceAll('-', '')}`, subscription = `sub_${randomUUID().replaceAll('-', '')}`;
      await sql(`UPDATE billing SET stripe_customer_id=${quote(customer)},stripe_subscription_id=${quote(subscription)},
        subscription_status='active' WHERE site_id=${site};`);
      const dates = await json(`SELECT json_build_object('start',now()-interval '5 days','end',now()+interval '25 days','now',now());`);
      const invoice = quote(JSON.stringify({ site_id: site.slice(1, -1), customer_id: customer, subscription_id: subscription,
        invoice_id: `in_${randomUUID().replaceAll('-', '')}`, status: 'paid', amount: 49, currency: 'USD',
        plan: 'foundry', addons_count: 0, billing_reason: 'subscription_cycle', current_subscription_status: 'active',
        paid_at: dates.now, period_start: dates.start, period_end: dates.end }));
      const operations = [rpc('settle_stripe_subscription_invoice', [`${invoice}::jsonb`]), spend(site)];
      await race(...(reversed ? operations.reverse() : operations));
      // Spending first expires old plan2 and consumes legacy3; spending second consumes new plan3.
      balances(await row(site), reversed ? 100 : 97, 20, reversed ? 4 : 7, 16);
      assert.equal(await count(`stripe_subscription_invoice_settlements WHERE site_id=${site}`), 1);
      assert.equal(await count(`credit_transactions WHERE site_id=${site} AND transaction_type='plan_credit_reset'`), 1);
    }
  });

  await check('inactive or archived included credits cannot be spent but bought money remains usable', async () => {
    for (const archived of [false, true]) {
      const site = await createSite('foundry');
      await sql(`UPDATE billing SET stripe_subscription_id=${quote(`sub_${randomUUID().replaceAll('-', '')}`)},
        subscription_status='active' WHERE site_id=${site};
        ${archived ? `UPDATE sites SET archived_at=now() WHERE id=${site};`
          : `UPDATE billing SET status='inactive' WHERE site_id=${site};`}`);
      await sql(spend(site)); balances(await row(site), 0, 20, 4, 16);
      await sql(rpc('renew_site_plan_credits', [site])); balances(await row(site), 0, 20, 4, 16);
    }
  });

  await check('UTC calendar periods ignore session DST and reject nonfinite or partial periods', async () => {
    const site = await createSite();
    // October -> November crosses the DST fallback in America/New_York.
    const b = await json(`SET TIME ZONE 'America/New_York';
      ${rpc('renew_site_plan_credits', [site])}
      SELECT row_to_json(b) FROM billing b WHERE site_id=${site};`);
    const expected = await json(`SELECT json_build_object('start',
      date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC','end',
      (date_trunc('month',now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC');`);
    assert.equal(Date.parse(b.plan_credit_period_start), Date.parse(expected.start));
    assert.equal(Date.parse(b.plan_credit_period_end), Date.parse(expected.end));
    for (const [start, end] of [["'-infinity'::timestamptz", "'infinity'::timestamptz"],
      ['NULL', "now()+interval '1 month'"], ['now()', 'NULL']])
      await assert.rejects(() => sql(rpc('reset_site_plan_credit_period',
        [site, start, end, '20', "'workflow'"])), /Invalid current plan credit period/);
    await assert.rejects(() => sql(`UPDATE billing SET plan_credit_period_end=NULL WHERE site_id=${site};`), /billing_credit_buckets_valid/);
    await assert.rejects(() => sql(`UPDATE billing SET plan_credit_period_end='infinity' WHERE site_id=${site};`), /billing_credit_buckets_valid/);
    balances(await row(site), 20);
  });

  await check('proven Stripe period end prevents a revised-start invoice refilling spent credits', async () => {
    const site = await createSite('foundry');
    await sql(`UPDATE billing SET stripe_subscription_id=${quote(`sub_${randomUUID().replaceAll('-', '')}`)},
      subscription_status='active' WHERE site_id=${site};
      UPDATE billing SET plan_credit_source='stripe_legacy',plan_credits_available=8,credits_available=35,
        plan_credit_period_start=now()-interval '5 days',plan_credit_period_end=now()+interval '25 days'
        WHERE site_id=${site};`);
    const result = await json(rpc('reset_site_plan_credit_period', [site, "now()-interval '4 days'",
      `(SELECT plan_credit_period_end FROM billing WHERE site_id=${site})`, '100', quote(`stripe_invoice:in_${randomUUID().replaceAll('-', '')}`)]));
    assert.equal(result.outcome, 'not_due'); balances(await row(site), 8);
    assert.equal(await count(`credit_transactions WHERE site_id=${site} AND transaction_type='plan_credit_reset'`), 0);
  });

  await check('replacement Stripe subscription cannot inherit old entitlement and verified period refills only once', async () => {
    const site = await createSite('foundry');
    await sql(`UPDATE billing SET stripe_subscription_id=${quote(`sub_${randomUUID().replaceAll('-', '')}`)},
      subscription_status='active' WHERE site_id=${site};
      UPDATE billing SET subscription_status='canceled' WHERE site_id=${site};`);
    balances(await row(site), 1);
    await assert.rejects(() => sql(`UPDATE billing SET subscription_status='active' WHERE site_id=${site};`), /terminated Stripe subscription/);
    await sql(`UPDATE billing SET stripe_subscription_id=${quote(`sub_${randomUUID().replaceAll('-', '')}`)},
      subscription_status='active',plan='foundry' WHERE site_id=${site};`);
    balances(await row(site), 0); assert.equal((await row(site)).plan_credit_source, 'stripe_unverified');
    const dates = await json(`SELECT json_build_object('start',plan_credit_period_start,'end',plan_credit_period_end)
      FROM billing WHERE site_id=${site};`);
    const reset = rpc('reset_site_plan_credit_period', [site, `${quote(dates.start)}::timestamptz`,
      `${quote(dates.end)}::timestamptz`, '100', quote(`stripe_invoice:in_${randomUUID().replaceAll('-', '')}`)]);
    assert.equal((await json(reset)).credits_granted, 100);
    await sql(spend(site)); balances(await row(site), 97, 20, 7, 16);
    assert.equal((await json(reset)).credits_granted, 0); balances(await row(site), 97, 20, 7, 16);
  });

  await check('plan downgrades and upgrades preserve included usage even beyond the smaller allowance', async () => {
    const site = await createSite('foundry');
    await sql(rpc('renew_site_plan_credits', [site]));
    await sql(spend(site, 50)); balances(await row(site), 50, 20, 7, 63);
    assert.equal(Number((await row(site)).plan_credits_used), 50);
    for (let i = 0; i < 3; i++) {
      await sql(`UPDATE billing SET plan='engine' WHERE site_id=${site};`);
      balances(await row(site), 0, 20, 7, 63);
      assert.equal(Number((await row(site)).plan_credits_used), 50);
      await sql(`UPDATE billing SET plan='foundry' WHERE site_id=${site};`);
      balances(await row(site), 50, 20, 7, 63);
    }
    await sql(spend(site, 55)); // plan50 then legacy5; purchased money untouched.
    balances(await row(site), 0, 20, 2, 118);
    assert.equal(Number((await row(site)).plan_credits_used), 100);
    assert.equal(Number((await row(site)).monthly_credits_used), 105);
    await sql(`UPDATE billing SET plan='engine' WHERE site_id=${site};
      UPDATE billing SET plan='foundry' WHERE site_id=${site};`);
    balances(await row(site), 0, 20, 2, 118);
  });

  await check('legacy SECURITY DEFINER invocation cannot bypass finance or tenant guards with empty JWT', async () => {
    const site = await createSite(), other = await createSite(), owner = uuid(), outsider = uuid();
    await sql(`UPDATE sites SET user_id=${owner} WHERE id=${site};
      CREATE FUNCTION public.synthetic_legacy_billing_update(p_site uuid,p_column text,p_value text)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
        EXECUTE format('UPDATE public.billing SET %I=%L WHERE site_id=%L',p_column,p_value,p_site);
      END; $$;
      GRANT EXECUTE ON FUNCTION synthetic_legacy_billing_update(uuid,text,text) TO anon,authenticated;`);
    const legacy = (actor, column, value, role = 'authenticated', target = site, jwt = role) =>
      `SET ROLE ${role}; SELECT set_config('request.jwt.claim.role',${quote(jwt)},false);
        SELECT set_config('request.jwt.claim.sub',${actor ? actor : "''"},false);
        ${rpc('synthetic_legacy_billing_update', [target, quote(column), quote(value)])}`;
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(() => sql(legacy(null, 'updated_at', '2026-01-01', role, site, '')), /manager authorization/);
      await assert.rejects(() => sql(`SET ROLE ${role}; ${rpc('renew_site_plan_credits', [site])}`), /permission denied/);
    }
    await assert.rejects(() => sql(legacy(outsider, 'updated_at', '2026-01-01')), /manager authorization/);
    await assert.rejects(() => sql(legacy(owner, 'updated_at', '2026-01-01', 'authenticated', other)), /manager authorization/);
    for (const [field, value] of [['plan', 'enterprise'], ['status', 'inactive'], ['account_balance', '999'],
      ['created_at', '2025-01-01'], ['plan_credit_period_start', '2025-01-01'],
      ['plan_credit_period_end', '2030-01-01'], ['subscription_current_period_end', '2030-01-01'],
      ['subscription_end_date', '2030-01-01'], ['plan_credit_source', 'stripe_unverified'], ['plan_credits_used', '999']])
      await assert.rejects(() => sql(legacy(owner, field, value)), /server managed/, field);
    await assert.rejects(() => sql(legacy(owner, 'site_id', other.slice(1, -1))), /identity is immutable/);
    await sql(legacy(owner, 'updated_at', '2026-01-01'));
    balances(await row(site), 2);
    await sql('DROP FUNCTION synthetic_legacy_billing_update(uuid,text,text);');
  });

  assert.equal(await sql("SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND wait_event_type='Lock';"), '0');
  console.log(`Validated ${checks} real PostgreSQL concurrency scenarios`);
} finally { cleanup(); }