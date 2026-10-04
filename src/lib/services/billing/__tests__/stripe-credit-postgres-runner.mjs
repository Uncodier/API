import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline PostgreSQL only. No environment loading, credentials, Stripe or network.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const row = site => one('SELECT * FROM billing WHERE site_id=$1', [site]);
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const rpc = async (name, params) => (await one(
  `SELECT ${name}(${params.map((_, i) => `$${i + 1}`).join(',')}) result`, params,
)).result;
const settle = invoice => rpc('settle_stripe_subscription_invoice', [invoice]);
const number = (actual, expected) => assert.equal(Number(actual), expected);
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
let dates;
const createSite = async () => {
  const site_id = randomUUID(), customer_id = id('cus'), subscription_id = id('sub');
  await db.query('INSERT INTO sites(id,name) VALUES($1,$2)', [site_id, 'Synthetic invoice test']);
  await rpc('initialize_site_billing', [site_id]);
  await db.query(`UPDATE billing SET plan='foundry',stripe_customer_id=$2,stripe_subscription_id=$3,
    subscription_status='active' WHERE site_id=$1`, [site_id, customer_id, subscription_id]);
  await db.query(`UPDATE billing SET plan='foundry',stripe_customer_id=$2,stripe_subscription_id=$3,
    subscription_status='active',plan_credits_available=8,purchased_credits_available=40,
    legacy_credits_available=7,credits_available=55,plan_credit_allowance=100,
    monthly_credits_used=92,credits_used=123,account_balance=17.42,
    plan_credit_period_start=$4,plan_credit_period_end=$5 WHERE site_id=$1`,
  [site_id, customer_id, subscription_id, dates.old_start, dates.old_end]);
  return { site_id, customer_id, subscription_id };
};
const invoice = (identity, overrides = {}) => ({
  ...identity, invoice_id: id('in'), status: 'paid', amount: 49, currency: 'USD',
  plan: 'foundry', addons_count: 2, billing_reason: 'subscription_cycle',
  current_subscription_status: 'active',
  period_start: dates.start, period_end: dates.end, paid_at: dates.now,
  event_id: id('evt'), invoice_url: 'https://example.invalid/invoice', ...overrides,
});
const protectedBalances = (b, lifetimeUsed = 123) => {
  number(b.purchased_credits_available, 40); number(b.legacy_credits_available, 7);
  number(b.account_balance, 17.42); number(b.credits_used, lifetimeUsed);
};
const counts = site => one(`SELECT
  (SELECT count(*)::int FROM payments WHERE site_id=$1 AND payment_method='stripe') payments,
  (SELECT count(*)::int FROM stripe_subscription_invoice_settlements WHERE site_id=$1) settlements,
  (SELECT count(*)::int FROM credit_transactions WHERE site_id=$1 AND transaction_type='plan_credit_reset') resets`, [site]);

try {
  await db.exec(readFileSync(resolve(here, 'credit-fixture.sql'), 'utf8'));
  const bootstrap = { site_id: randomUUID(), customer_id: id('cus'), subscription_id: id('sub') };
  const oldInvoice = id('in');
  await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic migrated Stripe site')", [bootstrap.site_id]);
  await db.query(`INSERT INTO billing(site_id,plan,credits_available,account_balance,stripe_customer_id,
    stripe_subscription_id,subscription_status,subscription_current_period_end)
    VALUES($1,'foundry',55,17.42,$2,$3,'active',now()+interval '25 days')`,
  [bootstrap.site_id, bootstrap.customer_id, bootstrap.subscription_id]);
  await db.query(`INSERT INTO payments(site_id,transaction_id,transaction_type,status,payment_method,credits,amount,currency)
    VALUES($1,$2,'credits_purchase','completed','stripe',40,40,'USD'),
    ($1,$3,'subscription','completed','stripe',100,49,'USD')`,
  [bootstrap.site_id, id('purchase'), `stripe_invoice_${oldInvoice}`]);
  await db.query(`INSERT INTO credit_transactions(site_id,amount,transaction_type)
    VALUES($1,7,'credit_restore')`, [bootstrap.site_id]);
  await db.query(`INSERT INTO stripe_subscription_invoice_settlements(invoice_id,site_id,payment_id,
    customer_id,subscription_id,amount,currency,credits_granted)
    SELECT $2,$1,id,$3,$4,49,'USD',100 FROM payments WHERE transaction_id=$5`,
  [bootstrap.site_id, oldInvoice, bootstrap.customer_id, bootstrap.subscription_id, `stripe_invoice_${oldInvoice}`]);
  for (const migration of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql', '20261003230002_classified_credit_operations.sql'])
    await db.exec(readFileSync(resolve(root, 'supabase/migrations', migration), 'utf8'));
  dates = await one(`SELECT now()::text now,(now()-interval '40 days')::text old_start,
    (now()-interval '10 days')::text old_end,(now()-interval '5 days')::text start,
    (now()+interval '25 days')::text end,(now()-interval '1 day')::text newer_start,
    (now()+interval '29 days')::text newer_end,(now()+interval '1 day')::text future_start,
    (now()+interval '31 days')::text future_end`);

  await check('rollout preserves existing markers and never refills a migrated current period', async () => {
    const before = await row(bootstrap.site_id);
    number(before.plan_credits_available, 8); number(before.purchased_credits_available, 40);
    number(before.legacy_credits_available, 7); number(before.credits_available, 55);
    const paid = invoice(bootstrap, { period_start: before.plan_credit_period_start,
      period_end: before.plan_credit_period_end, addons_count: 0 });
    assert.equal((await settle({ ...paid, invoice_id: oldInvoice })).outcome, 'duplicate');
    assert.equal((await settle(paid)).credits_granted, 0);
    number((await row(bootstrap.site_id)).plan_credits_available, 8);
    assert.equal((await counts(bootstrap.site_id)).resets, 0);
  });

  await check('verified cycle resets included bucket only and resets monthly usage', async () => {
    const site = await createSite(), paid = invoice(site);
    const result = await settle(paid);
    assert.equal(result.outcome, 'settled'); assert.equal(result.credits_granted, 110);
    const b = await row(site.site_id); protectedBalances(b);
    number(b.plan_credits_available, 110); number(b.credits_available, 157);
    number(b.monthly_credits_used, 0); number(b.plan_credit_allowance, 110);
    assert.equal(new Date(b.plan_credit_period_start).getTime(), new Date(dates.start).getTime());
    assert.deepEqual(await counts(site.site_id), { payments: 1, settlements: 1, resets: 1 });
    const ledger = await one('SELECT * FROM credit_transactions WHERE site_id=$1', [site.site_id]);
    number(ledger.amount, 102); number(ledger.metadata.expired_credits, 8);
    assert.equal(ledger.metadata.source, `stripe_invoice:${paid.invoice_id}`);
    const payment = await one('SELECT * FROM payments WHERE id=$1', [result.payment_id]);
    assert.equal(payment.credits, 110); assert.equal(payment.details.credit_outcome, 'reset');
  });
  await check('invoice retry and different invoices in one period do not refill consumption', async () => {
    const site = await createSite(), paid = invoice(site);
    const first = await settle(paid);
    await rpc('deduct_credits', [site.site_id, 12, 'usage', 'Synthetic usage', {}]);
    assert.equal((await settle(paid)).outcome, 'duplicate');
    const another = await settle(invoice(site));
    assert.equal(another.outcome, 'settled'); assert.equal(another.credits_granted, 0);
    assert.equal((await settle({ ...paid, status: 'failed', paid_at: null })).outcome, 'ignored_failure');
    const b = await row(site.site_id); protectedBalances(b, 135);
    number(b.plan_credits_available, 98); number(b.monthly_credits_used, 12);
    assert.deepEqual(await counts(site.site_id), { payments: 2, settlements: 2, resets: 1 });
    assert.equal((await one('SELECT status FROM payments WHERE id=$1', [first.payment_id])).status, 'completed');
  });
  await check('newer current period resets once; out-of-order historical period does not', async () => {
    const site = await createSite();
    await settle(invoice(site));
    await rpc('deduct_credits', [site.site_id, 10, 'usage', 'Synthetic usage', {}]);
    const next = invoice(site, { plan: 'engine', addons_count: 1,
      period_start: dates.newer_start, period_end: dates.newer_end });
    assert.equal((await settle(next)).credits_granted, 25);
    await rpc('deduct_credits', [site.site_id, 2, 'usage', 'Synthetic usage', {}]);
    assert.equal((await settle(invoice(site))).credits_granted, 0);
    const b = await row(site.site_id); protectedBalances(b, 135);
    number(b.plan_credits_available, 23); number(b.monthly_credits_used, 2);
    number(b.credits_available, 70); number(b.plan_credit_allowance, 25);
    assert.deepEqual(await counts(site.site_id), { payments: 3, settlements: 3, resets: 2 });
  });
  await check('subscription update never resets or upgrades a period allowance', async () => {
    const site = await createSite();
    for (const fields of [{ period_start: null, period_end: null }, {}])
      assert.equal((await settle(invoice(site, { billing_reason: 'subscription_update',
        plan: 'enterprise', addons_count: 4, ...fields }))).credits_granted, 0);
    const b = await row(site.site_id); protectedBalances(b);
    number(b.plan_credits_available, 8); number(b.monthly_credits_used, 92);
    number(b.plan_credit_allowance, 100);
    assert.deepEqual(await counts(site.site_id), { payments: 2, settlements: 2, resets: 0 });
  });
  await check('failed invoice can transition to paid once without duplicate payment', async () => {
    const site = await createSite(), paid = invoice(site, { billing_reason: 'subscription_create' });
    const failure = await settle({ ...paid, status: 'failed', paid_at: null });
    assert.equal(failure.outcome, 'failed_recorded');
    number((await row(site.site_id)).plan_credits_available, 8);
    assert.equal((await counts(site.site_id)).settlements, 0);
    const result = await settle(paid);
    assert.equal(result.payment_id, failure.payment_id); assert.equal(result.credits_granted, 110);
    assert.equal((await settle(paid)).outcome, 'duplicate');
    assert.deepEqual(await counts(site.site_id), { payments: 1, settlements: 1, resets: 1 });
  });
  await check('expired invoices are settled auditably with zero credits and no retries', async () => {
    const site = await createSite(), paid = invoice(site, {
      period_start: dates.old_start, period_end: dates.old_end,
    });
    const result = await settle(paid);
    assert.equal(result.outcome, 'settled'); assert.equal(result.credits_granted, 0);
    assert.equal((await settle(paid)).outcome, 'duplicate');
    const b = await row(site.site_id); protectedBalances(b);
    number(b.plan_credits_available, 8); number(b.monthly_credits_used, 92);
    assert.equal((await one('SELECT details FROM payments WHERE id=$1', [result.payment_id])).details.credit_outcome, 'stale_period');
  });
  await check('terminal and inactive subscriptions cannot resurrect paid entitlement', async () => {
    for (const terminal of ['canceled', 'cancelled', 'incomplete_expired']) {
      const site = await createSite();
      await db.query('UPDATE billing SET subscription_status=$2 WHERE site_id=$1', [site.site_id, terminal]);
      await rpc('deduct_credits', [site.site_id, 0.5, 'usage', 'Synthetic usage', {}]);
      assert.equal((await settle(invoice(site))).credits_granted, 0);
      const b = await row(site.site_id); protectedBalances(b, 123.5);
      assert.equal(b.plan, 'commission'); assert.equal(b.addons_count, 0);
      number(b.plan_credits_available, 0.5); number(b.monthly_credits_used, 0.5);
    }
    for (const archived of [false, true]) {
      const site = await createSite();
      if (archived) await db.query('UPDATE sites SET archived_at=now() WHERE id=$1', [site.site_id]);
      else await db.query("UPDATE billing SET status='inactive' WHERE site_id=$1", [site.site_id]);
      assert.equal((await settle(invoice(site))).credits_granted, 0);
      number((await row(site.site_id)).plan_credits_available, 8);
    }
  });
  await check('scheduled cancellation remains entitled until terminal status', async () => {
    const site = await createSite();
    await db.query('UPDATE billing SET auto_renew=false WHERE site_id=$1', [site.site_id]);
    assert.equal((await settle(invoice(site))).credits_granted, 110);
    assert.equal((await row(site.site_id)).plan, 'foundry');
  });
  await check('verified live terminal status synchronizes stale active DB exactly once', async () => {
    for (const terminal of ['canceled', 'cancelled', 'incomplete_expired']) {
      const site = await createSite(), paid = invoice(site, { current_subscription_status: terminal });
      assert.equal((await settle(paid)).credits_granted, 0);
      let b = await row(site.site_id); protectedBalances(b);
      assert.equal(b.plan, 'commission'); assert.equal(b.subscription_status, terminal);
      number(b.plan_credits_available, 1); number(b.monthly_credits_used, 0);
      await rpc('deduct_credits', [site.site_id, 0.5, 'usage', 'Synthetic usage', {}]);
      assert.equal((await settle(paid)).outcome, 'duplicate');
      assert.equal((await settle(invoice(site, { current_subscription_status: terminal }))).credits_granted, 0);
      // A nonterminal invoice snapshot cannot revive the same terminated DB row.
      assert.equal((await settle(invoice(site))).credits_granted, 0);
      b = await row(site.site_id); protectedBalances(b, 123.5);
      number(b.plan_credits_available, 0.5); number(b.monthly_credits_used, 0.5);
      assert.equal(b.plan, 'commission');
    }
  });
  await check('missing, malformed, inverted, infinite and future paid periods fail closed', async () => {
    const site = await createSite();
    const invalid = [
      { period_start: null, period_end: null }, { period_end: null },
      { period_start: 'not-a-timestamp' }, { period_start: dates.end, period_end: dates.start },
      { period_end: dates.start }, { period_start: '-infinity', period_end: 'infinity' },
      { period_start: dates.future_start, period_end: dates.future_end },
      { paid_at: 'infinity' }, { amount: 'NaN' }, { amount: -1 }, { currency: 'usd' },
      { plan: 'free' }, { addons_count: 101 }, { invoice_id: 'invalid' },
      { current_subscription_status: 'unsupported' },
    ];
    for (const overrides of invalid) await assert.rejects(() => settle(invoice(site, overrides)));
    assert.deepEqual(await counts(site.site_id), { payments: 0, settlements: 0, resets: 0 });
    number((await row(site.site_id)).monthly_credits_used, 92);
  });
  await check('billing, payment and settlement identities stay tenant-bound', async () => {
    const site = await createSite(), other = await createSite(), paid = invoice(site);
    await assert.rejects(() => settle({ ...paid, customer_id: other.customer_id }), /billing identity mismatch/);
    await assert.rejects(() => settle({ ...paid, subscription_id: other.subscription_id }), /billing identity mismatch/);
    await settle(paid);
    await assert.rejects(() => settle({ ...paid, ...other }), /payment identity mismatch/);
    await assert.rejects(() => settle({ ...paid, amount: paid.amount + 1 }), /settlement identity mismatch/);
    await assert.rejects(() => settle({ ...paid, currency: 'EUR' }), /settlement identity mismatch/);
    assert.deepEqual(await counts(site.site_id), { payments: 1, settlements: 1, resets: 1 });
    assert.deepEqual(await counts(other.site_id), { payments: 0, settlements: 0, resets: 0 });
  });
  await check('legacy paid payments, historical grants and checkout require reconciliation', async () => {
    for (const mode of ['payment', 'grant', 'checkout']) {
      const site = await createSite(), paid = invoice(site, { billing_reason: 'subscription_create' });
      if (mode === 'grant') await db.query(`INSERT INTO credit_transactions(site_id,amount,metadata)
        VALUES($1,20,jsonb_build_object('stripe_invoice_id',$2::text))`, [site.site_id, paid.invoice_id]);
      else await db.query(`INSERT INTO payments(site_id,transaction_id,transaction_type,status,details)
        VALUES($1,$2,'subscription','completed',$3)`, [site.site_id,
      mode === 'payment' ? `stripe_invoice_${paid.invoice_id}` : id('checkout'),
      mode === 'checkout' ? { stripe_subscription_id: site.subscription_id, stripe_session_id: id('cs') } : {}]);
      await assert.rejects(() => settle(paid), /reconciliation required|requires credit reconciliation/);
      assert.equal((await counts(site.site_id)).settlements, 0);
      number((await row(site.site_id)).plan_credits_available, 8);
    }
  });
  await check('financial and marker writes rollback together if settlement insert fails', async () => {
    const site = await createSite(), paid = invoice(site);
    await db.exec(`CREATE FUNCTION reject_test_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic settlement failure'; END; $$;
      CREATE TRIGGER reject_test_settlement BEFORE INSERT ON stripe_subscription_invoice_settlements
      FOR EACH ROW EXECUTE FUNCTION reject_test_settlement();`);
    await assert.rejects(() => settle(paid), /Synthetic settlement failure/);
    const b = await row(site.site_id); protectedBalances(b);
    number(b.plan_credits_available, 8); number(b.monthly_credits_used, 92);
    assert.deepEqual(await counts(site.site_id), { payments: 0, settlements: 0, resets: 0 });
    await db.exec('DROP TRIGGER reject_test_settlement ON stripe_subscription_invoice_settlements; DROP FUNCTION reject_test_settlement();');
    assert.equal((await settle(paid)).credits_granted, 110);
  });
  await check('queued duplicate callers have one payment, one reset and one settlement', async () => {
    // PGlite queues calls; this checks deterministic idempotency, not multi-session lock contention.
    const site = await createSite(), paid = invoice(site);
    const results = await Promise.all([settle(paid), settle(paid), settle(paid)]);
    assert.equal(results.filter(r => r.outcome === 'settled').length, 1);
    assert.equal(results.filter(r => r.outcome === 'duplicate').length, 2);
    assert.deepEqual(await counts(site.site_id), { payments: 1, settlements: 1, resets: 1 });
  });
  await check('settlement and reset helper execute only for authorized service role', async () => {
    const site = await createSite(), paid = invoice(site);
    for (const fn of ['settle_stripe_subscription_invoice(jsonb)',
      'reset_site_plan_credit_period(uuid,timestamptz,timestamptz,numeric,text)']) {
      for (const role of ['anon', 'authenticated'])
        assert.equal((await one("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).ok, false);
      assert.equal((await one("SELECT has_function_privilege('service_role',$1,'EXECUTE') ok", [fn])).ok, true);
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(() => settle(paid), /permission denied/);
      await db.exec('RESET ROLE');
    }
    await db.exec("SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false)");
    assert.equal((await settle(paid)).credits_granted, 110);
    await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.role','',false)");
  });
  console.log(`Validated ${checks} PostgreSQL Stripe settlement scenarios`);
} finally { await db.close(); }