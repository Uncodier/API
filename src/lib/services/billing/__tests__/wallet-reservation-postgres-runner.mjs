import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  walletReservationBootstrap, walletCoreMigration, walletReservationMigration,
} from './wallet-reservation-bootstrap.mjs';

// Memory-only PostgreSQL. No credentials, environment files, providers or network.
const db = new PGlite();
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(
  `SELECT public.${name}(${params.map((_, i) => `$${i + 1}`).join(',')}) result`, params,
)).result;
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
const balance = site => one('SELECT to_jsonb(b) value FROM public.billing b WHERE site_id=$1', [site]);
const seed = async ({ trial = '0', plan = '0', legacy = '0', purchased = '0', wallet = '1' } = {}) => {
  const site = randomUUID(), owner = randomUUID();
  await db.query("INSERT INTO sites(id,name,user_id) VALUES($1,'Synthetic wallet reservation',$2)", [site, owner]);
  await rpc('initialize_site_billing', [site]);
  if (Number(trial) > 0) {
    await db.query(`INSERT INTO site_startup_trials(primary_owner_id,site_id,started_at,ends_at)
      VALUES($1,$2,now()-interval '1 hour',now()+interval '359 hours')`, [owner, site]);
    await db.query(`UPDATE billing SET trial_started_at=t.started_at,trial_ends_at=t.ends_at,
      trial_credits_available=$2::numeric FROM site_startup_trials t
      WHERE billing.site_id=t.site_id AND billing.site_id=$1`, [site, trial]);
  }
  await db.query(`UPDATE billing SET plan_credits_available=$2::numeric,legacy_credits_available=$3::numeric,
    purchased_credits_available=$4::numeric,account_balance=$5::numeric,plan_credit_allowance=1,
    plan_credits_used=0,credits_used=0,monthly_credits_used=0,plan_credit_anchor=now()-interval '1 hour',
    plan_credit_period_start=now()-interval '1 hour',plan_credit_period_end=now()+interval '1 day'
    WHERE site_id=$1`, [site, plan, legacy, purchased, wallet]);
  return site;
};
const imageOperation = async site => ({ site, id: hash(), fingerprint: hash(), token: randomUUID() });
const modelOperation = async site => {
  const session = randomUUID(), id = randomUUID();
  await db.query(`INSERT INTO harness_sessions(id,site_id,lease_owner,lease_expires_at,snapshot)
    VALUES($1,$2,'owner',now()+interval '1 hour','{"status":"running"}')`, [session, site]);
  return { site, session, id };
};
const image = {
  name: 'image', table: 'image_generation_credit_reservations', key: 'operation_id', operation: imageOperation,
  hold: r => rpc('hold_image_generation_credits', [r.site, r.id, r.fingerprint, r.token, 4]),
  dispatch: r => rpc('dispatch_image_generation_reservation', [r.site, r.id, r.token]),
  settle: (r, count = 1, generation = null) => rpc('settle_image_generation_reservation', [r.site, r.id, r.token, count, generation, null]),
  cancel: (r, reason = 'not_dispatched') => rpc('release_image_generation_reservation', [r.site, r.id, r.token, reason]),
  holdType: 'image_generation_hold', refundType: 'image_generation_release', settlementType: 'image_generation_settlement',
};
const model = {
  name: 'model', table: 'harness_model_credit_reservations', key: 'event_id', operation: modelOperation,
  hold: r => rpc('reserve_harness_model_credits', [r.session, r.site, 'owner', r.id, '.4']),
  dispatch: r => rpc('dispatch_harness_model_reservation', [r.session, r.id]),
  settle: (r, count = 1, generation = null) => rpc('settle_harness_model_reservation', [r.session, r.id,
    ['0', '.08', '.16', '.24', '.32'][count], generation, null]),
  cancel: (r, reason = 'predispatch') => rpc('cancel_harness_model_reservation', [r.session, r.id, reason]),
  holdType: 'agent_model_reservation', refundType: 'agent_model_refund', settlementType: 'agent_model_settlement',
};
const receipt = (driver, r) => one(`SELECT to_jsonb(r) value FROM ${driver.table} r WHERE ${driver.key}=$1`, [r.id]);
const counts = async site => (await one('SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1', [site])).n;
const state = async (site, predicate) => assert.equal((await one(`SELECT ${predicate} ok FROM billing WHERE site_id=$1`, [site])).ok, true, predicate);
const conserved = site => state(site, `credits_available=trial_credits_available+plan_credits_available+legacy_credits_available+purchased_credits_available`);
const reservationAcls = async () => (await db.query(`SELECT oid::regprocedure::text name,proacl::text acl
  FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'hold_harness_model_credits','finish_harness_model_reservation','reserve_agent_requirement_credits',
    'reserve_harness_model_credits','dispatch_harness_model_reservation','settle_harness_model_reservation',
    'cancel_harness_model_reservation','hold_image_generation_credits','dispatch_image_generation_reservation',
    'finish_image_generation_reservation','settle_image_generation_reservation','release_image_generation_reservation',
    'mark_image_generation_reservation_pending') ORDER BY name`)).rows;
let checks = 0;
const check = async (name, test) => { await test(); checks++; console.log(`PASS ${name}`); };

try {
  await db.exec(walletReservationBootstrap);
  await db.exec("SET request.jwt.claim.role='service_role'");
  const originalAcls = await reservationAcls();
  const old = [];
  for (const driver of [image, model]) {
    const r = await driver.operation(await seed({ purchased: '.4', wallet: '3' }));
    assert.equal((await driver.hold(r)).success, true);
    old.push({ driver, r, balance: await balance(r.site), receipt: await receipt(driver, r), ledger: await counts(r.site) });
  }
  // Deliberately execute the current production core before this forward migration.
  await db.exec(walletCoreMigration);
  await db.exec(walletReservationMigration);
  await check('forward migration preserves old holds, financial state and zero wallet provenance', async () => {
    assert.deepEqual(await reservationAcls(), originalAcls);
    for (const entry of old) {
      const { driver, r } = entry;
      assert.deepEqual(await balance(r.site), entry.balance);
      assert.equal(await counts(r.site), entry.ledger);
      assert.deepEqual((await receipt(driver, r)).value, { ...entry.receipt.value, account_balance_spent: 0 });
      assert.equal((await driver.cancel(r)).success, true);
      await state(r.site, 'account_balance=3 AND purchased_credits_available=.4 AND credits_available=.4 AND credits_used=0');
    }
  });

  for (const driver of [image, model]) {
    await check(`${driver.name}: wallet-only hold and unused wallet refund never fabricate regular credits`, async () => {
      const r = await driver.operation(await seed({ wallet: '.4' }));
      assert.equal((await driver.hold(r)).success, true);
      await state(r.site, 'credits_available=0 AND account_balance=0 AND credits_used=.4 AND monthly_credits_used=.4 AND plan_credits_used=0');
      assert.equal((await receipt(driver, r)).value.account_balance_spent, .4);
      assert.equal((await one('SELECT metadata FROM credit_transactions WHERE site_id=$1 AND transaction_type=$2', [r.site, driver.holdType])).metadata.account_balance_spent, .4);
      await driver.dispatch(r);
      assert.equal((await driver.settle(r)).charged, .1);
      await state(r.site, 'credits_available=0 AND account_balance=.3 AND credits_used=.1 AND monthly_credits_used=.1 AND plan_credits_used=0');
      const refund = await one('SELECT amount::text amount,metadata FROM credit_transactions WHERE site_id=$1 AND transaction_type=$2', [r.site, driver.refundType]);
      assert.equal(Number(refund.amount), .3);
      assert.equal(refund.metadata.account_balance_spent, .4);
      assert.equal(refund.metadata.account_balance_restored, .3);
      const before = await balance(r.site), ledger = await counts(r.site);
      await driver.settle(r); await driver.hold(r);
      assert.deepEqual(await balance(r.site), before); assert.equal(await counts(r.site), ledger);
      await assert.rejects(driver.settle(r, 2), /identity conflict/);
      await assert.rejects(driver.cancel(r), /identity conflict/);
      await conserved(r.site);
    });
    await check(`${driver.name}: five-bucket order and reverse tail refund preserve source buckets`, async () => {
      const r = await driver.operation(await seed({ trial: '.03', plan: '.07', legacy: '.05', purchased: '.05', wallet: '.4' }));
      await driver.hold(r);
      const held = (await receipt(driver, r)).value;
      assert.deepEqual([held.trial_spent, held.plan_spent, held.legacy_spent, held.purchased_spent, held.account_balance_spent], [.03, .07, .05, .05, .2]);
      await state(r.site, 'credits_available=0 AND account_balance=.2 AND credits_used=.4 AND plan_credits_used=.07');
      await driver.dispatch(r); await driver.settle(r);
      await state(r.site, `trial_credits_available=0 AND plan_credits_available=0 AND legacy_credits_available=.05
        AND purchased_credits_available=.05 AND account_balance=.4 AND credits_available=.1
        AND credits_used=.1 AND monthly_credits_used=.1 AND plan_credits_used=.07`);
      await conserved(r.site);
    });
    await check(`${driver.name}: partial wallet charge refunds only the unused wallet tail`, async () => {
      const r = await driver.operation(await seed({ purchased: '.2', wallet: '.2' }));
      await driver.hold(r); await driver.dispatch(r); await driver.settle(r, 3);
      await state(r.site, 'purchased_credits_available=0 AND credits_available=0 AND account_balance=.1 AND credits_used=.3');
    });
    await check(`${driver.name}: exact mixed admission, insufficient combined balance and negative wallet offsets`, async () => {
      const enough = await driver.operation(await seed({ purchased: '.1', wallet: '.3' }));
      assert.equal((await driver.hold(enough)).success, true);
      await state(enough.site, 'credits_available=0 AND account_balance=0');
      const negative = await driver.operation(await seed({ purchased: '.5', wallet: '-.1' }));
      assert.equal((await driver.hold(negative)).success, true);
      await state(negative.site, 'credits_available=.1 AND account_balance=-.1 AND credits_used=.4');
      await driver.cancel(negative);
      await state(negative.site, 'credits_available=.5 AND account_balance=-.1 AND credits_used=0');
      for (const funds of [{ purchased: '.1', wallet: '.299999999999' }, { purchased: '.4', wallet: '-.01' }, { wallet: null }]) {
        const r = await driver.operation(await seed(funds)), before = await balance(r.site), ledger = await counts(r.site);
        const result = await driver.hold(r);
        assert.equal(result.success, false); assert.ok(result.available < .4);
        assert.deepEqual(await balance(r.site), before); assert.equal(await counts(r.site), ledger);
        assert.equal(await receipt(driver, r), undefined);
      }
      const nullable = await driver.operation(await seed({ purchased: '.4', wallet: null }));
      await driver.hold(nullable); await driver.cancel(nullable);
      await state(nullable.site, 'account_balance IS NULL AND credits_available=.4 AND credits_used=0');
    });
    await check(`${driver.name}: nonfinite wallet fails closed before hold and before refund`, async () => {
      for (const wallet of ['NaN', 'Infinity', '-Infinity']) {
        const r = await driver.operation(await seed({ purchased: '1', wallet })), before = await balance(r.site);
        assert.equal((await driver.hold(r)).success, false);
        assert.deepEqual(await balance(r.site), before); assert.equal(await receipt(driver, r), undefined);
      }
      for (const wallet of ['NaN', 'Infinity', '-Infinity']) {
        const r = await driver.operation(await seed()); await driver.hold(r);
        await db.query('UPDATE billing SET account_balance=$2::numeric WHERE site_id=$1', [r.site, wallet]);
        const before = await balance(r.site), held = await receipt(driver, r), ledger = await counts(r.site);
        await assert.rejects(driver.cancel(r), /Invalid billing credit balance/);
        assert.deepEqual(await balance(r.site), before); assert.deepEqual(await receipt(driver, r), held);
        assert.equal(await counts(r.site), ledger);
      }
    });
    await check(`${driver.name}: duplicate cancellation restores wallet once and never recreates dispatch authorization`, async () => {
      const r = await driver.operation(await seed({ purchased: '.1', wallet: '.3' }));
      await driver.hold(r); const held = await balance(r.site); await driver.hold(r);
      assert.deepEqual(await balance(r.site), held);
      await driver.cancel(r); const before = await balance(r.site), ledger = await counts(r.site);
      await driver.cancel(r); await driver.hold(r);
      assert.deepEqual(await balance(r.site), before); assert.equal(await counts(r.site), ledger);
      assert.equal((await driver.dispatch(r)).success, false);
      await state(r.site, 'credits_available=.1 AND account_balance=.3 AND credits_used=0 AND monthly_credits_used=0');
    });
    await check(`${driver.name}: expired or converted trials cannot be refunded as wallet or purchased credits`, async () => {
      for (const converted of [false, true]) {
        const r = await driver.operation(await seed({ trial: '.2', wallet: '.2' })); await driver.hold(r);
        if (converted) {
          await db.query('UPDATE site_startup_trials SET converted_at=clock_timestamp() WHERE site_id=$1', [r.site]);
          await db.query(`UPDATE billing SET trial_converted_at=t.converted_at FROM site_startup_trials t
            WHERE billing.site_id=t.site_id AND billing.site_id=$1`, [r.site]);
        } else {
          // Advance only this synthetic claim and receipt into the past, maintaining
          // the exact 360-hour trial identity. No sleeps or clock mocking required.
          await db.query(`UPDATE site_startup_trials SET started_at=started_at-interval '16 days',
            ends_at=ends_at-interval '16 days' WHERE site_id=$1`, [r.site]);
          await db.query(`UPDATE billing SET trial_started_at=t.started_at,trial_ends_at=t.ends_at
            FROM site_startup_trials t WHERE billing.site_id=t.site_id AND billing.site_id=$1`, [r.site]);
          await db.query(`UPDATE ${driver.table} SET trial_ends_at=trial_ends_at-interval '16 days'
            ${driver === image ? ",trial_started_at=trial_started_at-interval '16 days'" : ''} WHERE ${driver.key}=$1`, [r.id]);
        }
        await driver.cancel(r);
        await state(r.site, 'trial_credits_available=0 AND credits_available=0 AND account_balance=.2 AND purchased_credits_available=0 AND legacy_credits_available=0 AND credits_used=0');
        const refund = await one('SELECT metadata FROM credit_transactions WHERE site_id=$1 AND transaction_type=$2', [r.site, driver.refundType]);
        assert.equal(refund.metadata.account_balance_restored, .2);
      }
    });
    await check(`${driver.name}: old plan periods and downgrades limit plan restoration but never lose refundable wallet`, async () => {
      const oldPeriod = await driver.operation(await seed({ plan: '.2', wallet: '.2' }));
      await driver.hold(oldPeriod);
      await db.query(`UPDATE billing SET plan_credit_period_start=now(),plan_credit_period_end=now()+interval '2 days',
        plan_credits_available=.5,plan_credits_used=.5,monthly_credits_used=.5 WHERE site_id=$1`, [oldPeriod.site]);
      await driver.cancel(oldPeriod);
      await state(oldPeriod.site, 'plan_credits_available=.5 AND plan_credits_used=.5 AND monthly_credits_used=.5 AND credits_available=.5 AND account_balance=.2 AND credits_used=0');
      const downgraded = await driver.operation(await seed({ plan: '.2', wallet: '.2' })); await driver.hold(downgraded);
      await db.query('UPDATE billing SET plan_credit_allowance=.05 WHERE site_id=$1', [downgraded.site]);
      await driver.cancel(downgraded);
      await state(downgraded.site, 'plan_credits_available=.05 AND credits_available=.05 AND account_balance=.2 AND purchased_credits_available=0 AND plan_credits_used=0 AND credits_used=0');
    });
    await check(`${driver.name}: archived or inactive entitlements expire without swallowing wallet refunds`, async () => {
      for (const archived of [true, false]) {
        const r = await driver.operation(await seed({ trial: '.1', plan: '.1', wallet: '.2' })); await driver.hold(r);
        if (archived) await db.query('UPDATE sites SET archived_at=now() WHERE id=$1', [r.site]);
        else await db.query("UPDATE billing SET status='inactive' WHERE site_id=$1", [r.site]);
        await driver.cancel(r);
        await state(r.site, 'credits_available=0 AND account_balance=.2 AND trial_credits_available=0 AND plan_credits_available=0 AND credits_used=0');
      }
    });
    await check(`${driver.name}: lazy annual renewal remains monthly and spends renewed plan before wallet`, async () => {
      const r = await driver.operation(await seed({ wallet: '.4' }));
      await db.query("UPDATE billing SET stripe_subscription_id=$2,subscription_status='active' WHERE site_id=$1", [r.site, `sub_${randomUUID().replaceAll('-', '')}`]);
      await db.query(`UPDATE billing SET plan='engine',billing_interval='year',paid_subscription_period_start=now()-interval '45 days',
        paid_subscription_period_end=now()+interval '320 days',paid_subscription_invoice_id=$2,paid_subscription_paid_at=now()-interval '45 days',
        paid_subscription_plan='engine',paid_subscription_addons_count=0,plan_credit_anchor=now()-interval '45 days',
        plan_credit_period_start=now()-interval '45 days',plan_credit_period_end=now()-interval '15 days' WHERE site_id=$1`, [r.site, `in_${randomUUID().replaceAll('-', '')}`]);
      assert.equal((await driver.hold(r)).success, true);
      await state(r.site, `plan_credit_allowance=20 AND plan_credits_available=19.6 AND account_balance=.4
        AND plan_credit_period_end>now() AND plan_credit_period_end-plan_credit_period_start<interval '32 days'`);
      assert.equal((await receipt(driver, r)).value.account_balance_spent, 0);
    });
    await check(`${driver.name}: ledger failure rolls back debit, reservation, refund and evidence atomically`, async () => {
      const r = await driver.operation(await seed({ purchased: '.1', wallet: '.3' }));
      const reject = () => db.exec(`CREATE FUNCTION reject_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic wallet ledger failure'; END $$;
        CREATE TRIGGER reject_wallet_ledger BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger();`);
      const allow = () => db.exec('DROP TRIGGER reject_wallet_ledger ON credit_transactions; DROP FUNCTION reject_wallet_ledger();');
      let before = await balance(r.site), ledger = await counts(r.site);
      await reject(); await assert.rejects(driver.hold(r), /Synthetic wallet ledger failure/); await allow();
      assert.deepEqual(await balance(r.site), before); assert.equal(await counts(r.site), ledger);
      assert.equal(await receipt(driver, r), undefined);
      await driver.hold(r); await driver.dispatch(r); before = await balance(r.site); ledger = await counts(r.site);
      const held = await receipt(driver, r), generation = `gen_${randomUUID().replaceAll('-', '')}`;
      await reject(); await assert.rejects(driver.settle(r, 1, generation), /Synthetic wallet ledger failure/); await allow();
      assert.deepEqual(await balance(r.site), before); assert.equal(await counts(r.site), ledger);
      assert.deepEqual(await receipt(driver, r), held);
      assert.equal((await one('SELECT count(*)::int n FROM openrouter_generation_charges WHERE event_id=$1', [generation])).n, 0);
      assert.equal((await driver.settle(r, 1, generation)).success, true);
    });
    await check(`${driver.name}: reservation source columns enforce finite nonnegative amounts and exact sums`, async () => {
      const r = await driver.operation(await seed()); await driver.hold(r);
      const held = await receipt(driver, r);
      for (const column of ['trial_spent', 'plan_spent', 'legacy_spent', 'purchased_spent', 'account_balance_spent']) {
        for (const value of ['NaN', 'Infinity', '-Infinity', '-.1', '9', null]) {
          await assert.rejects(db.query(`UPDATE ${driver.table} SET ${column}=$2::numeric WHERE ${driver.key}=$1`, [r.id, value]), /check constraint|not-null constraint/);
        }
      }
      assert.deepEqual(await receipt(driver, r), held);
    });
    await check(`${driver.name}: expired included funds are removed before wallet-only admission`, async () => {
      const trial = await driver.operation(await seed({ trial: '.4', wallet: '.4' }));
      await db.query(`UPDATE site_startup_trials SET started_at=started_at-interval '16 days',
        ends_at=ends_at-interval '16 days' WHERE site_id=$1`, [trial.site]);
      await db.query(`UPDATE billing SET trial_started_at=t.started_at,trial_ends_at=t.ends_at
        FROM site_startup_trials t WHERE billing.site_id=t.site_id AND billing.site_id=$1`, [trial.site]);
      assert.equal((await driver.hold(trial)).success, true);
      assert.equal((await receipt(driver, trial)).value.account_balance_spent, .4);
      await state(trial.site, 'trial_credits_available=0 AND account_balance=0 AND credits_available=0');
      const plan = await driver.operation(await seed({ wallet: '.4' }));
      // New Stripe identities clear coverage, so configure dates in a second update.
      await db.query("UPDATE billing SET stripe_subscription_id=$2,subscription_status='active' WHERE site_id=$1", [plan.site, `sub_${randomUUID()}`]);
      await db.query(`UPDATE billing SET plan_credits_available=.4,plan_credit_period_start=now()-interval '2 days',
        plan_credit_period_end=now()-interval '1 day' WHERE site_id=$1`, [plan.site]);
      assert.equal((await driver.hold(plan)).success, true);
      assert.equal((await receipt(driver, plan)).value.account_balance_spent, .4);
      await state(plan.site, 'plan_credits_available=0 AND account_balance=0 AND credits_available=0');
    });
  }

  await check('image unknown outcome retains hold and rejects stale tokens, changed identity and unsafe release', async () => {
    const r = await image.operation(await seed({ wallet: '.4' })); await image.hold(r);
    assert.equal((await image.hold({ ...r, token: randomUUID() })).created, false);
    assert.equal((await image.hold({ ...r, fingerprint: hash() })).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await image.dispatch({ ...r, token: randomUUID() })).success, false);
    await assert.rejects(image.settle(r), /requires dispatch/);
    assert.equal((await image.dispatch(r)).success, true); assert.equal((await image.dispatch(r)).success, false);
    await rpc('mark_image_generation_reservation_pending', [r.site, r.id, r.token]);
    const before = await balance(r.site);
    await assert.rejects(image.cancel(r), /uncertain dispatch/);
    assert.equal((await image.hold(r)).state, 'pending');
    assert.equal((await image.hold(await image.operation(r.site))).code, 'INSUFFICIENT_CREDITS');
    assert.deepEqual(await balance(r.site), before);
    assert.equal((await image.settle(r)).charged, .1);
  });
  await check('model unknown outcome blocks repeats and unsafe refunds, then reconciles generation alias once', async () => {
    const r = await model.operation(await seed({ wallet: '.4' })); await model.hold(r);
    await assert.rejects(model.settle(r), /not dispatched/); await model.dispatch(r);
    const unknown = () => rpc('settle_harness_model_reservation', [r.session, r.id, null, null, null]);
    assert.equal((await unknown()).state, 'pending'); assert.equal((await unknown()).state, 'pending');
    await assert.rejects(model.cancel(r, 'admission_rejected'), /uncertain accepted/);
    const before = await balance(r.site);
    assert.equal((await model.hold({ ...r, id: randomUUID() })).success, false);
    assert.equal((await rpc('bill_openrouter_generation', [r.site, `harness:${r.id}`, '.08', {}])).success, false);
    assert.deepEqual(await balance(r.site), before);
    const generation = `gen_${randomUUID()}`;
    assert.equal((await model.settle(r, 1, generation)).charged, .1);
    assert.equal((await one('SELECT count(*)::int n FROM openrouter_generation_charges WHERE event_id=$1', [`harness:${r.id}`])).n, 0);
    const after = await balance(r.site), ledger = await counts(r.site);
    await model.settle(r, 1, generation);
    assert.equal((await rpc('bill_openrouter_generation', [r.site, generation, '.08', {}])).success, true);
    assert.deepEqual(await balance(r.site), after); assert.equal(await counts(r.site), ledger);
    await state(r.site, 'account_balance=.3 AND credits_available=0 AND credits_used=.1');
  });
  await check('model actual cost above hold stays pending without funds then latest core consumes wallet once', async () => {
    const r = await model.operation(await seed({ wallet: '.5' })); await model.hold(r); await model.dispatch(r);
    const generation = `gen_${randomUUID()}`;
    const settle = () => rpc('settle_harness_model_reservation', [r.session, r.id, '.8', generation, null]);
    assert.equal((await settle()).state, 'pending'); assert.equal((await settle()).state, 'pending');
    await state(r.site, 'account_balance=.1 AND credits_available=0 AND credits_used=.4');
    assert.equal((await receipt(model, r)).value.provider_cost, .8);
    assert.equal((await one('SELECT state FROM openrouter_generation_charges WHERE event_id=$1', [generation])).state, 'pending');
    await assert.rejects(model.cancel(r, 'admission_rejected'), /uncertain accepted/);
    assert.equal((await model.hold({ ...r, id: randomUUID() })).success, false);
    // Synthetic reconciliation funds; never re-run the generation to collect cost.
    await db.query('UPDATE billing SET account_balance=account_balance+.6 WHERE site_id=$1', [r.site]);
    assert.equal((await settle()).charged, 1);
    await state(r.site, 'account_balance=.1 AND credits_available=0 AND credits_used=1 AND monthly_credits_used=1');
    const extra = await one("SELECT amount::text amount,metadata FROM credit_transactions WHERE site_id=$1 AND transaction_type='agent_model_actual_cost'", [r.site]);
    assert.equal(Number(extra.amount), -.6); assert.equal(extra.metadata.account_balance_spent, .6);
    const before = await balance(r.site), ledger = await counts(r.site); await settle();
    assert.deepEqual(await balance(r.site), before); assert.equal(await counts(r.site), ledger);
  });
  await check('globally charged model generation releases entire wallet hold without charging twice', async () => {
    const r = await model.operation(await seed({ purchased: '.1', wallet: '.9' })); await model.hold(r); await model.dispatch(r);
    const generation = `gen_${randomUUID()}`;
    assert.equal((await rpc('bill_openrouter_generation', [r.site, generation, '.08', {}])).charged, .1);
    assert.equal((await model.settle(r, 1, generation)).charged, .1);
    await state(r.site, 'purchased_credits_available=.1 AND credits_available=.1 AND account_balance=.8 AND credits_used=.1');
    const refund = await one('SELECT metadata FROM credit_transactions WHERE site_id=$1 AND transaction_type=$2', [r.site, model.refundType]);
    assert.equal(refund.metadata.account_balance_restored, .3); assert.equal(refund.metadata.already_charged_globally, true);
    await assert.rejects(rpc('bill_openrouter_generation', [r.site, generation, '.16', {}]), /identity conflict/);
  });
  await check('model fractional holds retain exact wallet precision and zero cost refunds the original wallet', async () => {
    const r = await model.operation(await seed({ wallet: '.400000000000001' }));
    const hold = () => rpc('reserve_harness_model_credits', [r.session, r.site, 'owner', r.id, '.400000000000001']);
    assert.equal((await hold()).success, true); await model.dispatch(r);
    await state(r.site, 'account_balance=0 AND credits_used=.400000000000001 AND credits_available=0');
    assert.equal((await model.settle(r, 0)).charged, 0);
    await state(r.site, 'account_balance=.400000000000001 AND credits_used=0 AND credits_available=0');
    const before = await balance(r.site); await model.settle(r, 0); await hold();
    assert.deepEqual(await balance(r.site), before);
  });
  await check('public service RPCs remain lease fenced and private routines stay denied to service_role and browsers', async () => {
    const r = await model.operation(await seed()), i = await image.operation(await seed());
    assert.equal((await rpc('reserve_harness_model_credits', [r.session, r.site, 'stale', r.id, '.4'])).success, false);
    assert.equal((await rpc('reserve_harness_model_credits', [r.session, randomUUID(), 'owner', r.id, '.4'])).success, false);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await assert.rejects(rpc('hold_harness_model_credits', [r.session, r.site, r.id, '.4', null]), /permission denied/);
        await assert.rejects(rpc('finish_harness_model_reservation', [r.session, r.id, null, null, null, 'predispatch']), /permission denied/);
        await assert.rejects(rpc('finish_image_generation_reservation', [i.site, i.id, i.token, null, 'not_dispatched', null, null]), /permission denied/);
        await assert.rejects(db.query('SELECT * FROM harness_model_credit_reservations'), /permission denied/);
        await assert.rejects(db.query('UPDATE image_generation_credit_reservations SET account_balance_spent=0'), /permission denied/);
        if (role !== 'service_role') {
          await assert.rejects(model.hold(r), /permission denied/); await assert.rejects(image.hold(i), /permission denied/);
          await assert.rejects(model.cancel(r), /permission denied/); await assert.rejects(image.cancel(i), /permission denied/);
          await assert.rejects(model.settle(r), /permission denied/); await assert.rejects(image.settle(i), /permission denied/);
        } else {
          assert.equal((await model.hold(r)).success, true); assert.equal((await image.hold(i)).success, true);
          assert.equal((await model.cancel(r)).success, true); assert.equal((await image.cancel(i)).success, true);
          await db.query('SELECT * FROM image_generation_credit_reservations');
        }
      } finally { await db.exec('RESET ROLE'); }
    }
  });

  console.log(`passed ${checks} wallet reservation SQL checks`);
} finally { await db.close(); }