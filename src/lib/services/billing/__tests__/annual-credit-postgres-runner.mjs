import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Disposable in-memory PostgreSQL only: never load credentials or use a network.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, params) => (await one(
  `SELECT ${name}(${params.map((_, i) => `$${i+1}`).join(',')}) result`, params,
)).result;
const row = site => one('SELECT * FROM billing WHERE site_id=$1', [site]);
const id = prefix => `${prefix}_${randomUUID().replaceAll('-','')}`;
let dates; let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const site = async () => {
  const identity = { site_id: randomUUID(),customer_id: id('cus'),subscription_id: id('sub') };
  await db.query("INSERT INTO sites(id,name) VALUES($1,'Synthetic annual site')", [identity.site_id]);
  await rpc('initialize_site_billing', [identity.site_id]);
  await db.query(`UPDATE billing SET stripe_customer_id=$2,stripe_subscription_id=$3,
    subscription_status='active' WHERE site_id=$1`, Object.values(identity));
  await db.query(`UPDATE billing SET purchased_credits_available=40,legacy_credits_available=7,
    credits_available=plan_credits_available+47,account_balance=17.42 WHERE site_id=$1`, [identity.site_id]);
  return identity;
};
const invoice = (identity, overrides = {}) => {
  const payload = {
  ...identity,invoice_id:id('in'),status:'paid',amount:1069.20,currency:'USD',plan:'foundry',addons_count:2,
  billing_interval:'year',billing_reason:'subscription_create',current_subscription_status:'active',
  period_start:dates.start,period_end:dates.end,paid_at:dates.now,coverage_verified:true,...overrides,
  };
  return {current_service:{plan:payload.plan,
    addons_count:payload.addons_count,billing_interval:payload.billing_interval},...payload};
};
const settle = paid => rpc('settle_stripe_subscription_invoice', [paid]);
const sync = (identity, status, expected = identity.subscription_id, invoiceId = null) => rpc('sync_stripe_subscription_state',
  [identity.site_id,identity.customer_id,identity.subscription_id,expected,status,null,null,null,true,invoiceId]);
const renew = identity => rpc('renew_site_plan_credits', [identity.site_id]);
const spend = identity => rpc('deduct_credits', [identity.site_id,3,'usage','Synthetic annual usage',{}]);
const protectedBalances = b => {
  assert.equal(Number(b.purchased_credits_available),40);
  assert.equal(Number(b.legacy_credits_available),7);
  assert.equal(Number(b.account_balance),17.42);
};
try {
  await db.exec(readFileSync(resolve(here,'credit-fixture.sql'),'utf8'));
  for (const name of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql','20261003230002_classified_credit_operations.sql',
    '20261005230000_exact_credit_accounting_precision.sql','20261007003000_remove_signup_credit_bonus.sql',
    '20261007180000_annual_subscription_credit_periods.sql','20261007180001_subscription_checkout_leases.sql',
    '20261008210000_preserve_canceled_subscription_credit_usage.sql'])
    await db.exec(readFileSync(resolve(root,'supabase/migrations',name),'utf8'));
  dates = await one(`SELECT now()::text now,(now()-interval '5 days')::text start,
    (now()-interval '5 days'+interval '1 year')::text end,(now()+interval '25 days')::text month_end`);

  await check('annual paid invoice creates one monthly quota, not twelve quotas', async () => {
    const identity = await site(); const paid = invoice(identity);
    assert.equal((await settle(paid)).credits_granted,110);
    const b = await row(identity.site_id); protectedBalances(b);
    assert.equal(b.billing_interval,'year'); assert.equal(b.plan,'foundry');
    assert.equal(Number(b.plan_credits_available),110);
    assert.ok(new Date(b.plan_credit_period_end)-new Date(b.plan_credit_period_start) < 32*86400000);
    assert.equal(new Date(b.paid_subscription_period_end).getTime(),new Date(dates.end).getTime());
    await spend(identity);
    assert.equal((await settle(paid)).outcome,'duplicate');
    assert.equal((await renew(identity)).credits_granted,0);
    assert.equal(Number((await row(identity.site_id)).plan_credits_available),107);
  });
  await check('covered monthly reset skips missed months, preserves money and runs once', async () => {
    const identity = await site();
    const past = await one("SELECT (now()-interval '4 months 5 days')::text start,(now()+interval '7 months 25 days')::text end");
    await settle(invoice(identity,{period_start:past.start,period_end:past.end}));
    const current = await row(identity.site_id);
    await db.query(`UPDATE billing SET plan_credit_period_start=$2::timestamptz-interval '3 months',
      plan_credit_period_end=$2::timestamptz-interval '2 months',plan_credits_available=9,
      credits_available=56,plan_credits_used=101,monthly_credits_used=101 WHERE site_id=$1`,
    [identity.site_id,current.plan_credit_period_start]);
    assert.equal((await renew(identity)).credits_granted,110);
    const b = await row(identity.site_id); protectedBalances(b);
    assert.equal(Number(b.plan_credits_available),110); assert.equal(Number(b.plan_credits_used),0);
    assert.equal((await renew(identity)).credits_granted,0);
    assert.equal((await one("SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1 AND transaction_type='plan_credit_reset'",[identity.site_id])).n,2);
  });
  await check('lazy deduction renews covered credits before spending', async () => {
    const identity = await site(); await settle(invoice(identity));
    await db.query(`UPDATE billing SET plan_credit_period_start=now()-interval '2 months',
      plan_credit_period_end=now()-interval '1 month',plan_credits_available=0,credits_available=47 WHERE site_id=$1`,[identity.site_id]);
    assert.equal((await spend(identity)).success,true);
    const b = await row(identity.site_id); protectedBalances(b);
    assert.equal(Number(b.plan_credits_available),107);
  });
  await check('paid changes retain consumption across interval and tier changes', async () => {
    const identity = await site(); await settle(invoice(identity)); await spend(identity);
    const changed = invoice(identity,{billing_reason:'subscription_update',plan:'engine',addons_count:0});
    await settle(changed);
    let b = await row(identity.site_id); assert.equal(Number(b.plan_credits_available),17);
    assert.equal(Number(b.plan_credits_used),3);
    await settle(invoice(identity,{billing_reason:'subscription_update',addons_count:0}));
    b = await row(identity.site_id); assert.equal(Number(b.plan_credits_available),97);
    assert.equal(Number(b.plan_credits_used),3); protectedBalances(b);
    assert.equal((await renew(identity)).credits_granted,0);
  });
  await check('unverified prorations and failed invoices never activate paid coverage', async () => {
    for (const overrides of [{status:'failed',paid_at:null},
      {billing_reason:'subscription_update',coverage_verified:false}]) {
      const identity = await site(); await settle(invoice(identity,overrides));
      const b = await row(identity.site_id); protectedBalances(b);
      assert.equal(b.paid_subscription_invoice_id,null); assert.equal(b.plan,'commission');
    }
  });
  await check('live unpaid or paused status cannot establish or renew an annual allowance', async () => {
    for (const status of ['past_due','unpaid','paused','incomplete','trialing']) {
      const identity = await site();
      await sync(identity,status);
      assert.equal((await settle(invoice(identity,{current_subscription_status:status}))).credits_granted,0);
      const b = await row(identity.site_id);
      assert.equal(b.subscription_status,status); assert.equal(b.paid_subscription_invoice_id,null);
      assert.equal((await renew(identity)).credits_granted,0);
    }
  });
  await check('status sync precedes invoice coverage and an already settled invoice can recover', async () => {
    const identity = await site();
    await db.query('UPDATE billing SET subscription_status=NULL WHERE site_id=$1',[identity.site_id]);
    const paid = invoice(identity);
    assert.equal((await settle(paid)).credits_granted,0);
    assert.equal((await row(identity.site_id)).subscription_status,null);
    await sync(identity,'active');
    const retry = await settle(paid);
    assert.equal(retry.outcome,'duplicate'); assert.equal(retry.credits_granted,110);
    assert.equal((await row(identity.site_id)).subscription_status,'active');
  });
  await check('nonactive paid settlements recover verified entitlement once without a second payment', async () => {
    for (const reason of ['paused','past_due','unpaid','incomplete','trialing','inactive_site','archived_site']) {
      const identity = await site(); const paid = invoice(identity);
      if (reason === 'inactive_site') await db.query("UPDATE billing SET status='inactive' WHERE site_id=$1",[identity.site_id]);
      else if (reason === 'archived_site') await db.query('UPDATE sites SET archived_at=now() WHERE id=$1',[identity.site_id]);
      else await sync(identity,reason);
      const first = await settle({...paid,current_subscription_status:reason.endsWith('_site')?'active':reason});
      assert.equal(first.credits_granted,0);
      await db.query("UPDATE billing SET status='active' WHERE site_id=$1",[identity.site_id]);
      await db.query('UPDATE sites SET archived_at=NULL WHERE id=$1',[identity.site_id]);
      await sync(identity,'active');
      const retry = await settle(paid);
      assert.equal(retry.outcome,'duplicate'); assert.equal(retry.coverage_recovered,true);
      assert.equal(retry.payment_id,first.payment_id); assert.equal(retry.credits_granted,110);
      await spend(identity);
      assert.equal((await settle(paid)).credits_granted,0);
      assert.equal((await renew(identity)).credits_granted,0);
      const b = await row(identity.site_id); protectedBalances(b);
      assert.equal(b.paid_subscription_invoice_id,paid.invoice_id); assert.equal(b.billing_interval,'year');
      assert.equal(Number(b.plan_credits_available),107); assert.equal(Number(b.plan_credits_used),3);
      const audit = await one(`SELECT p.status,p.credits,p.details->>'credit_outcome' outcome,
        (SELECT count(*)::int FROM payments WHERE site_id=$1 AND payment_method='stripe') payments,
        (SELECT count(*)::int FROM stripe_subscription_invoice_settlements WHERE site_id=$1) settlements,
        (SELECT count(*)::int FROM credit_transactions WHERE site_id=$1 AND transaction_type='plan_credit_reset') resets
        FROM payments p WHERE transaction_id=$2`,[identity.site_id,'stripe_invoice_'+paid.invoice_id]);
      assert.deepEqual(audit,{status:'completed',credits:110,outcome:'reset',payments:1,settlements:1,resets:1});
    }
  });
  await check('settled recovery uses immutable verified coverage rather than retry supplied entitlement', async () => {
    const identity = await site(); const paid = invoice(identity);
    await sync(identity,'paused'); await settle({...paid,current_subscription_status:'paused'});
    await sync(identity,'active');
    const altered = {...paid,plan:'enterprise',addons_count:100,billing_interval:'month',billing_reason:'subscription_update',
      period_end:dates.month_end,coverage_verified:true};
    assert.equal((await settle(altered)).credits_granted,110);
    const b = await row(identity.site_id); protectedBalances(b);
    assert.equal(b.plan,'foundry'); assert.equal(b.addons_count,2); assert.equal(b.billing_interval,'year');
    assert.equal(new Date(b.paid_subscription_period_end).getTime(),Date.parse(dates.end));
  });
  await check('inactive paid updates recover only matching current service without poisoning immutable coverage', async () => {
    const identity = await site();
    const paid = invoice(identity,{billing_reason:'subscription_update',addons_count:0});
    await sync(identity,'paused');
    assert.equal((await settle({...paid,current_subscription_status:'paused'})).credits_granted,0);
    await sync(identity,'active');
    await db.query("UPDATE billing SET plan='engine',addons_count=0 WHERE site_id=$1",[identity.site_id]);
    const stored = await one('SELECT * FROM stripe_subscription_invoice_settlements WHERE invoice_id=$1',[paid.invoice_id]);
    const before = await row(identity.site_id);
    for (const overrides of [
      {coverage_verified:false,current_service:{plan:'engine',addons_count:0,billing_interval:'year'}},
      {current_service:{plan:'engine',addons_count:0,billing_interval:'year'}},
      {current_service:{plan:'enterprise',addons_count:0,billing_interval:'year'}},
      {current_service:{plan:'foundry',addons_count:1,billing_interval:'year'}},
      {current_service:{plan:'foundry',addons_count:0,billing_interval:'month'}},
      {current_service:null},{current_service:{}},
      {coverage_verified:false},
      // Tampering retry reason/entitlement cannot bypass the stored update gate.
      {billing_reason:'subscription_create',plan:'engine',addons_count:0,
        current_service:{plan:'engine',addons_count:0,billing_interval:'year'}},
    ]) {
      const retry = await settle({...paid,...overrides});
      assert.equal(retry.outcome,'duplicate'); assert.equal(retry.credits_granted,0);
      assert.equal(retry.credit_outcome,'current_service_mismatch'); assert.equal(retry.coverage_recovered,false);
      assert.deepEqual(await row(identity.site_id),before);
      assert.deepEqual(await one('SELECT * FROM stripe_subscription_invoice_settlements WHERE invoice_id=$1',[paid.invoice_id]),stored);
    }
    // Retry invoice fields are not current-service proof or replacement coverage.
    const recovery = await settle({...paid,plan:'enterprise',addons_count:100,billing_interval:'month',
      billing_reason:'subscription_create',period_end:dates.month_end});
    assert.equal(recovery.outcome,'duplicate'); assert.equal(recovery.coverage_recovered,true);
    assert.equal(recovery.credits_granted,100);
    const b = await row(identity.site_id); protectedBalances(b);
    assert.equal(b.plan,'foundry'); assert.equal(b.addons_count,0); assert.equal(b.billing_interval,'year');
    assert.equal(b.paid_subscription_invoice_id,paid.invoice_id);
    assert.equal(new Date(b.paid_subscription_period_end).getTime(),Date.parse(dates.end));
    await spend(identity); assert.equal((await settle(paid)).credits_granted,0);
    assert.equal(Number((await row(identity.site_id)).plan_credits_available),97);
  });
  await check('current-service mismatch on initial paid update stores immutable proof for later matched recovery', async () => {
    const identity = await site();
    const paid = invoice(identity,{billing_reason:'subscription_update',addons_count:0});
    const result = await settle({...paid,current_service:{plan:'engine',addons_count:0,billing_interval:'year'}});
    assert.equal(result.credits_granted,0);
    assert.equal((await row(identity.site_id)).paid_subscription_invoice_id,null);
    const marker = await one('SELECT * FROM stripe_subscription_invoice_settlements WHERE invoice_id=$1',[paid.invoice_id]);
    assert.equal(marker.credit_coverage_applied,false); assert.equal(marker.verified_credit_coverage.coverage_verified,true);
    assert.equal(marker.verified_credit_coverage.plan,'foundry');
    assert.equal((await settle(paid)).credits_granted,100);
  });
  await check('recovery coverage, ledger and financial audit roll back together on marker update failure', async () => {
    const identity = await site(); const paid = invoice(identity);
    await sync(identity,'paused'); await settle({...paid,current_subscription_status:'paused'});
    await sync(identity,'active'); const before = await row(identity.site_id);
    await db.exec(`CREATE FUNCTION reject_test_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic recovery failure'; END; $$;
      CREATE TRIGGER reject_test_recovery BEFORE UPDATE ON stripe_subscription_invoice_settlements
      FOR EACH ROW EXECUTE FUNCTION reject_test_recovery();`);
    await assert.rejects(() => settle(paid),/Synthetic recovery failure/);
    assert.deepEqual(await row(identity.site_id),before);
    assert.equal((await one("SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1 AND transaction_type='plan_credit_reset'",
      [identity.site_id])).n,0);
    assert.equal((await one('SELECT credits FROM payments WHERE transaction_id=$1',['stripe_invoice_'+paid.invoice_id])).credits,0);
    await db.exec('DROP TRIGGER reject_test_recovery ON stripe_subscription_invoice_settlements; DROP FUNCTION reject_test_recovery();');
    assert.equal((await settle(paid)).credits_granted,110);
    assert.equal((await settle(paid)).credits_granted,0);
  });
  await check('duplicate paid and failed snapshots never mutate subscription status or refill usage', async () => {
    const identity = await site(); const paid = invoice(identity); await settle(paid); await spend(identity);
    const before = await row(identity.site_id);
    for (const current_subscription_status of ['paused','past_due','canceled','active']) {
      assert.equal((await settle({...paid,current_subscription_status})).outcome,'duplicate');
      assert.equal((await settle({...paid,status:'failed',paid_at:null,current_subscription_status})).outcome,'ignored_failure');
      assert.deepEqual(await row(identity.site_id),before);
    }
    await sync(identity,'paused'); const paused = await row(identity.site_id);
    await settle(paid); assert.deepEqual(await row(identity.site_id),paused);
  });
  await check('invoice-aware sync suppresses applied retry status writes but not genuine lifecycle sync', async () => {
    const identity = await site(); const paid = invoice(identity); await settle(paid); await spend(identity);
    const before = await row(identity.site_id);
    for (const status of ['paused','past_due','canceled','active']) {
      const result = await sync(identity,status,identity.subscription_id,paid.invoice_id);
      assert.deepEqual(result,{outcome:'synced',subscription_id:identity.subscription_id,invoice_sync_skipped:true});
      assert.deepEqual(await row(identity.site_id),before);
    }
    assert.equal((await sync(identity,'paused')).outcome,'synced');
    const paused = await row(identity.site_id); assert.equal(paused.subscription_status,'paused');
    await sync(identity,'active',identity.subscription_id,paid.invoice_id);
    assert.deepEqual(await row(identity.site_id),paused);
    await sync(identity,'active'); assert.equal((await row(identity.site_id)).subscription_status,'active');
    const other = await site();
    await assert.rejects(() => sync(other,'paused',other.subscription_id,paid.invoice_id),/settlement identity mismatch/);
    await assert.rejects(() => sync(identity,'paused',identity.subscription_id,'invalid'),/Invalid verified Stripe subscription state/);
    assert.equal((await sync(identity,'paused',id('sub'),paid.invoice_id)).outcome,'obsolete_subscription');
    const recovering = await site(); const recoveryInvoice = invoice(recovering);
    await sync(recovering,'paused'); await settle({...recoveryInvoice,current_subscription_status:'paused'});
    const active = await sync(recovering,'active',recovering.subscription_id,recoveryInvoice.invoice_id);
    assert.equal(active.outcome,'synced'); assert.equal(active.invoice_sync_skipped,undefined);
    assert.equal((await settle(recoveryInvoice)).credits_granted,110);
  });
  await check('delayed active invoice snapshots cannot overwrite newly paused billing or recover it', async () => {
    const identity = await site(); const paid = invoice(identity); await sync(identity,'paused');
    assert.equal((await settle(paid)).credits_granted,0);
    assert.equal((await settle(paid)).credits_granted,0);
    const b = await row(identity.site_id); assert.equal(b.subscription_status,'paused');
    assert.equal(b.paid_subscription_invoice_id,null); protectedBalances(b);
  });
  await check('old settled recovery cannot replace newer coverage and expired recovery grants nothing', async () => {
    const identity = await site(); const paid = invoice(identity);
    await sync(identity,'paused'); await settle({...paid,current_subscription_status:'paused'});
    await sync(identity,'active');
    const newer = invoice(identity,{billing_reason:'subscription_update',plan:'enterprise'});
    await settle(newer); await spend(identity);
    const b = await row(identity.site_id);
    assert.equal((await settle(paid)).credits_granted,0); assert.deepEqual(await row(identity.site_id),b);
    const expiredSite = await site();
    const elapsed = await one("SELECT (now()-interval '1 year')::text start,(now()-interval '1 second')::text finish");
    const expired = invoice(expiredSite,{period_start:elapsed.start,period_end:elapsed.finish});
    await sync(expiredSite,'paused'); await settle({...expired,current_subscription_status:'paused'});
    await sync(expiredSite,'active');
    assert.equal((await settle(expired)).credits_granted,0);
    assert.equal((await row(expiredSite.site_id)).paid_subscription_invoice_id,null);
  });
  await check('a 100 percent coupon changes payment, not monthly entitlement', async () => {
    const identity = await site();
    assert.equal((await settle(invoice(identity,{amount:0}))).credits_granted,110);
    assert.equal((await row(identity.site_id)).paid_subscription_plan,'foundry');
  });
  await check('monthly to annual and back cannot repeatedly refill the current quota', async () => {
    const identity = await site();
    const monthly = await one("SELECT ($1::timestamptz+interval '1 month')::text end",[dates.start]);
    await settle(invoice(identity,{billing_interval:'month',period_end:monthly.end,addons_count:0}));
    await spend(identity);
    await settle(invoice(identity,{billing_reason:'subscription_update',addons_count:0}));
    assert.equal(Number((await row(identity.site_id)).plan_credits_available),97);
    await settle(invoice(identity,{billing_reason:'subscription_update',billing_interval:'month',period_end:monthly.end,addons_count:0}));
    const b = await row(identity.site_id); protectedBalances(b);
    assert.equal(b.billing_interval,'month'); assert.equal(Number(b.plan_credits_available),97);
    assert.equal(Number(b.monthly_credits_used),3); assert.equal(Number(b.plan_credits_used),3);
  });
  await check('an older paid update cannot replace a more recently paid tier', async () => {
    const identity = await site(); await settle(invoice(identity));
    await settle(invoice(identity,{billing_reason:'subscription_update',plan:'enterprise',paid_at:dates.now}));
    const previousPaidAt = await one("SELECT ($1::timestamptz-interval '1 day')::text at",[dates.now]);
    assert.equal((await settle(invoice(identity,{billing_reason:'subscription_update',plan:'engine',paid_at:previousPaidAt.at}))).credits_granted,0);
    assert.equal((await row(identity.site_id)).plan,'enterprise');
  });
  await check('fractional usage remains exact during paid changes, without integer payment casts', async () => {
    const identity = await site(); await settle(invoice(identity,{plan:'engine',addons_count:0}));
    await rpc('deduct_credits',[identity.site_id,0.502249,'usage','Synthetic fractional usage',{}]);
    const changed = await settle(invoice(identity,{billing_reason:'subscription_update',plan:'foundry',addons_count:0}));
    assert.equal(changed.credits_granted,0);
    const b = await row(identity.site_id); protectedBalances(b);
    assert.equal(Number(b.plan_credits_available),99.497751); assert.equal(Number(b.plan_credits_used),0.502249);
  });
  await check('expired coverage loses included credit, never purchased or withdrawable funds', async () => {
    const identity = await site(); await settle(invoice(identity));
    await db.query(`UPDATE billing SET paid_subscription_period_start=now()-interval '2 years',
      paid_subscription_period_end=now()-interval '1 year',plan_credit_period_start=now()-interval '2 months',
      plan_credit_period_end=now()-interval '1 month' WHERE site_id=$1`,[identity.site_id]);
    assert.equal((await renew(identity)).outcome,'stripe_managed');
    const b = await row(identity.site_id); protectedBalances(b); assert.equal(Number(b.plan_credits_available),0);
  });
  await check('scheduled cancellation retains monthly grants; terminal clears coverage exactly once', async () => {
    const identity = await site(); await settle(invoice(identity));
    await db.query(`UPDATE billing SET auto_renew=false,plan_credit_period_start=now()-interval '2 months',
      plan_credit_period_end=now()-interval '1 month' WHERE site_id=$1`,[identity.site_id]);
    assert.equal((await renew(identity)).credits_granted,110);
    await db.query("UPDATE billing SET subscription_status='canceled' WHERE site_id=$1",[identity.site_id]);
    let b = await row(identity.site_id); protectedBalances(b);
    assert.equal(b.paid_subscription_invoice_id,null); assert.equal(b.plan,'commission');
    assert.equal(Number(b.plan_credits_available),1);
    assert.equal((await renew(identity)).credits_granted,0);
    b = await row(identity.site_id); assert.equal(Number(b.plan_credits_available),1);
  });
  await check('replacing subscription identity cannot reuse the previous paid year', async () => {
    const identity = await site(); await settle(invoice(identity));
    await db.query('UPDATE billing SET stripe_subscription_id=$2 WHERE site_id=$1',[identity.site_id,id('sub')]);
    const b = await row(identity.site_id); assert.equal(b.paid_subscription_invoice_id,null);
    assert.equal(b.billing_interval,'month'); assert.equal((await renew(identity)).credits_granted,0);
  });
  await check('atomic obsolete cancellation and stale replacement CAS preserve new annual coverage', async () => {
    const identity = await site(); await settle(invoice(identity));
    await sync(identity,'canceled');
    const replacement = {...identity,subscription_id:id('sub')};
    assert.equal((await sync(replacement,'active',identity.subscription_id)).outcome,'synced');
    const paid = invoice(replacement); await settle(paid); await spend(replacement);
    const before = await row(identity.site_id);
    assert.equal((await sync(identity,'canceled',identity.subscription_id)).outcome,'obsolete_subscription');
    assert.equal((await sync(identity,'canceled',replacement.subscription_id)).outcome,'obsolete_subscription');
    assert.equal((await sync({...identity,subscription_id:id('sub')},'active',identity.subscription_id)).outcome,'obsolete_subscription');
    assert.equal((await sync(identity,'active',replacement.subscription_id)).outcome,'obsolete_subscription');
    await db.query("UPDATE billing SET stripe_subscription_id=$2,subscription_status='canceled' WHERE site_id=$1",
      [identity.site_id,identity.subscription_id]);
    assert.deepEqual(await row(identity.site_id),before);
    assert.equal((await settle(paid)).credits_granted,0); protectedBalances(before);
    await assert.rejects(() => sync({...replacement,customer_id:id('cus')},'active'),/identity mismatch/);
  });
  await check('retired unpaid IDs cannot rebind after replacement even through historical writers', async () => {
    const identity = await site(); await sync(identity,'canceled');
    const replacement = {...identity,subscription_id:id('sub')};
    await sync(replacement,'active',identity.subscription_id); await settle(invoice(replacement));
    const before = await row(identity.site_id);
    await db.query("UPDATE billing SET stripe_subscription_id=$2,subscription_status='canceled' WHERE site_id=$1",
      [identity.site_id,identity.subscription_id]);
    assert.deepEqual(await row(identity.site_id),before);
    for (const role of ['anon','authenticated'])
      assert.equal((await one("SELECT has_table_privilege($1,'site_retired_stripe_subscriptions','SELECT') ok",[role])).ok,false);
  });
  await check('cancel and subscription ID changes retain spent monthly anchors and cannot refill early', async () => {
    for (const cancel of [false,true]) {
      const identity = await site(); await settle(invoice(identity));
      await rpc('deduct_credits',[identity.site_id,110,'usage','Synthetic consume paid month',{}]);
      const before = await row(identity.site_id);
      const replacement = {...identity,subscription_id:id('sub')};
      if (cancel) {
        await sync(identity,'canceled');
        const terminal = await row(identity.site_id);
        assert.equal(terminal.paid_subscription_invoice_id,null);
        assert.equal(Number(terminal.plan_credits_used),110);
        assert.equal((await sync(replacement,'active',identity.subscription_id)).outcome,'synced');
      } else {
        // Even historical ID writers must not reset the stable paid usage clock.
        await db.query('UPDATE billing SET stripe_subscription_id=$2 WHERE site_id=$1',
          [identity.site_id,replacement.subscription_id]);
      }
      const moved = await one("SELECT (now()-interval '1 day')::text start,(now()-interval '1 day'+interval '1 year')::text finish");
      assert.equal((await settle(invoice(replacement,{period_start:moved.start,period_end:moved.finish}))).credits_granted,0);
      const b = await row(identity.site_id); protectedBalances(b);
      assert.equal(Number(b.plan_credits_available),0); assert.equal(Number(b.plan_credits_used),110);
      assert.equal(new Date(b.plan_credit_anchor).getTime(),new Date(before.plan_credit_anchor).getTime());
      assert.equal(new Date(b.plan_credit_period_start).getTime(),new Date(before.plan_credit_period_start).getTime());
      assert.equal(new Date(b.plan_credit_period_end).getTime(),new Date(before.plan_credit_period_end).getTime());
      assert.equal((await renew(replacement)).credits_granted,0);
    }
  });
  await check('terminal renewal and lazy deduction cannot erase an unfinished paid month before replacement', async () => {
    const priorMonth = await one(`SELECT (now()-interval '1 month'+interval '1 day')::text start,
      (now()-interval '1 month'+interval '1 day'+interval '1 year')::text finish`);
    for (const status of ['canceled','cancelled','incomplete_expired']) for (const lazy of [false,true]) {
      const identity = await site();
      const paid = invoice(identity,{addons_count:0,period_start:priorMonth.start,period_end:priorMonth.finish});
      await settle(paid);
      await rpc('deduct_credits',[identity.site_id,100,'usage','Synthetic spent annual window',{}]);
      const before = await row(identity.site_id);
      assert.equal(Number(before.plan_credits_used),100);
      assert.ok(before.plan_credit_period_end > new Date());
      await sync(identity,status);
      const terminal = await row(identity.site_id);
      assert.equal(terminal.paid_subscription_invoice_id,null);
      assert.equal(Number(terminal.plan_credits_used),100);
      assert.equal(Number(terminal.plan_credits_available),1);
      if (lazy) {
        const deduction = await rpc('deduct_credits',[identity.site_id,1,'usage','Synthetic Toolbox spend',{}]);
        assert.equal(deduction.success,true);
      } else assert.equal((await renew(identity)).outcome,'not_due');
      const interim = await row(identity.site_id);
      assert.equal(Number(interim.plan_credits_used),100+(lazy ? 1 : 0));
      assert.equal(new Date(interim.plan_credit_period_end).getTime(),new Date(before.plan_credit_period_end).getTime());
      const replacement = {...identity,subscription_id:id('sub')};
      assert.equal((await sync(replacement,'active',identity.subscription_id)).outcome,'synced');
      const result = await settle(invoice(replacement,{addons_count:0,period_start:priorMonth.start,period_end:priorMonth.finish}));
      assert.equal(result.credits_granted,0);
      const after = await row(identity.site_id);
      assert.equal(Number(after.plan_credits_available),0);
      assert.equal(Number(after.plan_credits_used),100+(lazy ? 1 : 0));
      assert.equal(new Date(after.plan_credit_period_end).getTime(),new Date(before.plan_credit_period_end).getTime());
      protectedBalances(after);
    }
  });
  await check('terminal Toolbox renewal begins at the expired paid boundary and ends with the UTC month', async () => {
    const identity = await site();
    await settle(invoice(identity,{addons_count:0}));
    // Advance a verified credit window in this disposable DB without waiting
    // for the wall clock. Coverage remains independently paid and immutable.
    await db.query(`UPDATE billing SET plan_credit_period_start=now()-interval '1 month'-interval '1 day',
      plan_credit_period_end=now()-interval '1 day' WHERE site_id=$1`,[identity.site_id]);
    const before = await row(identity.site_id);
    await sync(identity,'canceled');
    const result = await renew(identity);
    assert.equal(result.outcome,'reset');
    const after = await row(identity.site_id);
    const calendarEnd = await one("SELECT ((date_trunc('month',now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')::text finish");
    assert.equal(new Date(after.plan_credit_period_start).getTime(),new Date(before.plan_credit_period_end).getTime());
    assert.equal(new Date(after.plan_credit_period_end).getTime(),new Date(calendarEnd.finish).getTime());
    assert.equal(Number(after.plan_credits_available),1);
    assert.equal((await renew(identity)).outcome,'not_due');
    protectedBalances(after);
  });
  await check('UTC anniversary windows clamp from original anchor and handle leap years', async () => {
    for (const [start,at,expectedStart,expectedEnd] of [
      ['2030-01-31T10:00:00Z','2030-02-28T11:00:00Z','2030-02-28T10:00:00Z','2030-03-31T10:00:00Z'],
      ['2030-01-31T10:00:00Z','2030-03-30T11:00:00Z','2030-02-28T10:00:00Z','2030-03-31T10:00:00Z'],
      ['2032-01-31T10:00:00Z','2032-02-29T10:00:00Z','2032-02-29T10:00:00Z','2032-03-31T10:00:00Z'],
    ]) {
      const w = await one("SELECT * FROM subscription_monthly_credit_window($1,$1::timestamptz+interval '1 year',$2)",[start,at]);
      assert.equal(new Date(w.period_start).getTime(),Date.parse(expectedStart));
      assert.equal(new Date(w.period_end).getTime(),Date.parse(expectedEnd));
    }
  });
  await check('malformed and forged coverage is rejected and browser ACLs deny mutation', async () => {
    const identity = await site();
    await assert.rejects(() => settle(invoice(identity,{billing_interval:'week'})),/Invalid verified Stripe invoice/);
    await assert.rejects(() => settle(invoice(identity,{customer_id:id('cus')})),/identity mismatch/);
    for (const fn of ['apply_paid_subscription_credit_coverage(jsonb)',
      'subscription_monthly_credit_window(timestamptz,timestamptz,timestamptz)',
      'sync_stripe_subscription_state(uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,boolean,text)'])
      for (const role of ['anon','authenticated'])
        assert.equal((await one("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[role,fn])).ok,false);
    const owner = randomUUID(); await db.query('UPDATE sites SET user_id=$2 WHERE id=$1',[identity.site_id,owner]);
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[owner]);
    await assert.rejects(() => db.query("UPDATE billing SET billing_interval='year' WHERE site_id=$1",[identity.site_id]),/server managed/);
    await db.query("SELECT set_config('request.jwt.claim.role','',false),set_config('request.jwt.claim.sub','',false)");
  });
  await check('checkout lease serializes selections, fences stale tokens and recovers expiry', async () => {
    const identity = await site(); const claimed = await rpc('claim_site_subscription_checkout',[identity.site_id]);
    assert.equal(claimed.state,'claimed');
    assert.equal((await rpc('claim_site_subscription_checkout',[identity.site_id])).state,'busy');
    assert.equal(await rpc('finish_site_subscription_checkout',[identity.site_id,randomUUID()]),false);
    await db.query("UPDATE site_subscription_checkout_leases SET lease_until=now()-interval '1 second' WHERE site_id=$1",[identity.site_id]);
    const replacement = await rpc('claim_site_subscription_checkout',[identity.site_id]);
    assert.equal(replacement.state,'claimed'); assert.notEqual(replacement.token,claimed.token);
    assert.equal(await rpc('finish_site_subscription_checkout',[identity.site_id,claimed.token]),false);
    assert.equal(await rpc('finish_site_subscription_checkout',[identity.site_id,replacement.token]),true);
    for (const role of ['anon','authenticated']) {
      assert.equal((await one("SELECT has_table_privilege($1,'site_subscription_checkout_leases','SELECT') ok",[role])).ok,false);
      assert.equal((await one("SELECT has_function_privilege($1,'claim_site_subscription_checkout(uuid)','EXECUTE') ok",[role])).ok,false);
    }
  });
  console.log(`${checks} annual credit checks passed`);
} finally { await db.close(); }