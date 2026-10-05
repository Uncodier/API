import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Memory-only PostgreSQL. Never loads environment/config or connects to Supabase.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(`SELECT ${name}(${params.map((_, i) => `$${i + 1}`).join(',')}) result`, params)).result;
const row = async site => one('SELECT * FROM billing WHERE site_id=$1', [site]);
const migration = name => db.exec(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'));
const canceled = randomUUID(), paid = randomUUID(), duplicate = randomUUID(), unknown = randomUUID();
const signup = randomUUID(), zero = randomUUID(), stripe = randomUUID();
const oldSignup = randomUUID();
const unprovenStripe = randomUUID();
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const close = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 0.00001, `${actual} != ${expected}`);

try {
  await db.exec(readFileSync(resolve(here, 'credit-fixture.sql'), 'utf8'));
  for (const site of [canceled, paid, duplicate, unknown, signup, zero, stripe, oldSignup, unprovenStripe])
    await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic credit test')", [site]);
  await db.query(`INSERT INTO billing(site_id,plan,credits_available,credits_used,account_balance,subscription_status,created_at)
    VALUES($1,'foundry',150,27,17.42,'canceled',now()-interval '2 months'),
    ($2,'foundry',160,13,8,'active',now()-interval '2 months'),
    ($3,'free',60,0,0,NULL,now()),($4,'foundry',70,0,0,'active',now()-interval '2 months'),
    ($5,'free',0,0,0,NULL,now())`, [canceled, paid, duplicate, unknown, zero]);
  for (const site of [canceled, paid]) {
    await db.query("INSERT INTO payments(site_id,credits,status,transaction_type,payment_method) VALUES($1,200,'completed','credit','credit_renewal')", [site]);
    await db.query("INSERT INTO payments(site_id,credits,status,transaction_type,payment_method,transaction_id) VALUES($1,20,'completed','credits_purchase','stripe',$2)", [site, `stripe_${randomUUID()}`]);
  }
  await db.query("INSERT INTO payments(site_id,credits,amount,status,transaction_type,payment_method,details,created_at) VALUES($1,30,0,'completed','credit','initial_credit',jsonb_build_object('note','Initial signup credits (fallback or new)'),now()+interval '1 second')", [duplicate]);
  await db.query("INSERT INTO billing(site_id,plan,credits_available,created_at) VALUES($1,'free',60,now()-interval '1 month')", [oldSignup]);
  await db.query("INSERT INTO payments(site_id,credits,amount,status,transaction_type,payment_method,details,created_at) VALUES($1,30,0,'completed','credit','initial_credit',jsonb_build_object('note','Initial signup credits (fallback or new)'),now()-interval '1 month'+interval '1 second')", [oldSignup]);
  await db.query("INSERT INTO billing(site_id,plan,credits_available,stripe_subscription_id,subscription_status) VALUES($1,'foundry',100,'sub_unproven','active')", [unprovenStripe]);
  await db.query("INSERT INTO payments(site_id,credits,status,transaction_type,payment_method) VALUES($1,100,'completed','credit','credit_renewal')", [unprovenStripe]);
  await migration('20261003230000_credit_buckets_and_monthly_reset.sql');
  await migration('20261003230002_classified_credit_operations.sql');
  await migration('20261005230000_exact_credit_accounting_precision.sql');

  await check('migration resets canceled allowance and preserves bought/withdrawable money', async () => {
    const b = await row(canceled);
    assert.equal(b.plan, 'commission'); close(b.plan_credits_available, 1);
    close(b.purchased_credits_available, 20); close(b.credits_available, 21); close(b.account_balance, 17.42);
    close(b.credits_used, 27); close((await row(paid)).plan_credits_available, 100);
    close((await row(paid)).credits_available, 120);
    close((await row(unknown)).legacy_credits_available, 70);
  });
  await check('duplicate signup balance is capped, no second fallback grant', async () => {
    close((await row(duplicate)).credits_available, 30);
    close((await row(oldSignup)).credits_available, 1);
    const result = await rpc('initialize_site_billing', [duplicate]);
    assert.equal(result.outcome, 'already_initialized'); assert.equal(result.credits_granted, 0);
    close((await row(duplicate)).credits_available, 30);
    const before = await row(zero);
    assert.equal((await rpc('initialize_site_billing', [zero])).credits_granted, 0);
    close((await row(zero)).credits_available, Number(before.credits_available));
  });
  await check('simultaneous signup retries have one winner and one audit payment', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => rpc('initialize_site_billing', [signup])));
    assert.equal(results.filter(r => r.outcome === 'initialized').length, 1);
    close((await row(signup)).credits_available, 30);
    assert.equal((await one("SELECT count(*)::int n FROM payments WHERE site_id=$1 AND payment_method='initial_credit'", [signup])).n, 1);
    const restored = randomUUID();
    await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic repaired billing')", [restored]);
    await db.query("INSERT INTO payments(site_id,credits,status,payment_method) VALUES($1,30,'completed','initial_credit')", [restored]);
    assert.equal((await rpc('initialize_site_billing', [restored])).credits_granted, 0);
    close((await row(restored)).credits_available, 0);
  });
  await check('renewal skips missed months and resets only current plan bucket once', async () => {
    await db.query("UPDATE billing SET plan_credit_period_start=date_trunc('month',now())-interval '4 months',plan_credit_period_end=date_trunc('month',now())-interval '3 months',monthly_credits_used=9 WHERE site_id=$1", [paid]);
    assert.equal((await rpc('renew_site_plan_credits', [paid])).outcome, 'reset');
    let b = await row(paid); close(b.credits_available, 120); close(b.monthly_credits_used, 0);
    close(b.account_balance, 8); close(b.credits_used, 13);
    await rpc('deduct_credits', [paid, 3, 'assistant_tokens', 'Synthetic usage', {}]);
    assert.equal((await rpc('renew_site_plan_credits', [paid])).outcome, 'not_due');
    b = await row(paid); close(b.plan_credits_available, 97); close(b.purchased_credits_available, 20);
    close(b.monthly_credits_used, 3); close(b.credits_used, 16);
  });
  await check('purchase grant is globally idempotent, rejects conflicts and survives renewal', async () => {
    const key = `stripe_${randomUUID()}`;
    assert.equal((await rpc('grant_purchased_site_credits', [paid, 52, key, {}])).outcome, 'granted');
    assert.equal((await rpc('grant_purchased_site_credits', [paid, 52, key, {}])).outcome, 'duplicate');
    await assert.rejects(() => rpc('grant_purchased_site_credits', [signup, 52, key, {}]), /idempotency conflict/);
    await assert.rejects(() => rpc('grant_purchased_site_credits', [paid, 20, key, {}]), /idempotency conflict/);
    close((await row(paid)).purchased_credits_available, 72);
    await db.query("UPDATE billing SET plan_credit_period_start=date_trunc('month',now())-interval '1 month',plan_credit_period_end=date_trunc('month',now()) WHERE site_id=$1", [paid]);
    await rpc('renew_site_plan_credits', [paid]); close((await row(paid)).purchased_credits_available, 72);
  });
  await check('usage consumes plan then protected then purchases, balance overload keeps contract', async () => {
    await rpc('deduct_credits', [paid, 105, 'assistant_tokens', 'Synthetic usage', {}]);
    let b = await row(paid); close(b.plan_credits_available, 0); close(b.purchased_credits_available, 67); close(b.account_balance, 8);
    await rpc('deduct_credits', [paid, 70]);
    b = await row(paid); close(b.credits_available, 0); close(b.account_balance, 5);
    await rpc('add_credits', [paid, 4, 'credit_restore', 'Synthetic restore', {}]);
    close((await row(paid)).legacy_credits_available, 4);
  });
  await check('terminal cancellation grants one only once, replay cannot refill consumed credits', async () => {
    await db.query("UPDATE billing SET subscription_status='canceled',plan='foundry',addons_count=3 WHERE site_id=$1", [paid]);
    let b = await row(paid); close(b.plan_credits_available, 1); assert.equal(b.plan, 'commission'); assert.equal(b.addons_count, 0);
    close(b.legacy_credits_available, 4); close(b.account_balance, 5);
    await rpc('deduct_credits', [paid, 0.5, 'assistant_tokens', 'Synthetic usage', {}]);
    await db.query("UPDATE billing SET subscription_status='canceled',plan='foundry',addons_count=3 WHERE site_id=$1", [paid]);
    b = await row(paid); close(b.plan_credits_available, 0.5); assert.equal(b.plan, 'commission'); assert.equal(b.addons_count, 0);
  });
  await check('old additive writers and malicious browser financial edits fail closed', async () => {
    await assert.rejects(() => db.query('UPDATE billing SET credits_available=credits_available+100 WHERE site_id=$1', [paid]), /Aggregate-only/);
    await assert.rejects(() => rpc('add_credits', [paid, 30]), /Unclassified additive/);
    await assert.rejects(() => rpc('add_credits', [paid, 100, 'credit_renewal', 'Synthetic', {}]), /Plan credits/);
    const actor = randomUUID();
    await db.query('UPDATE sites SET user_id=$2 WHERE id=$1', [signup, actor]);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.exec("SELECT set_config('request.jwt.claim.role','authenticated',false)");
    await assert.rejects(() => db.query('UPDATE billing SET updated_at=now() WHERE site_id=$1', [paid]), /manager authorization/);
    await assert.rejects(() => db.query("UPDATE billing SET plan='enterprise' WHERE site_id=$1", [signup]), /server managed/);
    await assert.rejects(() => db.query('UPDATE billing SET site_id=$2 WHERE site_id=$1', [signup, unknown]), /identity is immutable/);
    await db.exec("SELECT set_config('request.jwt.claim.role','',false)");
    for (const name of ['initialize_site_billing(uuid)','renew_site_plan_credits(uuid)',
      'grant_purchased_site_credits(uuid,numeric,text,jsonb)','deduct_credits(uuid,numeric,text,text,jsonb)']) {
      for (const who of ['anon','authenticated'])
        assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok', [who,name])).ok, false);
      assert.equal((await one('SELECT has_function_privilege(\'service_role\',$1,\'EXECUTE\') ok', [name])).ok, true);
    }
  });
  await check('Stripe active expired plan cannot spend old included allowance', async () => {
    await rpc('initialize_site_billing', [stripe]);
    await db.query("UPDATE billing SET plan='foundry',stripe_subscription_id='sub_synthetic',subscription_status='active',plan_credit_period_start=now()-interval '2 months',plan_credit_period_end=now()-interval '1 month' WHERE site_id=$1", [stripe]);
    await rpc('grant_purchased_site_credits', [stripe, 20, `stripe_${randomUUID()}`, {}]);
    assert.equal((await rpc('renew_site_plan_credits', [stripe])).outcome, 'stripe_managed');
    close((await row(stripe)).plan_credits_available, 0); close((await row(stripe)).purchased_credits_available, 20);
  });
  await check('negative NaN amounts fail and archived accounts do not refill', async () => {
    for (const amount of [-1, 0, 'NaN']) await assert.rejects(() => rpc('deduct_credits', [signup, amount, 'usage', 'Synthetic', {}]), /Invalid credit deduction/);
    await db.query('UPDATE sites SET archived_at=now() WHERE id=$1', [signup]);
    assert.equal((await rpc('renew_site_plan_credits', [signup])).outcome, 'inactive');
  });
  await check('terminal Stripe identity cannot revive through delayed subscription updates', async () => {
    await db.query("UPDATE billing SET subscription_status='canceled' WHERE site_id=$1", [stripe]);
    await assert.rejects(() => db.query("UPDATE billing SET subscription_status='active',plan='foundry' WHERE site_id=$1", [stripe]), /terminated Stripe subscription/);
    close((await row(stripe)).plan_credits_available, 1);
  });
  await check('period boundaries stay UTC under a non-UTC session timezone', async () => {
    await db.exec("SET TIME ZONE 'America/New_York'");
    const site = randomUUID();
    await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic timezone account')", [site]);
    await rpc('initialize_site_billing', [site]);
    const bounds = await one("SELECT plan_credit_period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' correct_start,plan_credit_period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' correct_end FROM billing WHERE site_id=$1", [site]);
    assert.deepEqual(bounds, { correct_start: true, correct_end: true });
    await db.exec("SET TIME ZONE 'UTC'");
  });
  await check('unverified Stripe periods have no paid bucket and verified signup transition is once', async () => {
    close((await row(unprovenStripe)).plan_credits_available, 0);
    const month = (await one("SELECT date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' start,(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' ending"));
    const fresh = randomUUID();
    await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic midnight subscription')", [fresh]);
    await rpc('initialize_site_billing', [fresh]);
    await db.query("UPDATE billing SET plan='engine',stripe_subscription_id='sub_midnight',subscription_status='active' WHERE site_id=$1", [fresh]);
    assert.equal((await rpc('reset_site_plan_credit_period', [fresh, month.start, month.ending, 20, 'stripe_invoice:in_midnight'])).outcome, 'reset');
    close((await row(fresh)).plan_credits_available, 20);
    await rpc('deduct_credits', [fresh, 2, 'usage', 'Synthetic usage', {}]);
    assert.equal((await rpc('reset_site_plan_credit_period', [fresh, month.start, month.ending, 20, 'stripe_invoice:in_second'])).outcome, 'not_due');
    close((await row(fresh)).plan_credits_available, 18);
  });
  console.log(`Validated ${checks} PostgreSQL credit scenarios`);
} finally { await db.close(); }