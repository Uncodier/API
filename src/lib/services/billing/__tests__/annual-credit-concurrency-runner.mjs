import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent copy of the short disposable-PG harness: no original runner edits.
// No .env, credentials, provider calls, developer clusters, or TCP listeners.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const candidates = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin'];
const bin = candidates.find(path => ['initdb', 'pg_ctl', 'psql'].every(name => existsSync(join(path, name))));
if (!bin) throw new Error('Annual concurrency tests require local PostgreSQL 15+ binaries.');
const temp = mkdtempSync('/tmp/annual-credit-pg-');
const data = join(temp, 'data');
const port = String(randomInt(20000, 60000));
const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C', HOME: temp };
const args = ['-X', '-qAt', '-h', temp, '-p', port, '-U', 'annual_test_admin', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1'];
const active = new Set();
let started = false, cleaned = false, checks = 0;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
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
      process.stderr.write(`Disposable annual PostgreSQL cleanup failed: ${result.stderr || result.stdout}\n`);
      process.exitCode = 1;
      return;
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(1); });
function client(text, name = `annual_${randomUUID()}`, keepOpen = false) {
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
  done.catch(() => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  done.finally(() => clearTimeout(timeout)).catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write("SET statement_timeout='10s'; SET lock_timeout='5s'; SET deadlock_timeout='100ms';\n" + text + '\n');
  if (!keepOpen) child.stdin.end();
  return { child, done, name, output: () => stdout };
}
const sql = async text => (await client(text).done).split('\n').filter(Boolean).at(-1);
const json = async text => JSON.parse(await sql(text));
const row = site => json(`SELECT row_to_json(b) FROM billing b WHERE site_id=${quote(site)};`);
const rpc = (name, params) => `SELECT public.${name}(${params.join(',')});`;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
async function waitFor(predicate, description) {
  const until = Date.now() + 7_000;
  while (Date.now() < until) { if (await predicate()) return; await sleep(20); }
  throw new Error(`Timed out waiting for ${description}`);
}
async function race(first, second) {
  // Do not confuse PGlite's single connection or Promise.all with real lock races.
  const holder = client(`BEGIN;\n${first}\n\\echo ANNUAL_LOCK_HELD`, undefined, true);
  let contender;
  try {
    await waitFor(() => holder.output().includes('ANNUAL_LOCK_HELD'), 'holder transaction');
    contender = client(`BEGIN;\n${second}\nCOMMIT;`);
    await waitFor(async () => (await sql(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE application_name=${quote(contender.name)} AND wait_event_type='Lock');`)) === 't', 'contender lock wait');
    holder.child.stdin.end('COMMIT;\n');
    return await Promise.all([holder.done, contender.done]);
  } finally {
    if (!holder.child.stdin.writableEnded) holder.child.stdin.end('ROLLBACK;\n');
    await holder.done.catch(() => {});
    if (contender) await contender.done.catch(() => {});
  }
}
let dates;
async function site() {
  const identity = { site_id: randomUUID(), customer_id: id('cus'), subscription_id: id('sub') };
  await sql(`INSERT INTO sites(id,name) VALUES(${quote(identity.site_id)},'Synthetic annual concurrency');
    ${rpc('initialize_site_billing', [quote(identity.site_id)])}
    UPDATE billing SET stripe_customer_id=${quote(identity.customer_id)},stripe_subscription_id=${quote(identity.subscription_id)},
      subscription_status='active' WHERE site_id=${quote(identity.site_id)};
    UPDATE billing SET purchased_credits_available=40,legacy_credits_available=7,
      credits_available=plan_credits_available+47,account_balance=17.42 WHERE site_id=${quote(identity.site_id)};`);
  return identity;
}
const invoice = (identity, overrides = {}) => {
  const payload = {
  ...identity, invoice_id: id('in'), status: 'paid', amount: 1069.20, currency: 'USD',
  plan: 'foundry', addons_count: 2, billing_interval: 'year', billing_reason: 'subscription_create',
  current_subscription_status: 'active', period_start: dates.start, period_end: dates.end,
  paid_at: dates.now, coverage_verified: true, ...overrides,
  };
  return {current_service:{plan:payload.plan,
    addons_count:payload.addons_count,billing_interval:payload.billing_interval},...payload};
};
const settle = paid => rpc('settle_stripe_subscription_invoice', [quote(JSON.stringify(paid)) + '::jsonb']);
const sync = (identity,status,expected = identity.subscription_id,invoiceId = null) => rpc('sync_stripe_subscription_state',
  [quote(identity.site_id),quote(identity.customer_id),quote(identity.subscription_id),
    expected === null ? 'NULL' : quote(expected),quote(status),'NULL','NULL','NULL','true',
    invoiceId === null ? 'NULL' : quote(invoiceId)]);
const renew = identity => rpc('renew_site_plan_credits', [quote(identity.site_id)]);
const spend = identity => rpc('deduct_credits', [quote(identity.site_id), '3', "'usage'", "'Synthetic annual usage'", "'{}'::jsonb"]);
function balances(b, included, used = 0) {
  assert.equal(Number(b.plan_credits_available), included);
  assert.equal(Number(b.purchased_credits_available), 40);
  assert.equal(Number(b.legacy_credits_available), 7);
  assert.equal(Number(b.account_balance), 17.42);
  assert.equal(Number(b.credits_available), included + 47);
  assert.equal(Number(b.plan_credits_used), used);
}
const resetCount = identity => sql(`SELECT count(*) FROM credit_transactions WHERE site_id=${quote(identity.site_id)}
  AND transaction_type='plan_credit_reset';`).then(Number);
async function overdue(identity) {
  await sql(`UPDATE billing SET plan_credit_period_start=now()-interval '2 months',
    plan_credit_period_end=now()-interval '1 month',plan_credits_available=2,credits_available=49,
    plan_credits_used=108,monthly_credits_used=108 WHERE site_id=${quote(identity.site_id)};`);
}
try {
  command('initdb', ['-D', data, '-U', 'annual_test_admin', '-A', 'trust', '--no-instructions', '--locale=C']);
  command('pg_ctl', ['-D', data, '-l', join(temp, 'server.log'), '-w', '-t', '15', '-o',
    `-c listen_addresses='' -c unix_socket_directories='${temp}' -c port=${port} -c fsync=off`, 'start']);
  started = true;
  assert.equal(await sql('SHOW listen_addresses;'), undefined);
  assert.equal(await sql('SHOW data_directory;'), data);
  await sql(readFileSync(join(here, 'credit-fixture.sql'), 'utf8'));
  for (const file of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql', '20261003230002_classified_credit_operations.sql',
    '20261005230000_exact_credit_accounting_precision.sql', '20261007003000_remove_signup_credit_bonus.sql',
    '20261007180000_annual_subscription_credit_periods.sql', '20261007180001_subscription_checkout_leases.sql'])
    await sql(readFileSync(resolve(root, 'supabase/migrations', file), 'utf8'));
  dates = await json(`SELECT row_to_json(d) FROM (SELECT now()::text now,(now()-interval '5 days')::text start,
    (now()-interval '5 days'+interval '1 year')::text end,(now()+interval '25 days')::text month_end,
    (now()-interval '1 hour')::text older_paid_at) d;`);

  await check('annual renewal versus lazy spending serializes one reset in both orders', async () => {
    for (const reverse of [false, true]) {
      const identity = await site(); await sql(settle(invoice(identity))); await overdue(identity);
      const before = await resetCount(identity);
      const operations = [renew(identity), spend(identity)];
      if (reverse) operations.reverse();
      await race(...operations);
      balances(await row(identity.site_id), 107, 3);
      assert.equal(await resetCount(identity), before + 1);
      assert.equal(Number((await row(identity.site_id)).monthly_credits_used), 3);
      const tail = await json(`SELECT row_to_json(t) FROM (SELECT amount,metadata FROM credit_transactions
        WHERE site_id=${quote(identity.site_id)} AND transaction_type='plan_credit_reset'
        ORDER BY created_at DESC LIMIT 1) t;`);
      assert.equal(Number(tail.amount), 108);
      assert.equal(Number(tail.metadata.expired_credits), 2);
    }
  });
  await check('verified annual invoice versus worker serializes one current-month grant', async () => {
    for (const reverse of [false, true]) {
      const identity = await site(); const paid = invoice(identity); await sql(settle(paid)); await overdue(identity);
      const before = await resetCount(identity);
      const operations = [settle({ ...paid, invoice_id: id('in'), billing_reason: 'subscription_cycle' }), renew(identity)];
      if (reverse) operations.reverse();
      await race(...operations);
      balances(await row(identity.site_id), 110);
      assert.equal(await resetCount(identity), before + 1);
      assert.equal(await sql(`SELECT count(*) FROM stripe_subscription_invoice_settlements
        WHERE site_id=${quote(identity.site_id)};`), '2');
    }
  });
  await check('two first checkout claims, expired takeover and stale release are fenced', async () => {
    const identity = await site(); const claim = rpc('claim_site_subscription_checkout', [quote(identity.site_id)]);
    const [first, second] = await race(claim, claim);
    const firstClaim = JSON.parse(first.split('\n').find(line => line.startsWith('{')));
    assert.equal(firstClaim.state, 'claimed'); assert.match(second, /"state": "busy"/);
    await sql(`UPDATE site_subscription_checkout_leases SET lease_until=now()-interval '1 second'
      WHERE site_id=${quote(identity.site_id)};`);
    const [takeover, blocked] = await race(claim, claim);
    const replacement = JSON.parse(takeover.split('\n').find(line => line.startsWith('{')));
    assert.equal(replacement.state, 'claimed'); assert.match(blocked, /"state": "busy"/);
    assert.notEqual(replacement.token, firstClaim.token);
    assert.equal(await sql(rpc('finish_site_subscription_checkout', [quote(identity.site_id), quote(firstClaim.token)])), 'f');
    assert.equal(await sql(`SELECT token FROM site_subscription_checkout_leases WHERE site_id=${quote(identity.site_id)};`), replacement.token);
    assert.equal(await sql(rpc('finish_site_subscription_checkout', [quote(identity.site_id), quote(replacement.token)])), 't');
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(() => sql(`SET ROLE ${role}; ${claim}`), /permission denied/);
      await assert.rejects(() => sql(`SET ROLE ${role}; SELECT * FROM site_subscription_checkout_leases;`), /permission denied/);
    }
  });
  await check('settled recovery versus duplicate delivery grants verified coverage only once in both orders', async () => {
    for (const reverse of [false,true]) {
      const identity = await site(); const paid = invoice(identity);
      await sql(sync(identity,'paused'));
      await sql(settle({...paid,current_subscription_status:'paused'}));
      await sql(sync(identity,'active'));
      const operations = [settle(paid),settle({...paid,current_subscription_status:'paused'})];
      if (reverse) operations.reverse();
      await race(...operations);
      let b = await row(identity.site_id); balances(b,110);
      assert.equal(b.subscription_status,'active'); assert.equal(b.paid_subscription_invoice_id,paid.invoice_id);
      assert.equal(await resetCount(identity),1);
      assert.equal(await sql(`SELECT count(*) FROM stripe_subscription_invoice_settlements
        WHERE site_id=${quote(identity.site_id)};`),'1');
      await sql(spend(identity));
      await race(settle(paid),settle(paid));
      b = await row(identity.site_id); balances(b,107,3);
      assert.equal(await resetCount(identity),1);
      assert.equal(await sql(`SELECT credits FROM payments WHERE transaction_id=${quote('stripe_invoice_'+paid.invoice_id)};`),'110');
    }
  });
  await check('replacement binding and obsolete cancellation serialize without clearing replacement entitlement', async () => {
    for (const reverse of [false,true]) {
      const identity = await site(); await sql(settle(invoice(identity))); await sql(spend(identity));
      await sql(sync(identity,'canceled'));
      const replacement = {...identity,subscription_id:id('sub')}; const paid = invoice(replacement);
      const replacementTxn = sync(replacement,'active',identity.subscription_id) + settle(paid);
      const operations = [replacementTxn,sync(identity,'canceled',identity.subscription_id)];
      if (reverse) operations.reverse();
      await race(...operations);
      const b = await row(identity.site_id); balances(b,107,3);
      assert.equal(b.stripe_subscription_id,replacement.subscription_id);
      assert.equal(b.subscription_status,'active'); assert.equal(b.paid_subscription_invoice_id,paid.invoice_id);
      assert.equal(await resetCount(identity),1);
    }
  });
  await check('active invoice snapshots never overwrite a concurrently paused status', async () => {
    for (const reverse of [false,true]) {
      const identity = await site(); const paid = invoice(identity);
      const operations = [sync(identity,'paused'),settle(paid)];
      if (reverse) operations.reverse();
      await race(...operations);
      const b = await row(identity.site_id); assert.equal(b.subscription_status,'paused');
      const before = await resetCount(identity);
      assert.equal((await json(settle(paid))).credits_granted,0);
      assert.equal(await resetCount(identity),before);
      balances(b,reverse?110:0);
    }
  });
  await check('marker application before stale invoice status sync atomically suppresses paid and failed duplicate writes', async () => {
    for (const failedRetry of [false,true]) {
      const identity = await site(); const paid = invoice(identity);
      await sql(sync(identity,'paused')); await sql(settle({...paid,current_subscription_status:'paused'}));
      await sql(sync(identity,'active'));
      // An app's unlocked pre-read sees unapplied coverage. Recovery applies it
      // while the delayed same-ID paused snapshot waits on the billing lock.
      assert.equal(await sql(`SELECT credit_coverage_applied FROM stripe_subscription_invoice_settlements
        WHERE invoice_id=${quote(paid.invoice_id)};`),'f');
      const retry = {...paid,current_subscription_status:'paused',...(failedRetry?{status:'failed',paid_at:null}:{})};
      const outputs = await race(settle(paid)+spend(identity),
        sync(identity,'paused',identity.subscription_id,paid.invoice_id)+settle(retry));
      assert.ok(outputs[1].includes('"invoice_sync_skipped": true'));
      const b = await row(identity.site_id); balances(b,107,3);
      assert.equal(b.subscription_status,'active'); assert.equal(b.paid_subscription_invoice_id,paid.invoice_id);
      assert.equal(await resetCount(identity),1);
      await sql(sync(identity,'paused'));
      assert.equal((await row(identity.site_id)).subscription_status,'paused');
    }
  });
  await check('older longer annual update cannot supersede newer monthly entitlement under a race', async () => {
    for (const reverse of [false, true]) {
      const identity = await site(); await sql(settle(invoice(identity))); await sql(spend(identity));
      const newer = invoice(identity, { billing_reason: 'subscription_update', billing_interval: 'month',
        plan: 'engine', addons_count: 0, period_end: dates.month_end });
      const stale = invoice(identity, { billing_reason: 'subscription_update', paid_at: dates.older_paid_at });
      const operations = [settle(newer), settle(stale)];
      if (reverse) operations.reverse();
      await race(...operations);
      const b = await row(identity.site_id); balances(b, 17, 3);
      assert.equal(b.plan, 'engine'); assert.equal(b.billing_interval, 'month');
      assert.equal(b.paid_subscription_invoice_id, newer.invoice_id);
      assert.equal(Date.parse(b.paid_subscription_period_end), Date.parse(dates.month_end));
      assert.equal(await sql(`SELECT details->>'credit_outcome' FROM payments
        WHERE transaction_id=${quote('stripe_invoice_' + stale.invoice_id)};`), 'stale_period');
    }
    // A fresh same-tier update can still move the Stripe service anchor. It must
    // not move the next refill to one second from now after consuming this month.
    const identity = await site();
    const shifted = await json(`SELECT row_to_json(d) FROM (SELECT
      (now()-interval '4 months 5 days')::text start,(now()+interval '7 months 25 days')::text finish,
      (now()-interval '1 month'+interval '1 second')::text next_start,
      (now()-interval '1 month'+interval '1 second'+interval '1 year')::text next_finish) d;`);
    await sql(settle(invoice(identity, { period_start: shifted.start, period_end: shifted.finish })));
    await sql(rpc('deduct_credits', [quote(identity.site_id), '110', "'usage'", "'Synthetic consume month'", "'{}'::jsonb"]));
    const before = await row(identity.site_id);
    const resets = await resetCount(identity);
    await sql(settle(invoice(identity, { billing_reason: 'subscription_update',
      period_start: shifted.next_start, period_end: shifted.next_finish })));
    let after = await row(identity.site_id); balances(after, 0, 110);
    assert.equal(Date.parse(after.plan_credit_period_start), Date.parse(before.plan_credit_period_start));
    assert.equal(Date.parse(after.plan_credit_period_end), Date.parse(before.plan_credit_period_end));
    assert.equal(Date.parse(after.plan_credit_anchor), Date.parse(before.plan_credit_anchor));
    await sleep(1200);
    assert.equal((await json(renew(identity))).credits_granted, 0);
    after = await row(identity.site_id); balances(after, 0, 110);
    assert.equal(await resetCount(identity), resets);
  });
  assert.equal(await sql("SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND wait_event_type='Lock';"), '0');
  console.log(`Validated ${checks} real PostgreSQL annual concurrency scenarios`);
} finally { cleanup(); }