import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Memory-only PostgreSQL: no environment loading, URLs or remote connections.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const migrationName = '20261007003000_remove_signup_credit_bonus.sql';
const migrate = name => db.exec(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(`SELECT public.${name}(${params.map((_, i) => `$${i + 1}`).join(',')}) result`, params)).result;
const row = site => one('SELECT * FROM billing WHERE site_id=$1', [site]);
const site = async () => {
  const id = randomUUID();
  await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic monthly credit project')", [id]);
  return id;
};
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

try {
  await db.exec(readFileSync(resolve(here, 'credit-fixture.sql'), 'utf8'));
  for (const name of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql', '20261003230002_classified_credit_operations.sql',
    '20261005230000_exact_credit_accounting_precision.sql']) await migrate(name);
  const existing = await site();
  await rpc('initialize_site_billing', [existing]);
  await rpc('grant_purchased_site_credits', [existing, 12.5, randomUUID(), {}]);
  await db.query('UPDATE billing SET account_balance=17.42 WHERE site_id=$1', [existing]);
  const before = await row(existing);

  await check('forward migration removes future bonus without clawing back existing funds', async () => {
    await migrate(migrationName);
    assert.deepEqual(await row(existing), before);
    assert.equal(Number(before.plan_credits_available), 30);
    assert.equal(Number((await one('SELECT credits FROM payments WHERE site_id=$1', [existing])).credits), 30);
  });

  const fresh = await site();
  await check('new project receives exactly one credit for the current UTC month', async () => {
    const result = await rpc('initialize_site_billing', [fresh]);
    assert.equal(result.outcome, 'initialized');
    assert.equal(result.credits_granted, 1);
    assert.equal(Number(result.credits_available), 1);
    const billing = await row(fresh);
    assert.equal(billing.plan, 'commission');
    assert.equal(Number(billing.plan_credit_allowance), 1);
    assert.equal(Number(billing.plan_credits_available), 1);
    assert.equal(Number(billing.purchased_credits_available), 0);
    assert.equal(Number(billing.legacy_credits_available), 0);
    const bounds = await one(`SELECT plan_credit_period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' correct_start,
      plan_credit_period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' correct_end
      FROM billing WHERE site_id=$1`, [fresh]);
    assert.deepEqual(bounds, { correct_start: true, correct_end: true });
    assert.equal(Number((await one('SELECT credits FROM payments WHERE site_id=$1', [fresh])).credits), 1);
  });

  await check('same-month retries and missing markers cannot refill spent monthly credits', async () => {
    await rpc('deduct_credits', [fresh, 0.4, 'usage', 'Synthetic usage', {}]);
    for (let i = 0; i < 3; i++) assert.equal((await rpc('initialize_site_billing', [fresh])).credits_granted, 0);
    assert.equal(Number((await row(fresh)).credits_available), 0.6);
    assert.equal((await rpc('renew_site_plan_credits', [fresh])).outcome, 'not_due');
    await db.query('DELETE FROM payments WHERE site_id=$1', [fresh]);
    assert.equal((await rpc('initialize_site_billing', [fresh])).credits_granted, 0);
    assert.equal(Number((await row(fresh)).credits_available), 0.6);
    assert.equal(Number((await one('SELECT credits FROM payments WHERE site_id=$1', [fresh])).credits), 0);
  });

  await check('existing empty billing is never inferred to need a grant', async () => {
    const empty = await site();
    await db.query(`INSERT INTO billing(site_id,plan,credits_available,plan_credits_available)
      VALUES($1,'commission',0,0)`, [empty]);
    assert.equal((await rpc('initialize_site_billing', [empty])).credits_granted, 0);
    assert.equal(Number((await row(empty)).credits_available), 0);
  });

  await check('renewal replaces the included bucket once and preserves purchased and withdrawable funds', async () => {
    await rpc('grant_purchased_site_credits', [fresh, 12.5, randomUUID(), {}]);
    await db.query(`UPDATE billing SET account_balance=17.42,
      plan_credit_period_start=plan_credit_period_start-interval '1 month',
      plan_credit_period_end=plan_credit_period_end-interval '1 month' WHERE site_id=$1`, [fresh]);
    assert.equal((await rpc('renew_site_plan_credits', [fresh])).outcome, 'reset');
    const billing = await row(fresh);
    assert.equal(Number(billing.credits_available), 13.5);
    assert.equal(Number(billing.plan_credits_available), 1);
    assert.equal(Number(billing.account_balance), 17.42);
    assert.equal((await rpc('renew_site_plan_credits', [fresh])).outcome, 'not_due');
  });

  await check('missing and archived projects fail without creating financial records', async () => {
    assert.equal((await rpc('initialize_site_billing', [randomUUID()])).success, false);
    const archived = await site();
    await db.query('UPDATE sites SET archived_at=now() WHERE id=$1', [archived]);
    assert.equal((await rpc('initialize_site_billing', [archived])).success, false);
    assert.equal(await row(archived), undefined);
  });

  await check('initializer remains service-role-only and timezone-independent on replay', async () => {
    await migrate(migrationName);
    for (const role of ['anon', 'authenticated']) assert.equal((await one(
      "SELECT has_function_privilege($1,'public.initialize_site_billing(uuid)','EXECUTE') ok", [role])).ok, false);
    assert.equal((await one("SELECT has_function_privilege('service_role','public.initialize_site_billing(uuid)','EXECUTE') ok")).ok, true);
    await db.exec("SET TIME ZONE 'America/New_York'");
    const id = await site();
    assert.equal((await rpc('initialize_site_billing', [id])).credits_granted, 1);
    assert.equal((await one(`SELECT plan_credit_period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' ok
      FROM billing WHERE site_id=$1`, [id])).ok, true);
    await db.exec("SET TIME ZONE 'UTC'");
  });

  await check('first verified paid period can replace initial monthly credit without replay refill', async () => {
    const id = await site();
    await rpc('initialize_site_billing', [id]);
    const billing = await row(id);
    await db.query("UPDATE billing SET plan='engine',stripe_subscription_id='sub_synthetic',subscription_status='active' WHERE site_id=$1", [id]);
    const args = [id, billing.plan_credit_period_start, billing.plan_credit_period_end, 20, 'stripe_invoice:in_synthetic'];
    assert.equal((await rpc('reset_site_plan_credit_period', args)).outcome, 'reset');
    await rpc('deduct_credits', [id, 2, 'usage', 'Synthetic paid usage', {}]);
    assert.equal((await rpc('reset_site_plan_credit_period', args)).outcome, 'not_due');
    assert.equal(Number((await row(id)).credits_available), 18);
  });
  console.log(`Validated ${checks} initial monthly credit scenarios`);
} finally { await db.close(); }