import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Memory-only PostgreSQL with actual production bucket guards and numeric types.
// Single connection tests rollback/idempotence; not a multi-connection race proof.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const db = new PGlite();
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rpc = async (name, values) => (await one(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) result`, values)).result;
const migration = name => db.exec(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'));
const seed = async (plan = '2', legacy = '3', purchased = '4') => {
  const site = randomUUID(), session = randomUUID(), requirement = randomUUID();
  await db.query('INSERT INTO sites(id) VALUES($1)', [site]);
  await rpc('initialize_site_billing', [site]);
  await db.query("UPDATE billing SET plan='foundry' WHERE site_id=$1", [site]);
  await db.query(`UPDATE billing SET plan_credits_available=$2::numeric,legacy_credits_available=$3::numeric,
    purchased_credits_available=$4::numeric,credits_used=7.25,monthly_credits_used=0,plan_credits_used=0,
    account_balance=3.123456789 WHERE site_id=$1`, [site, plan, legacy, purchased]);
  await db.query('INSERT INTO requirements VALUES($1,$2,true)', [requirement, site]);
  await db.query(`INSERT INTO harness_sessions VALUES($1,$2,'owner',now()+interval '1 hour','{"status":"running"}')`, [session, site]);
  return { site, session, requirement };
};
const balance = site => one(`SELECT trim_scale(plan_credits_available)::text plan,trim_scale(legacy_credits_available)::text legacy,
  trim_scale(purchased_credits_available)::text purchased,trim_scale(credits_available)::text available,trim_scale(credits_used)::text used,
  trim_scale(monthly_credits_used)::text monthly,trim_scale(plan_credits_used)::text plan_used,trim_scale(account_balance)::text account FROM billing WHERE site_id=$1`, [site]);
const hold = (s, event, amount, owner = 'owner') => rpc('reserve_agent_requirement_credits', [s.requirement, owner, 0, s.session, event, amount]);
const dispatch = (s, event) => rpc('dispatch_harness_model_reservation', [s.session, event]);
const settle = (s, event, cost, generation = null) => rpc('settle_harness_model_reservation', [s.session, event, cost, generation, 'test/model']);
const cancel = (s, event, reason = 'predispatch') => rpc('cancel_harness_model_reservation', [s.session, event, reason]);
const reserved = async (s, amount) => {
  const event = randomUUID(); assert.equal((await hold(s, event, amount)).success, true); return event;
};
const conserved = async site => {
  assert.equal((await one(`SELECT credits_available=plan_credits_available+legacy_credits_available+purchased_credits_available ok
    FROM billing WHERE site_id=$1`, [site])).ok, true);
};
let checks = 0;
const check = async (name, test) => { await test(); checks++; console.log(`PASS ${name}`); };
try {
  await db.exec(readFileSync(resolve(root, 'src/lib/services/billing/__tests__/credit-fixture.sql'), 'utf8'));
  for (const name of ['20261003230000_credit_buckets_and_monthly_reset.sql', '20261003230001_stripe_plan_credit_reset.sql',
    '20261003230002_classified_credit_operations.sql', '20261005230000_exact_credit_accounting_precision.sql']) await migration(name);
  await db.exec(`CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid REFERENCES sites(id),active boolean);
    CREATE TABLE harness_sessions(id uuid PRIMARY KEY,site_id uuid REFERENCES sites(id),lease_owner text,lease_expires_at timestamptz,snapshot jsonb);
    CREATE FUNCTION assert_agent_requirement_run(uuid,text,integer,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT coalesce((SELECT active FROM public.requirements WHERE id=$1),false) AND $2='owner' $$;`);
  await migration('20261014050000_agent_requirement_credit_reservation.sql');
  const historical = await seed();
  const oldEvent = randomUUID();
  await hold(historical, oldEvent, '0.12500009');
  const historicalBefore = await balance(historical.site);
  await migration('20261014230000_openrouter_actual_cost_ledger.sql');
  await migration('20261014230001_agent_actual_cost_settlement.sql');
  await check('historical reservations and balances are not guessed or refunded on migration', async () => {
    assert.deepEqual(await balance(historical.site), historicalBefore);
    assert.equal((await one('SELECT count(*)::int n FROM harness_requirement_credit_reservations')).n, 1);
    assert.equal((await one('SELECT count(*)::int n FROM harness_model_credit_reservations')).n, 0);
  });
  await check('true admission hold, live owner, full reverse bucket refund, same event retry', async () => {
    const s = await seed(); const before = await balance(s.site); const event = randomUUID();
    assert.equal((await hold(s, event, '6', 'stale')).success, false);
    assert.equal((await hold(s, event, '6')).state, 'reserved');
    assert.equal((await hold(s, event, '6')).state, 'reserved');
    assert.deepEqual(await balance(s.site), { plan: '0', legacy: '0', purchased: '3', available: '3', used: '13.25', monthly: '6', plan_used: '2', account: '3.123456789' });
    assert.equal((await hold(s, randomUUID(), '1')).success, false);
    assert.equal((await cancel(s, event)).success, true);
    assert.equal((await cancel(s, event)).success, true);
    assert.deepEqual(await balance(s.site), before);
    assert.equal((await one(`SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1 AND transaction_type='agent_model_refund'`, [s.site])).n, 1);
  });
  await check('actual cost x1.25 settles across three buckets once despite lost response and pause', async () => {
    const s = await seed(); const event = await reserved(s, '6');
    await dispatch(s, event); await dispatch(s, event);
    await db.query('UPDATE requirements SET active=false WHERE id=$1', [s.requirement]);
    await db.query(`UPDATE harness_sessions SET lease_owner=NULL,lease_expires_at=NULL,snapshot='{"status":"paused"}' WHERE id=$1`, [s.session]);
    assert.equal((await settle(s, event, '2.4', 'synthetic-three-buckets')).charged, 3);
    const after = await balance(s.site);
    assert.deepEqual(after, { plan: '0', legacy: '2', purchased: '4', available: '6', used: '10.25', monthly: '3', plan_used: '2', account: '3.123456789' });
    assert.equal((await settle(s, event, '2.4', 'synthetic-three-buckets')).success, true);
    assert.deepEqual(await balance(s.site), after);
    await assert.rejects(() => settle(s, event, '2.5', 'synthetic-three-buckets'), /conflict/);
    await conserved(s.site);
  });
  await check('fractional and zero actual usage retain exact numeric precision', async () => {
    const s = await seed(); let event = await reserved(s, '0.1'); await dispatch(s, event);
    await settle(s, event, '0.000000009', 'synthetic-tiny');
    assert.equal((await one('SELECT credits_available=8.99999998875 ok FROM billing WHERE site_id=$1', [s.site])).ok, true);
    assert.equal((await one('SELECT credits_used=7.25000001125 ok FROM billing WHERE site_id=$1', [s.site])).ok, true);
    const before = await balance(s.site); event = await reserved(s, '0.1'); await dispatch(s, event);
    assert.equal((await settle(s, event, '0', 'synthetic-free')).charged, 0);
    assert.deepEqual(await balance(s.site), before); await conserved(s.site);
  });
  await check('unknown outcomes block fresh dispatch, persist identity, and settle later exactly once', async () => {
    const s = await seed(); const event = await reserved(s, '0.5'); await dispatch(s, event);
    const held = await balance(s.site);
    assert.equal((await settle(s, event, null)).state, 'pending');
    assert.equal((await one('SELECT count(*)::int n FROM openrouter_generation_charges WHERE event_id=$1', ['harness:'+event])).n, 1);
    assert.equal((await settle(s, event, null, 'synthetic-uncertain')).state, 'pending');
    assert.equal((await one('SELECT count(*)::int n FROM openrouter_generation_charges WHERE event_id=$1', ['harness:'+event])).n, 0);
    assert.deepEqual(await balance(s.site), held);
    assert.equal((await hold(s, randomUUID(), '0.5')).success, false);
    await assert.rejects(() => cancel(s, event), /Cannot refund/);
    assert.equal((await rpc('bill_openrouter_generation', [s.site, 'synthetic-uncertain', '0.2', {}])).success, false);
    assert.deepEqual(await balance(s.site), held);
    assert.equal((await settle(s, event, '0.2', 'synthetic-uncertain')).success, true);
    const after = await balance(s.site);
    assert.equal((await rpc('bill_openrouter_generation', [s.site, 'synthetic-uncertain', '0.2', {}])).success, true);
    assert.deepEqual(await balance(s.site), after);
  });
  await check('actual cost above estimate takes additional credits or preserves known unpaid pending', async () => {
    const s = await seed('0', '0', '1'); const event = await reserved(s, '0.1'); await dispatch(s, event);
    assert.equal((await settle(s, event, '2', 'synthetic-shortfall')).state, 'pending');
    assert.equal((await one('SELECT provider_cost::text cost FROM harness_model_credit_reservations WHERE event_id=$1', [event])).cost, '2');
    assert.equal((await balance(s.site)).available, '0.9');
    assert.equal((await hold(s, randomUUID(), '0.1')).success, false);
    await rpc('grant_purchased_site_credits', [s.site, '3', randomUUID(), {}]);
    assert.equal((await settle(s, event, '2', 'synthetic-shortfall')).charged, 2.5);
    assert.equal((await balance(s.site)).available, '1.5');
    assert.equal((await balance(s.site)).used, '9.75');
    const after = await balance(s.site); await settle(s, event, '2', 'synthetic-shortfall');
    assert.deepEqual(await balance(s.site), after);
  });
  await check('expired prior-period plan hold never mints new or nonexpiring allowance', async () => {
    const s = await seed('2', '1', '1'); const event = await reserved(s, '3.5'); await dispatch(s, event);
    await db.query(`UPDATE billing SET plan_credit_period_start=plan_credit_period_start-interval '1 month',
      plan_credit_period_end=plan_credit_period_end-interval '1 month' WHERE site_id=$1`, [s.site]);
    // Advance receipt's recorded original period too, simulating an old invocation.
    await db.query(`UPDATE harness_model_credit_reservations SET period_start=period_start-interval '1 month',
      period_end=period_end-interval '1 month' WHERE event_id=$1`, [event]);
    await rpc('renew_site_plan_credits', [s.site]);
    const before = await balance(s.site);
    await settle(s, event, '0', 'synthetic-expired');
    const after = await balance(s.site);
    assert.equal(after.plan, before.plan); assert.equal(after.legacy, '1'); assert.equal(after.purchased, '1');
    assert.equal(after.monthly, before.monthly); assert.equal(after.plan_used, before.plan_used);
    assert.equal(after.used, '7.25'); await conserved(s.site);
    assert.equal((await one(`SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1 AND transaction_type='agent_model_refund_expired'`, [s.site])).n, 1);
  });
  await check('generic standalone harness reservations are site and lease fenced; service-only refunds', async () => {
    const s = await seed(); const event = randomUUID();
    assert.equal((await rpc('reserve_harness_model_credits', [s.session, randomUUID(), 'owner', event, '1'])).success, false);
    assert.equal((await rpc('reserve_harness_model_credits', [s.session, s.site, 'stale', event, '1'])).success, false);
    assert.equal((await rpc('reserve_harness_model_credits', [s.session, s.site, 'owner', event, '1'])).state, 'reserved');
    await dispatch(s, event); await cancel(s, event, 'admission_rejected');
    assert.equal((await balance(s.site)).available, '9');
    await db.exec('SET ROLE authenticated');
    await assert.rejects(() => hold(s, randomUUID(), '1'), /permission denied/);
    await assert.rejects(() => settle(s, event, '0'), /permission denied/);
    await assert.rejects(() => cancel(s, event), /permission denied/);
    await assert.rejects(() => db.query('SELECT * FROM harness_model_credit_reservations'), /permission denied/);
    await db.exec('RESET ROLE');
  });
  await check('global generation identity avoids cross-adapter and cross-reservation charges', async () => {
    const s = await seed();
    await rpc('bill_openrouter_generation', [s.site, 'synthetic-already-charged', '0.4', {}]);
    const before = await balance(s.site); const event = await reserved(s, '1'); await dispatch(s, event);
    await settle(s, event, '0.4', 'synthetic-already-charged');
    assert.deepEqual(await balance(s.site), before);
    const next = await reserved(s, '1'); await dispatch(s, next);
    await assert.rejects(() => settle(s, next, '0.4', 'synthetic-already-charged'));
    const held = await balance(s.site); await settle(s, next, '0', 'synthetic-next');
    assert.equal((await balance(s.site)).used, before.used);
    assert.notDeepEqual(held, before);
  });
  await check('audit insertion failure atomically rolls back bucket refund and global settlement', async () => {
    const s = await seed(); const event = await reserved(s, '1'); await dispatch(s, event);
    const held = await balance(s.site);
    await db.exec(`CREATE FUNCTION fixture_reject_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.transaction_type='agent_model_settlement' THEN RAISE EXCEPTION 'offline settlement failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_reject_settlement BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION fixture_reject_settlement();`);
    await assert.rejects(() => settle(s, event, '0.1', 'synthetic-rollback'), /offline settlement failure/);
    assert.deepEqual(await balance(s.site), held);
    assert.equal((await one('SELECT state FROM harness_model_credit_reservations WHERE event_id=$1', [event])).state, 'dispatched');
    assert.equal((await one(`SELECT count(*)::int n FROM openrouter_generation_charges WHERE event_id='synthetic-rollback'`)).n, 0);
    await db.exec('DROP TRIGGER fixture_reject_settlement ON credit_transactions');
    assert.equal((await settle(s, event, '0.1', 'synthetic-rollback')).success, true);
  });
  await check('invalid numerical cost cannot release or settle held money', async () => {
    const s = await seed(); const event = await reserved(s, '1'); await dispatch(s, event);
    const held = await balance(s.site);
    for (const cost of ['-1', 'NaN', 'Infinity', '-Infinity']) await assert.rejects(() => settle(s, event, cost));
    assert.deepEqual(await balance(s.site), held);
    await assert.rejects(() => hold(s, randomUUID(), 'NaN'));
  });
  console.log(`${checks} offline actual-cost PostgreSQL checks passed`);
} finally { await db.close(); }