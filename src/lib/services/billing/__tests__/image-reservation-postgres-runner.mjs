import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { imageBootstrap, imageMigration } from './image-reservation-bootstrap.mjs';
const db=new PGlite();
const one=async(s,p=[])=>(await db.query(s,p)).rows[0];
const rpc=async(n,p)=>(await one(`SELECT public.${n}(${p.map((_,i)=>'$'+(i+1)).join(',')}) r`,p)).r;
const hash=()=>createHash('sha256').update(randomUUID()).digest('hex');
const operation=site=>({site,op:hash(),fingerprint:hash(),token:randomUUID()});
const hold=(r,n=4)=>rpc('hold_image_generation_credits',[r.site,r.op,r.fingerprint,r.token,n]);
const dispatch=r=>rpc('dispatch_image_generation_reservation',[r.site,r.op,r.token]);
const settle=(r,n,id=null)=>rpc('settle_image_generation_reservation',[r.site,r.op,r.token,n,id,null]);
const release=(r,why='confirmed_admission_rejection')=>rpc('release_image_generation_reservation',[r.site,r.op,r.token,why]);
const seed=async(t='0',p='0',l='0',b='1',expiry=false)=>{
  const site=randomUUID(),owner=randomUUID();
  await db.query("INSERT INTO sites(id,name,user_id) VALUES($1,'Synthetic image', $2)",[site,owner]);
  await rpc('initialize_site_billing',[site]);
  if(Number(t)>0){
    await db.query(`INSERT INTO site_startup_trials VALUES($1,$2,clock_timestamp()-interval '${expiry?'361 hours':'1 hour'}',
      clock_timestamp()+interval '${expiry?'-1 hour':'359 hours'}',NULL)`,[owner,site]);
    // use one exact timestamp pair (clock_timestamp calls differ by microseconds)
    await db.query("UPDATE site_startup_trials SET ends_at=started_at+interval '360 hours' WHERE site_id=$1",[site]);
    await db.query(`UPDATE billing SET trial_started_at=t.started_at,trial_ends_at=t.ends_at,trial_credits_available=$2::numeric
      FROM site_startup_trials t WHERE billing.site_id=t.site_id AND billing.site_id=$1`,[site,t]);
  }
  await db.query(`UPDATE billing SET plan_credits_available=$2::numeric,legacy_credits_available=$3::numeric,purchased_credits_available=$4::numeric,
    plan_credit_allowance=1,plan_credits_used=0,credits_used=0,monthly_credits_used=0,
    plan_credit_anchor=now()-interval '1 hour',plan_credit_period_start=now()-interval '1 hour',plan_credit_period_end=now()+interval '1 day'
    WHERE site_id=$1`,[site,p,l,b]);
  return site;
};
let checks=0;
const check=async(n,fn)=>{await fn();checks++;console.log('PASS '+n);};
try {
  await db.exec(imageBootstrap);
  await db.exec(imageMigration);
  await db.exec("SET request.jwt.claim.role='service_role'");
  await check('four source buckets are reserved atomically and unused tail restores original buckets',async()=>{
    const site=await seed('0.05','0.05','0.1','1'),r=operation(site);
    assert.equal((await hold(r)).created,true); await dispatch(r);
    assert.equal((await one('SELECT trial_spent=.05 AND plan_spent=.05 AND legacy_spent=.1 AND purchased_spent=.2 ok FROM image_generation_credit_reservations WHERE site_id=$1',[site])).ok,true);
    assert.equal((await settle(r,1)).charged,.1);
    assert.equal((await one('SELECT trial_credits_available=0 AND plan_credits_available=0 AND legacy_credits_available=.1 AND purchased_credits_available=1 AND credits_used=.1 ok FROM billing WHERE site_id=$1',[site])).ok,true);
    await settle(r,1); assert.equal((await one("SELECT count(*)::int n FROM credit_transactions WHERE site_id=$1 AND transaction_type='image_generation_settlement'",[site])).n,1);
    await assert.rejects(settle(r,2),/identity conflict/);
  });
  await check('duplicates pending and completed cannot acquire another dispatch authorization',async()=>{
    const r=operation(await seed()); await hold(r); assert.equal((await hold({...r,token:randomUUID()})).created,false);
    assert.equal((await hold({...r,fingerprint:hash()})).code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await dispatch({...r,token:randomUUID()})).success,false);
    assert.equal((await dispatch(r)).success,true); assert.equal((await dispatch(r)).success,false);
    await rpc('mark_image_generation_reservation_pending',[r.site,r.op,r.token]);
    assert.equal((await hold(r)).state,'pending');
    await assert.rejects(release(r,'not_dispatched'),/uncertain dispatch/);
    await settle(r,1); assert.equal((await hold(r)).state,'settled');
  });
  await check('confirmed rejection restores trial plan legacy purchased once, never fabricated purchases',async()=>{
    const r=operation(await seed('.1','.1','.1','.1')); await hold(r); await dispatch(r); await release(r); await release(r);
    assert.equal((await one('SELECT trial_credits_available=.1 AND plan_credits_available=.1 AND legacy_credits_available=.1 AND purchased_credits_available=.1 AND credits_used=0 ok FROM billing WHERE site_id=$1',[r.site])).ok,true);
    await assert.rejects(settle(r,1),/identity conflict/);
  });
  await check('expired trial and revoked trial refunds never become purchased or legacy credit',async()=>{
    const r=operation(await seed('.4','0','0','0')); await hold(r);
    await db.query("UPDATE site_startup_trials SET converted_at=clock_timestamp() WHERE site_id=$1",[r.site]);
    await db.query('UPDATE billing SET trial_converted_at=t.converted_at FROM site_startup_trials t WHERE billing.site_id=t.site_id AND billing.site_id=$1',[r.site]);
    await release(r,'not_dispatched');
    assert.equal((await one('SELECT credits_available=0 AND purchased_credits_available=0 AND legacy_credits_available=0 AND credits_used=0 ok FROM billing WHERE site_id=$1',[r.site])).ok,true);
    const expired=await seed('.4','0','0','0',true);
    assert.equal((await hold(operation(expired))).code,'INSUFFICIENT_CREDITS');
  });
  await check('new monthly period never receives prior plan refunds or loses current usage',async()=>{
    const r=operation(await seed('0','.4','0','0')); await hold(r); await dispatch(r);
    await db.query("UPDATE billing SET plan_credit_period_start=now(),plan_credit_period_end=now()+interval '1 day',plan_credits_available=.5,plan_credits_used=.5,monthly_credits_used=.5 WHERE site_id=$1",[r.site]);
    await release(r);
    assert.equal((await one('SELECT plan_credits_available=.5 AND plan_credits_used=.5 AND monthly_credits_used=.5 AND purchased_credits_available=0 ok FROM billing WHERE site_id=$1',[r.site])).ok,true);
  });
  await check('downgrade restores only remaining entitled plan quota',async()=>{
    const r=operation(await seed('0','.4','0','0')); await hold(r); await dispatch(r);
    await db.query('UPDATE billing SET plan_credit_allowance=.1 WHERE site_id=$1',[r.site]); await release(r);
    assert.equal((await one('SELECT plan_credits_available=.1 AND purchased_credits_available=0 ok FROM billing WHERE site_id=$1',[r.site])).ok,true);
  });
  await check('annual lazy renewal reserves current monthly coverage not twelve-month quota',async()=>{
    const site=await seed('0','0','0','0'), r=operation(site);
    await db.query(`UPDATE billing SET stripe_subscription_id=$2,subscription_status='active' WHERE site_id=$1`,[site,'sub_'+randomUUID().replaceAll('-','')]);
    await db.query(`UPDATE billing SET plan='engine',billing_interval='year',paid_subscription_period_start=now()-interval '45 days',
      paid_subscription_period_end=now()+interval '320 days',paid_subscription_invoice_id=$2,paid_subscription_paid_at=now()-interval '45 days',
      paid_subscription_plan='engine',paid_subscription_addons_count=0,plan_credit_anchor=now()-interval '45 days',
      plan_credit_period_start=now()-interval '45 days',plan_credit_period_end=now()-interval '15 days' WHERE site_id=$1`,[site,'in_'+randomUUID().replaceAll('-','')]);
    assert.equal((await hold(r)).success,true);
    assert.equal((await one("SELECT plan_credit_allowance=20 AND plan_credits_available=19.6 AND plan_credit_period_end>now() AND plan_credit_period_end-plan_credit_period_start<interval '32 days' ok FROM billing WHERE site_id=$1",[site])).ok,true);
  });
  await check('affordability blocks a second distinct operation on held funds',async()=>{
    const site=await seed('0','0','0','.4'); await hold(operation(site));
    assert.equal((await hold(operation(site),1)).code,'INSUFFICIENT_CREDITS');
  });
  await check('ledger insertion failure rolls back every hold bucket and reservation',async()=>{
    const r=operation(await seed());
    const before=await one('SELECT to_jsonb(b) b FROM billing b WHERE site_id=$1',[r.site]);
    await db.exec("CREATE FUNCTION reject_image_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic ledger failure'; END $$; CREATE TRIGGER reject_image_ledger BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION reject_image_ledger();");
    await assert.rejects(hold(r),/Synthetic ledger failure/);
    assert.deepEqual(await one('SELECT to_jsonb(b) b FROM billing b WHERE site_id=$1',[r.site]),before);
    await db.exec('DROP TRIGGER reject_image_ledger ON credit_transactions');
  });
  await check('malformed counts and browser RPC access are denied',async()=>{
    const r=operation(await seed()); for(const n of [0,5,null])await assert.rejects(hold(r,n),/Invalid image reservation/);
    await db.exec('SET ROLE authenticated'); await assert.rejects(hold(r),/permission denied/); await db.exec('RESET ROLE');
  });
  console.log(`passed ${checks} image SQL checks`);
} finally { await db.close(); }