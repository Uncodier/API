import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

// Offline PostgreSQL only. Exercise old paid windows across a forward migration.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(
  `SELECT ${name}(${params.map((_, index) => `$${index + 1}`).join(',')}) result`, params,
)).result;
const row = siteId => one('SELECT * FROM billing WHERE site_id=$1', [siteId]);
const identity = async () => {
  const siteId = randomUUID(), customer = `cus_${randomUUID().replaceAll('-', '')}`,
    subscription = `sub_${randomUUID().replaceAll('-', '')}`;
  await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic allowance change')", [siteId]);
  await rpc('initialize_site_billing', [siteId]);
  await db.query(`UPDATE billing SET stripe_customer_id=$2,stripe_subscription_id=$3,
    subscription_status='active' WHERE site_id=$1`, [siteId, customer, subscription]);
  return { siteId, customer, subscription };
};
const invoice = (account, interval, count, periodStart, periodEnd, reason = 'subscription_create') => ({
  site_id: account.siteId, customer_id: account.customer, subscription_id: account.subscription,
  invoice_id: `in_${randomUUID().replaceAll('-', '')}`, status: 'paid', amount: 25, currency: 'USD',
  plan: 'engine', addons_count: count, billing_reason: reason,
  current_subscription_status: 'active', billing_interval: interval,
  current_service: { plan: 'engine', addons_count: count, billing_interval: interval },
  coverage_verified: true, period_start: periodStart, period_end: periodEnd,
  paid_at: new Date().toISOString(),
});
try {
  await db.exec(readFileSync(resolve(here, 'credit-fixture.sql'), 'utf8'));
  for (const file of [
    '20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql',
    '20261003230002_classified_credit_operations.sql',
    '20261005230000_exact_credit_accounting_precision.sql',
    '20261007003000_remove_signup_credit_bonus.sql',
    '20261007180000_annual_subscription_credit_periods.sql',
    '20261007180001_subscription_checkout_leases.sql',
    '20261008210000_preserve_canceled_subscription_credit_usage.sql',
  ]) await db.exec(readFileSync(resolve(root, 'supabase/migrations', file), 'utf8'));
  const account = await identity();
  const dates = await one(`SELECT (now()-interval '40 days')::text start,
    (now()-interval '40 days'+interval '1 year')::text finish`);
  const paid = invoice(account, 'year', 2, dates.start, dates.finish);
  assert.equal((await rpc('settle_stripe_subscription_invoice', [paid])).credits_granted, 30);
  await rpc('deduct_credits', [account.siteId, 4, 'usage', 'Synthetic spent credits', {}]);
  await db.query(`UPDATE billing SET purchased_credits_available=7,legacy_credits_available=3,
    account_balance=2,credits_available=plan_credits_available+10 WHERE site_id=$1`, [account.siteId]);
  const before = await row(account.siteId);
  assert.equal(Number(before.plan_credits_available), 26);
  const monthly = await identity();
  const month = await one(`SELECT (now()-interval '1 day')::text start,
    (now()-interval '1 day'+interval '1 month')::text finish`);
  assert.equal((await rpc('settle_stripe_subscription_invoice', [invoice(monthly,
    'month', 2, month.start, month.finish)])).credits_granted, 30);
  await rpc('deduct_credits', [monthly.siteId, 3, 'usage', 'Synthetic old monthly usage', {}]);
  const financialState = async () => ({
    payments: (await db.query('SELECT * FROM payments ORDER BY id')).rows,
    ledger: (await db.query('SELECT * FROM credit_transactions ORDER BY id')).rows,
    settlements: (await db.query('SELECT * FROM stripe_subscription_invoice_settlements ORDER BY invoice_id')).rows,
  });
  const originalFinancialState = await financialState();
  await db.exec(readFileSync(resolve(root, 'supabase/migrations',
    '20261009040000_one_monthly_credit_per_addon.sql'), 'utf8'));
  assert.deepEqual(await row(account.siteId), before); // No retroactive changes to active windows or purchased funds.
  await db.exec(readFileSync(resolve(root, 'supabase/migrations',
    '20261009070000_preserve_paid_addon_credit_windows.sql'), 'utf8'));
  assert.deepEqual(await row(account.siteId), before);
  assert.deepEqual(await financialState(), originalFinancialState);
  assert.equal((await rpc('settle_stripe_subscription_invoice', [paid])).credits_granted, 0);
  // Buying new add-ons must not reprice those already granted in this paid month.
  await db.exec('BEGIN');
  const updateDates = await one(`SELECT (now()-interval '1 second')::text start,
    (now()+interval '1 year')::text finish`);
  const unchanged = invoice(account, 'year', 2, updateDates.start, updateDates.finish, 'subscription_update');
  await rpc('settle_stripe_subscription_invoice', [unchanged]);
  assert.equal(Number((await row(account.siteId)).plan_credit_allowance), 30);
  assert.equal(Number((await row(account.siteId)).plan_credits_available), 26);
  const upgrade = invoice(account, 'year', 3, updateDates.start, updateDates.finish, 'subscription_update');
  assert.equal((await rpc('settle_stripe_subscription_invoice', [upgrade])).credits_granted, 0);
  const upgraded = await row(account.siteId);
  assert.equal(Number(upgraded.plan_credit_allowance), 31);
  assert.equal(Number(upgraded.plan_credits_available), 27);
  assert.equal(Number(upgraded.plan_credits_used), 4);
  assert.equal(Number(upgraded.credits_available), 37);
  assert.equal(Number(upgraded.purchased_credits_available), 7);
  assert.equal(Number(upgraded.legacy_credits_available), 3);
  assert.equal(Number(upgraded.account_balance), 2);
  assert.equal((await rpc('settle_stripe_subscription_invoice', [upgrade])).credits_granted, 0);
  assert.deepEqual(await row(account.siteId), upgraded);
  for (const count of [4, 2, 3]) {
    await rpc('settle_stripe_subscription_invoice', [invoice(account,
      'year', count, updateDates.start, updateDates.finish, 'subscription_update')]);
    const state = await row(account.siteId);
    assert.equal(Number(state.plan_credit_allowance), 28 + count);
    assert.equal(Number(state.plan_credits_available), 24 + count);
    assert.equal(Number(state.plan_credits_used), 4);
  }
  const tierChange = invoice(account, 'year', 3, updateDates.start, updateDates.finish, 'subscription_update');
  tierChange.plan = 'foundry'; tierChange.current_service.plan = 'foundry';
  await rpc('settle_stripe_subscription_invoice', [tierChange]);
  assert.equal(Number((await row(account.siteId)).plan_credit_allowance), 111);
  await rpc('settle_stripe_subscription_invoice', [invoice(account,
    'year', 3, updateDates.start, updateDates.finish, 'subscription_update')]);
  assert.equal(Number((await row(account.siteId)).plan_credit_allowance), 31);
  const afterChanges = await row(account.siteId);
  const stale = invoice(account, 'year', 100, dates.start, dates.finish, 'subscription_update');
  stale.paid_at = dates.start;
  await rpc('settle_stripe_subscription_invoice', [stale]);
  assert.deepEqual(await row(account.siteId), afterChanges);
  await db.query(`UPDATE billing SET plan_credit_period_start=plan_credit_period_start-interval '3 months',
    plan_credit_period_end=now()-interval '1 second' WHERE site_id=$1`, [account.siteId]);
  assert.equal((await rpc('renew_site_plan_credits', [account.siteId])).credits_granted, 23);
  assert.equal(Number((await row(account.siteId)).plan_credits_available), 23);
  assert.equal(Number((await row(account.siteId)).plan_credits_used), 0);
  await db.exec('ROLLBACK');

  // The monthly add-on producer moves the payment anchor; usage is still retained.
  const reanchored = await one(`SELECT (now()-interval '1 second')::text start,
    (now()+interval '1 month')::text finish`);
  await rpc('settle_stripe_subscription_invoice', [invoice(monthly,
    'month', 3, reanchored.start, reanchored.finish, 'subscription_update')]);
  const oldMonthly = await row(monthly.siteId);
  assert.equal(Number(oldMonthly.plan_credit_allowance), 31);
  assert.equal(Number(oldMonthly.plan_credits_available), 28);
  assert.equal(Number(oldMonthly.plan_credits_used), 3);
  await db.query(`UPDATE billing SET plan_credit_period_start=plan_credit_period_start-interval '2 months',
    plan_credit_period_end=now()-interval '1 second' WHERE site_id=$1`, [monthly.siteId]);
  const nextCycle = await one(`SELECT (now()-interval '1 millisecond')::text start,
    (now()+interval '1 month')::text finish`);
  assert.equal((await rpc('settle_stripe_subscription_invoice', [invoice(monthly,
    'month', 3, nextCycle.start, nextCycle.finish, 'subscription_cycle')])).credits_granted, 23);
  assert.equal(Number((await row(monthly.siteId)).plan_credit_allowance), 23);
  for (const [plan, count, expected] of [
    ['commission', 3, 1], ['engine', 0, 20], ['engine', 2, 22],
    ['foundry', 2, 102], ['enterprise', 1, 501], ['unknown', 2, 0],
  ]) {
    assert.equal(Number((await one('SELECT site_plan_credit_allowance($1,$2) quota',
      [plan, count])).quota), expected);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const signature of ['public.site_plan_credit_allowance(text,integer)',
      'public.apply_paid_subscription_credit_coverage(jsonb)']) {
      assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok',
        [role, signature])).ok, role === 'service_role');
    }
  }
  const fresh = await identity();
  assert.equal((await rpc('settle_stripe_subscription_invoice', [invoice(fresh,
    'month', 2, month.start, month.finish)])).credits_granted, 22);
  assert.equal(Number((await row(fresh.siteId)).plan_credit_allowance), 22);
  await rpc('deduct_credits', [fresh.siteId, 3, 'usage', 'Synthetic monthly usage', {}]);
  const updated = await rpc('settle_stripe_subscription_invoice', [invoice(fresh,
    'month', 3, month.start, month.finish, 'subscription_update')]);
  assert.equal(updated.credits_granted, 0);
  const changed = await row(fresh.siteId);
  assert.equal(Number(changed.plan_credit_allowance), 23);
  assert.equal(Number(changed.plan_credits_available), 20);
  assert.equal(Number(changed.plan_credits_used), 3);
  // Simulate a skipped covered month; keep the immutable annual paid invoice untouched.
  const current = await row(account.siteId);
  await db.query(`UPDATE billing SET plan_credit_period_start=$2::timestamptz-interval '3 months',
    plan_credit_period_end=$2::timestamptz-interval '2 months',
    plan_credits_available=9,credits_available=19,plan_credits_used=21
    WHERE site_id=$1`, [account.siteId, current.plan_credit_period_start]);
  assert.equal((await rpc('renew_site_plan_credits', [account.siteId])).credits_granted, 22);
  const renewed = await row(account.siteId);
  assert.equal(Number(renewed.plan_credit_allowance), 22);
  assert.equal(Number(renewed.plan_credits_available), 22);
  assert.equal(Number(renewed.purchased_credits_available), 7);
  assert.equal(Number(renewed.legacy_credits_available), 3);
  assert.equal(Number(renewed.account_balance), 2);
  console.log('PASS forward add-on allowance: preserved old window, monthly invoice and update, annual renewal, access controls');
} finally {
  await db.close();
}