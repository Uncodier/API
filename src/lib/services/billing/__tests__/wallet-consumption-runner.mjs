import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { imageBootstrap, root } from './image-reservation-bootstrap.mjs';

// Isolated PostgreSQL only: no environment/configuration loading or network.
const db = new PGlite();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(
  `SELECT public.${name}(${params.map((_, i) => '$' + (i + 1)).join(',')}) result`, params,
)).result;
const debit = (site, amount, metadata = {}) => rpc('deduct_credits', [site, amount, 'usage', 'Synthetic usage', metadata]);
const snapshot = site => one('SELECT to_jsonb(b)::text value FROM billing b WHERE site_id=$1', [site]);
const seed = async ({ plan = '0', legacy = '0', purchased = '0', wallet = '39.22', trial = '0' } = {}) => {
  const site = randomUUID(), owner = randomUUID();
  await db.query("INSERT INTO sites(id,name,user_id) VALUES($1,'Synthetic withdrawable account',$2)", [site, owner]);
  await rpc('initialize_site_billing', [site]);
  if (Number(trial) > 0) {
    await db.query(`INSERT INTO site_startup_trials VALUES($1,$2,now()-interval '1 hour',now()+interval '359 hours',NULL)`, [owner, site]);
    await db.query(`UPDATE billing SET trial_started_at=t.started_at,trial_ends_at=t.ends_at,trial_credits_available=$2::numeric
      FROM site_startup_trials t WHERE billing.site_id=t.site_id AND billing.site_id=$1`, [site, trial]);
  }
  await db.query(`UPDATE billing SET plan_credits_available=$2::numeric,legacy_credits_available=$3::numeric,
    purchased_credits_available=$4::numeric,account_balance=$5::numeric,credits_used=0,monthly_credits_used=0,plan_credits_used=0,
    plan_credit_allowance=10,plan_credit_anchor=now()-interval '1 hour',plan_credit_period_start=now()-interval '1 hour',
    plan_credit_period_end=now()+interval '1 day' WHERE site_id=$1`, [site, plan, legacy, purchased, wallet]);
  return site;
};
const exact = async (site, expression) => {
  const result = await one(`SELECT ${expression} ok FROM billing WHERE site_id=$1`, [site]);
  assert.equal(result.ok, true, `${expression}: ${result.ok ? '' : JSON.stringify(await snapshot(site))}`);
};
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };

try {
  await db.exec(imageBootstrap);
  const unchangedSite = await seed({ wallet: '39.22', purchased: '0.01' });
  const beforeMigration = await snapshot(unchangedSite);
  await db.exec(readFileSync(resolve(root, 'supabase/migrations/20261118230000_withdrawable_credit_consumption.sql'), 'utf8'));
  await db.exec(readFileSync(resolve(root, 'supabase/migrations/20261014230000_openrouter_actual_cost_ledger.sql'), 'utf8'));
  await check('migration makes no balance changes', async () => {
    assert.deepEqual(await snapshot(unchangedSite), beforeMigration);
  });
  await check('wallet-only paid-past-due site spends fractional cost without reactivating entitlement', async () => {
    const site = await seed();
    await db.query(`UPDATE billing SET stripe_subscription_id=$2,subscription_status='past_due',
      plan_credit_period_start=now()-interval '2 months',plan_credit_period_end=now()-interval '1 month',
      paid_subscription_period_end=now()-interval '1 month' WHERE site_id=$1`, [site, 'sub_' + randomUUID().replaceAll('-', '')]);
    await db.query(`UPDATE billing SET plan_credit_period_start=now()-interval '2 months',
      plan_credit_period_end=now()-interval '1 month' WHERE site_id=$1`, [site]);
    assert.deepEqual(await debit(site, '0.1'), { success: true, remaining: 0, account_balance: 39.12, total_available: 39.12 });
    await exact(site, "credits_available=0 AND account_balance=39.12 AND credits_used=.1 AND monthly_credits_used=.1 AND plan_credits_used=0 AND plan='commission' AND subscription_status='past_due'");
    const ledger = await one('SELECT amount,metadata FROM credit_transactions WHERE site_id=$1 AND transaction_type=\'usage\'', [site]);
    assert.equal(Number(ledger.amount), -0.1);
    assert.deepEqual(ledger.metadata, { trial_credits_spent: 0, plan_credits_spent: 0, legacy_credits_spent: 0, purchased_credits_spent: 0, account_balance_spent: 0.1 });
  });
  await check('mixed debit preserves source order and overrides fabricated source metadata', async () => {
    const site = await seed({ trial: '0.01', plan: '0.02', legacy: '0.03', purchased: '0.04', wallet: '1' });
    assert.equal((await debit(site, '0.15', { account_balance_spent: 999, reference: 'synthetic' })).success, true);
    await exact(site, 'credits_available=0 AND account_balance=.95 AND credits_used=.15 AND monthly_credits_used=.15 AND plan_credits_used=.02');
    const { metadata } = await one("SELECT metadata FROM credit_transactions WHERE site_id=$1 AND transaction_type='usage'", [site]);
    assert.deepEqual(metadata, { trial_credits_spent: .01, plan_credits_spent: .02, legacy_credits_spent: .03,
      purchased_credits_spent: .04, account_balance_spent: .05, reference: 'synthetic' });
  });
  await check('regular funds are spent before wallet and both RPC signatures debit exactly once', async () => {
    for (const commerce of [false, true]) {
      const site = await seed({ purchased: '0.2', wallet: '1' });
      const result = commerce ? await rpc('deduct_credits', [site, '0.1']) : await debit(site, '0.1');
      assert.equal(commerce ? Number(result) : result.remaining, .1);
      await exact(site, 'purchased_credits_available=.1 AND credits_available=.1 AND account_balance=1 AND credits_used=.1');
      if (commerce) await rpc('deduct_credits', [site, '0.3']); else await debit(site, '0.3');
      await exact(site, 'credits_available=0 AND account_balance=.8 AND credits_used=.4 AND monthly_credits_used=.4');
      assert.equal((await one('SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1', [site])).n, 2);
    }
  });
  await check('insufficient total has no partial debit or ledger and reports combined available', async () => {
    const site = await seed({ purchased: '.04', wallet: '.05' }), before = await snapshot(site);
    assert.deepEqual(await debit(site, '.1'), { success: false, error: 'Insufficient credits', available: .09, required: .1 });
    assert.deepEqual(await snapshot(site), before);
    await assert.rejects(rpc('deduct_credits', [site, '.1']), /Insufficient total usable credits/);
    assert.deepEqual(await snapshot(site), before);
    assert.equal((await one('SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1', [site])).n, 0);
  });
  await check('negative wallet offsets available and null wallet remains null on regular-only debit', async () => {
    const negative = await seed({ purchased: '1', wallet: '-0.6' });
    assert.deepEqual(await debit(negative, '.5'), { success: false, error: 'Insufficient credits', available: .4, required: .5 });
    assert.equal((await debit(negative, '.4')).success, true);
    await exact(negative, 'credits_available=.6 AND account_balance=-.6');
    const nullable = await seed({ purchased: '1', wallet: null });
    assert.equal((await debit(nullable, '.1')).success, true);
    await exact(nullable, 'account_balance IS NULL AND credits_available=.9');
  });
  await check('nonfinite wallet and invalid amounts fail without moving funds', async () => {
    for (const wallet of ['NaN', 'Infinity', '-Infinity']) {
      const site = await seed({ wallet }), before = await snapshot(site);
      assert.deepEqual(await debit(site, '.1'), { success: false, error: 'Invalid billing credit balance' });
      assert.deepEqual(await snapshot(site), before);
    }
    const site = await seed(), before = await snapshot(site);
    for (const amount of ['0', '-1', 'NaN', 'Infinity', '-Infinity', null]) {
      await assert.rejects(debit(site, amount), /Invalid credit deduction/);
    }
    assert.deepEqual(await snapshot(site), before);
  });
  await check('exact sub-cent amounts conserve wallet and lifetime counters without rounding', async () => {
    const site = await seed({ purchased: '.000000009', wallet: '.123456789123456789' });
    assert.equal((await debit(site, '.00000001')).success, true);
    await exact(site, 'credits_available=0 AND account_balance=.123456788123456789 AND credits_used=.00000001');
  });
  await check('expired plan money does not fund a debit, wallet survives expiry', async () => {
    const site = await seed({ plan: '5', wallet: '.1' });
    await db.query(`UPDATE billing SET stripe_subscription_id=$2,subscription_status='past_due',
      plan_credit_period_end=now()-interval '1 minute',paid_subscription_period_end=now()-interval '1 minute'
      WHERE site_id=$1`, [site, 'sub_' + randomUUID().replaceAll('-', '')]);
    // Setting a new Stripe identity deliberately revokes the old included bucket.
    // Seed its expired, previously paid balance only after that identity boundary.
    await db.query(`UPDATE billing SET plan_credits_available=5,
      plan_credit_period_start=now()-interval '1 month',plan_credit_period_end=now()-interval '1 minute'
      WHERE site_id=$1`, [site]);
    assert.equal((await debit(site, '.1')).success, true);
    await exact(site, 'plan_credits_available=0 AND account_balance=0 AND credits_used=.1');
    assert.equal((await one("SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1 AND transaction_type='plan_credit_expiry'", [site])).n, 1);
  });
  await check('ledger failure rolls back credits wallet and usage together', async () => {
    const site = await seed({ purchased: '.04' }), before = await snapshot(site);
    await db.exec("CREATE FUNCTION reject_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic ledger failure'; END $$; CREATE TRIGGER reject_wallet_ledger BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger();");
    await assert.rejects(debit(site, '.1'), /Synthetic ledger failure/);
    assert.deepEqual(await snapshot(site), before);
    await db.exec('DROP TRIGGER reject_wallet_ledger ON credit_transactions');
  });
  await check('actual-cost provider settlement uses wallet with existing replay protection', async () => {
    const site = await seed(), id = 'gen-' + randomUUID();
    const first = await rpc('bill_openrouter_generation', [site, id, '.08', {}]);
    assert.equal(first.charged, .1);
    assert.deepEqual(await rpc('bill_openrouter_generation', [site, id, '.08', {}]), first);
    await exact(site, 'credits_available=0 AND account_balance=39.12 AND credits_used=.1');
    assert.equal((await one('SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1', [site])).n, 1);
  });
  await check('both debit signatures remain server-only', async () => {
    for (const signature of ['deduct_credits(uuid,numeric)', 'deduct_credits(uuid,numeric,text,text,jsonb)']) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok', [role, signature])).ok, false);
      }
      assert.equal((await one('SELECT has_function_privilege(\'service_role\',$1,\'EXECUTE\') ok', [signature])).ok, true);
    }
  });
  console.log(`Validated ${checks} withdrawable consumption scenarios`);
} finally { await db.close(); }