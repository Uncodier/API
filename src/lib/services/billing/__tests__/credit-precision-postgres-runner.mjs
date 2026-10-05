import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Memory-only PostgreSQL, never .env, application imports, credentials or network.
// Assert exact numeric equality in SQL, not JavaScript floats or epsilon rounding.
// PGlite serializes queries; the separate real-PG suite covers multi-session locks.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const migration = name => db.exec(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'));
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(
  `SELECT public.${name}(${params.map((_, i) => `$${i + 1}`).join(',')}) result`, params,
)).result;
const snapshot = site => one('SELECT to_jsonb(b)::text value FROM billing b WHERE site_id=$1', [site]);
const exact = async (site, expression, expected) => {
  const result = await one(`SELECT (${expression}) = $2::numeric ok FROM billing b WHERE site_id=$1`, [site, expected]);
  assert.equal(result.ok, true, `${expression} != ${expected}`);
};
const conserved = async site => {
  assert.equal((await one(`SELECT credits_available = plan_credits_available +
    legacy_credits_available + purchased_credits_available ok FROM billing WHERE site_id=$1`, [site])).ok, true);
};
const seed = async (plan = '96', legacy = '0', purchased = '20', balance = '3.123456789') => {
  const site = randomUUID();
  await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic precision test')", [site]);
  await rpc('initialize_site_billing', [site]);
  await db.query(`UPDATE billing SET plan='foundry' WHERE site_id=$1`, [site]);
  await db.query(`UPDATE billing SET plan_credits_available=$2::numeric,legacy_credits_available=$3::numeric,
    purchased_credits_available=$4::numeric,account_balance=$5::numeric,credits_used=7.25,
    monthly_credits_used=0,plan_credits_used=0 WHERE site_id=$1`, [site, plan, legacy, purchased, balance]);
  return site;
};
const deduct = (site, amount) => rpc('deduct_credits', [site, amount, 'credit_usage', 'Synthetic fractional usage', {}]);
const schema = async () => (await db.query(`SELECT table_name,column_name,data_type,numeric_precision,numeric_scale
  FROM information_schema.columns WHERE table_schema='public' AND
  ((table_name='billing' AND column_name IN ('credits_available','credits_used','account_balance'))
    OR (table_name='credit_transactions' AND column_name='amount')
    OR (table_name='payments' AND column_name IN ('amount','credits')))
  ORDER BY table_name,column_name`)).rows;
const security = async () => ({
  functions: (await db.query(`SELECT oid::regprocedure::text signature,prosrc,prosecdef,proconfig,proacl::text
    FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows,
  tables: (await db.query(`SELECT relname,relacl::text,relrowsecurity,relforcerowsecurity
    FROM pg_class WHERE oid IN ('billing'::regclass,'credit_transactions'::regclass,
      'billing_credit_grant_keys'::regclass,'billing_credit_migration_audit'::regclass) ORDER BY relname`)).rows,
  triggers: (await db.query(`SELECT pg_get_triggerdef(oid) definition FROM pg_trigger
    WHERE tgrelid='billing'::regclass ORDER BY tgname`)).rows,
  constraints: (await db.query(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid IN ('billing'::regclass,'credit_transactions'::regclass) ORDER BY conname`)).rows,
  defaults: (await db.query(`SELECT table_name,column_name,column_default,is_nullable
    FROM information_schema.columns WHERE table_schema='public' AND
    table_name IN ('billing','credit_transactions') ORDER BY table_name,column_name`)).rows,
});
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

try {
  await db.exec(readFileSync(resolve(here, 'credit-fixture.sql'), 'utf8'));
  for (const name of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql', '20261003230002_classified_credit_operations.sql'])
    await migration(name);
  const original = await seed();

  await check('legacy numeric(10,4) reproduces aggregate CHECK failure and rolls back', async () => {
    const types = await schema();
    for (const [table, column] of [['billing', 'credits_available'], ['billing', 'credits_used'],
      ['credit_transactions', 'amount']]) {
      const type = types.find(t => t.table_name === table && t.column_name === column);
      assert.equal(type.numeric_precision, 10); assert.equal(type.numeric_scale, 4);
    }
    assert.deepEqual(await one(`SELECT (95.497751 + 20)::numeric(10,4)::text rounded,
      (0.502249::numeric(10,4))::text rounded_usage`), { rounded: '115.4978', rounded_usage: '0.5022' });
    const before = await snapshot(original);
    await assert.rejects(() => deduct(original, '0.502249'), error =>
      error.code === '23514' && /billing_credit_buckets_valid/.test(error.message));
    assert.deepEqual(await snapshot(original), before);
    assert.equal((await one('SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1', [original])).n, 0);
    await assert.rejects(() => rpc('grant_purchased_site_credits', [original, '0.000000007', randomUUID(), {}]),
      /billing_credit_buckets_valid/);
    assert.equal((await one('SELECT count(*)::int n FROM billing_credit_grant_keys WHERE site_id=$1', [original])).n, 0);
  });

  await check('forward migration preserves all stored values and security, widening only credit typmods', async () => {
    await db.query(`INSERT INTO credit_transactions(site_id,amount,transaction_type)
      VALUES($1,1.2345,'synthetic_before_migration')`, [original]);
    const before = await snapshot(original), guards = await security();
    const ledger = await one('SELECT to_jsonb(t)::text value FROM credit_transactions t WHERE site_id=$1', [original]);
    const types = await schema();
    await migration('20261005230000_exact_credit_accounting_precision.sql');
    assert.deepEqual(await snapshot(original), before);
    assert.deepEqual(await one('SELECT to_jsonb(t)::text value FROM credit_transactions t WHERE site_id=$1', [original]), ledger);
    assert.deepEqual(await security(), guards);
    const after = await schema();
    for (const type of after) {
      if ((type.table_name === 'billing' && type.column_name !== 'account_balance') || type.table_name === 'credit_transactions') {
        assert.equal(type.data_type, 'numeric'); assert.equal(type.numeric_precision, null); assert.equal(type.numeric_scale, null);
      } else assert.deepEqual(type, types.find(t => t.table_name === type.table_name && t.column_name === type.column_name));
    }
    await exact(original, 'account_balance', '3.123456789');
  });

  await check('sequential sub-four-place deductions conserve exact aggregate, counters and ledger', async () => {
    const site = await seed();
    for (const [amount, remaining] of [['0.502249', '115.497751'], ['0.00000007', '115.49775093'],
      ['0.12500009', '115.37275084']]) {
      assert.equal((await deduct(site, amount)).success, true);
      await exact(site, 'credits_available', remaining);
      await conserved(site);
    }
    await exact(site, 'plan_credits_available', '95.37275084');
    await exact(site, 'purchased_credits_available', '20');
    await exact(site, 'credits_used', '7.87724916');
    await exact(site, 'monthly_credits_used', '0.62724916');
    await exact(site, 'plan_credits_used', '0.62724916');
    await exact(site, 'account_balance', '3.123456789');
    await exact(site, '(SELECT sum(amount) FROM credit_transactions WHERE site_id=b.site_id)', '-0.62724916');
    await exact(site, `(SELECT sum((metadata->>'plan_credits_spent')::numeric)
      FROM credit_transactions WHERE site_id=b.site_id)`, '0.62724916');
  });

  await check('fractional deductions cross plan then legacy then purchased and exhaust exactly', async () => {
    const site = await seed('0.123456789', '0.234567891', '0.765432198');
    assert.equal((await deduct(site, '0.400000003')).success, true);
    await exact(site, 'plan_credits_available', '0'); await exact(site, 'legacy_credits_available', '0');
    await exact(site, 'purchased_credits_available', '0.723456875');
    await exact(site, 'credits_available', '0.723456875');
    for (const [bucket, amount] of [['plan', '0.123456789'], ['legacy', '0.234567891'], ['purchased', '0.041975323']])
      await exact(site, `(SELECT (metadata->>'${bucket}_credits_spent')::numeric
        FROM credit_transactions WHERE site_id=b.site_id)`, amount);
    assert.equal((await deduct(site, '0.723456875')).success, true);
    await exact(site, 'credits_available', '0'); await exact(site, 'purchased_credits_available', '0');
    await exact(site, 'credits_used', '8.373456878'); await exact(site, 'monthly_credits_used', '1.123456878');
    await exact(site, 'plan_credits_used', '0.123456789');
    await exact(site, '(SELECT sum(amount) FROM credit_transactions WHERE site_id=b.site_id)', '-1.123456878');
    await conserved(site);
    const before = await snapshot(site);
    assert.equal((await deduct(site, '0.000000001')).success, false);
    assert.deepEqual(await snapshot(site), before);
  });

  await check('fractional purchased and legacy grants retain exact amounts and purchase idempotency', async () => {
    const site = await seed('2', '0', '0'), key = randomUUID(), routed = randomUUID();
    assert.equal((await rpc('grant_purchased_site_credits', [site, '0.123456789', key, {}])).outcome, 'granted');
    assert.equal((await rpc('grant_purchased_site_credits', [site, '0.123456789', key, {}])).outcome, 'duplicate');
    await assert.rejects(() => rpc('grant_purchased_site_credits', [site, '0.123456788', key, {}]), /idempotency conflict/);
    assert.equal((await rpc('add_credits', [site, '0.000000007', 'credit_restore', 'Synthetic refund', {}])).success, true);
    assert.equal((await rpc('add_credits', [site, '0.000000003', 'credits_purchase', 'Synthetic purchase', { idempotency_key: routed }])).outcome, 'granted');
    await exact(site, 'credits_available', '2.123456799');
    await exact(site, 'legacy_credits_available', '0.000000007');
    await exact(site, 'purchased_credits_available', '0.123456792');
    await exact(site, '(SELECT sum(amount) FROM credit_transactions WHERE site_id=b.site_id)', '0.123456799');
    await exact(site, '(SELECT sum(amount) FROM billing_credit_grant_keys WHERE site_id=b.site_id)', '0.123456792');
    await exact(site, 'credits_used', '7.25'); await exact(site, 'account_balance', '3.123456789');
    await conserved(site);
  });

  await check('monthly renewal expires fractional plan saldo exactly without changing protected balances', async () => {
    const site = await seed('1.000000009', '0.234567891', '0.765432198');
    await db.query(`UPDATE billing SET plan_credit_period_start=now()-interval '2 months',
      plan_credit_period_end=now()-interval '1 month',monthly_credits_used=0.123456789,
      plan_credits_used=0.123456789 WHERE site_id=$1`, [site]);
    assert.equal((await rpc('renew_site_plan_credits', [site])).outcome, 'reset');
    await exact(site, 'plan_credits_available', '100');
    await exact(site, 'credits_available', '101.000000089');
    await exact(site, 'legacy_credits_available', '0.234567891');
    await exact(site, 'purchased_credits_available', '0.765432198');
    await exact(site, 'account_balance', '3.123456789'); await exact(site, 'credits_used', '7.25');
    await exact(site, 'monthly_credits_used', '0'); await exact(site, 'plan_credits_used', '0');
    await exact(site, '(SELECT sum(amount) FROM credit_transactions WHERE site_id=b.site_id)', '98.999999991');
    const before = await snapshot(site);
    assert.equal((await rpc('renew_site_plan_credits', [site])).outcome, 'not_due');
    assert.deepEqual(await snapshot(site), before); await conserved(site);
  });

  await check('commerce overload consumes regular buckets first then exact account_balance and usage', async () => {
    const site = await seed('0.123456789', '0.234567891', '0.345678912', '2.123456789');
    assert.equal(Number(await rpc('deduct_credits', [site, '1.000000003'])), 0);
    await exact(site, 'credits_available', '0'); await exact(site, 'account_balance', '1.827160378');
    await exact(site, 'credits_used', '8.250000003'); await exact(site, 'monthly_credits_used', '1.000000003');
    await exact(site, 'plan_credits_used', '0.123456789');
    // Existing commerce contract logs the regular-credit portion only; do not
    // change that behavior or invent account-balance ledger entries in this fix.
    await exact(site, '(SELECT sum(amount) FROM credit_transactions WHERE site_id=b.site_id)', '-0.703703592');
    await rpc('deduct_credits', [site, '0.000000007']);
    await exact(site, 'account_balance', '1.827160371'); await exact(site, 'credits_used', '8.250000010');
    await exact(site, 'monthly_credits_used', '1.000000010');
    await exact(site, 'account_balance + monthly_credits_used', '2.827160381'); await conserved(site);
    const before = await snapshot(site);
    await assert.rejects(() => rpc('deduct_credits', [site, '1.827160372']), /Insufficient total usable credits/);
    assert.deepEqual(await snapshot(site), before);
  });

  await check('precision widening preserves finite inputs, classified-only writes and browser denial', async () => {
    const site = await seed();
    for (const amount of ['0', '-0.000000001', 'NaN', 'Infinity', '-Infinity']) {
      await assert.rejects(() => deduct(site, amount), /Invalid credit deduction/);
      await assert.rejects(() => rpc('deduct_credits', [site, amount]), /Invalid credit deduction/);
      await assert.rejects(() => rpc('grant_purchased_site_credits', [site, amount, randomUUID(), {}]), /Invalid purchased credit grant/);
      await assert.rejects(() => rpc('add_credits', [site, amount, 'credit_restore', 'Synthetic', {}]), /Invalid credit amount/);
    }
    await assert.rejects(() => db.query('UPDATE billing SET credits_available=credits_available+1 WHERE site_id=$1', [site]), /Aggregate-only credit writes/);
    await assert.rejects(() => db.query('UPDATE billing SET purchased_credits_available=-0.000000001 WHERE site_id=$1', [site]), /billing_credit_buckets_valid/);
    await assert.rejects(() => rpc('add_credits', [site, '0.000000001', 'credit_renewal', 'Synthetic', {}]), /idempotent plan-period RPC/);
    const before = await snapshot(site);
    await db.exec("SET request.jwt.claim.role='authenticated'");
    await assert.rejects(() => deduct(site, '0.000000001'), /Billing manager authorization required/);
    await db.exec("RESET request.jwt.claim.role");
    assert.deepEqual(await snapshot(site), before);
    for (const name of ['deduct_credits(uuid,numeric)', 'deduct_credits(uuid,numeric,text,text,jsonb)',
      'add_credits(uuid,numeric,text,text,jsonb)', 'grant_purchased_site_credits(uuid,numeric,text,jsonb)']) {
      assert.deepEqual(await one(`SELECT has_function_privilege('anon',$1,'EXECUTE') anon,
        has_function_privilege('authenticated',$1,'EXECUTE') browser,
        has_function_privilege('service_role',$1,'EXECUTE') server`, [name]), { anon: false, browser: false, server: true });
    }
  });
  console.log(`Validated ${checks} PostgreSQL credit precision scenarios`);
} finally { await db.close(); }