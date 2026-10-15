import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Disposable in-memory PostgreSQL only: no environment, network or credentials.
const db = new PGlite();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const migration = name => db.exec(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8'));
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const rpc = async (name, args) => (await one(`select ${name}(${args.map((_, i) => `$${i+1}`).join(',')}) result`, args)).result;
const site = randomUUID(), other = randomUUID(), owner = randomUUID(), nextOwner = randomUUID(), req = randomUUID();
const sandbox = `h-${owner}`;
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const close = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 1e-12, `${actual} != ${expected}`);
try {
  await db.exec(readFileSync(resolve(here, 'credit-fixture.sql'), 'utf8'));
  await db.exec('CREATE TABLE harness_sessions(id uuid PRIMARY KEY,site_id uuid,snapshot jsonb); CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid); CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid);');
  await db.query('INSERT INTO sites(id) VALUES($1),($2)', [site,other]);
  await db.query("INSERT INTO billing(site_id,credits_available) VALUES($1,100),($2,100)", [site,other]);
  await db.query("INSERT INTO harness_sessions VALUES($1,$2,'{}'),($3,$2,'{}')", [owner,site,nextOwner]);
  await db.query('INSERT INTO requirements VALUES($1,$2)', [req,site]);
  await migration('20261003230000_credit_buckets_and_monthly_reset.sql');
  await migration('20261003230002_classified_credit_operations.sql');
  await migration('20261005230000_exact_credit_accounting_precision.sql');
  await migration('20261014230002_sandbox_session_billing.sql');
  await check('registration trusts persisted owner, rejects forged sites and name collision', async () => {
    await assert.rejects(() => rpc('register_sandbox_billing',[sandbox,'harness',owner,other]), /ownership mismatch/);
    await assert.rejects(() => rpc('register_sandbox_billing',[sandbox,'harness',randomUUID(),site]), /ownership mismatch/);
    const r = await rpc('register_sandbox_billing',[sandbox,'harness',owner,site]);
    assert.equal(r.site_id,site);
    await assert.rejects(() => rpc('register_sandbox_billing',[sandbox,'harness',nextOwner,site]), /owner identity conflict/);
    assert.equal((await rpc('register_sandbox_billing',[sandbox,'harness',owner,site])).registered_at,r.registered_at);
  });
  // Move only fixture registration floor into the past to simulate hours offline.
  const floor = Date.now()-5*3600000, iso = ms => new Date(ms).toISOString();
  await db.query('UPDATE sandbox_billing_resources SET registered_at=$1 WHERE sandbox_name=$2',[iso(floor),sandbox]);
  const session = (id,start,end) => ({ id,started_at:iso(start),ended_at:end === null ? null : iso(end) });
  const first = session(randomUUID(),floor-3600000,floor+3600000);
  const bill = (sessions, at=floor+4*3600000) => rpc('bill_sandbox_sessions',[sandbox,sessions,iso(at)]);
  await check('no retroactive time, fixed half credit/hour, duplicate requests charged once', async () => {
    close((await bill([first])).credits_charged,0.5);
    close((await bill([first])).credits_charged,0);
    close((await one('select credits_available from billing where site_id=$1',[site])).credits_available,99.5);
    assert.equal((await one("select count(*)::int n from credit_transactions where transaction_type='sandbox_usage'",[])).n,1);
  });
  await check('VM resume session excludes stopped gap and out-of-order observations', async () => {
    const resumed = session(randomUUID(),floor+3*3600000,floor+4*3600000);
    close((await bill([resumed,first])).credits_charged,0.5);
    close((await bill([resumed],floor+3.5*3600000)).credits_charged,0);
    close((await one('select credits_used from billing where site_id=$1',[site])).credits_used,1);
  });
  await check('running ticks use cumulative target, exactly cadence independent', async () => {
    const ticking = session(randomUUID(),floor+4*3600000,null);
    for (let i=1;i<=7;i++) await bill([ticking],floor+4*3600000+i*1000);
    const stored = await one('select credits_charged::text amount from sandbox_billing_sessions where session_id=$1',[ticking.id]);
    const target = await one("select (7::numeric*0.5/3600)::text amount");
    assert.equal(stored.amount,target.amount);
    close((await bill([ticking],floor+4*3600000+7000)).credits_charged,0);
  });
  await check('insufficient credits leaves all intervals retryable, no partial ledger or watermark', async () => {
    await db.query('UPDATE billing SET legacy_credits_available=0,plan_credits_available=0,purchased_credits_available=0,credits_available=0 WHERE site_id=$1',[site]);
    const unpaid = session(randomUUID(),floor+3600000,floor+2*3600000);
    const before = await one('select count(*)::int n from credit_transactions');
    await assert.rejects(() => bill([unpaid]),/requires available credits/);
    assert.equal((await one('select count(*)::int n from credit_transactions')).n,before.n);
    assert.equal((await one('select count(*)::int n from sandbox_billing_sessions where session_id=$1',[unpaid.id])).n,0);
    await rpc('add_credits',[site,1,'credit_restore','Synthetic replenishment',{}]);
    close((await bill([unpaid])).credits_charged,0.5);
    close((await bill([unpaid])).credits_charged,0);
  });
  await check('global session identity rejects duplicate attribution and future/malformed intervals', async () => {
    await rpc('register_sandbox_billing',['another','harness',nextOwner,site]);
    await db.query('UPDATE sandbox_billing_resources SET registered_at=$1 WHERE sandbox_name=$2',[iso(floor),'another']);
    await assert.rejects(() => rpc('bill_sandbox_sessions',['another',[first],iso(floor+4*3600000)]),/identity conflict/);
    await assert.rejects(() => bill([{...first,started_at:iso(floor-3600000-1)}]),/identity conflict/);
    await assert.rejects(() => rpc('bill_sandbox_sessions',[sandbox,[first],iso(Date.now()+60000)]),/Invalid sandbox session observation/);
    await assert.rejects(() => bill([{...first,ended_at:iso(floor-2*3600000)}]),/Invalid VM session interval/);
  });
  await check('requirement occurrences preserve one owner and baseline', async () => {
    await db.query("UPDATE harness_sessions SET snapshot=jsonb_build_object('request',jsonb_build_object('requirementId',$1::text)) WHERE id in ($2,$3)",[req,owner,nextOwner]);
    const r=await rpc('register_sandbox_billing',['requirement-vm','harness',owner,site]);
    assert.equal((await rpc('register_sandbox_billing',['requirement-vm','harness',nextOwner,site])).registered_at,r.registered_at);
  });
  await check('RLS and RPC execution are service-only', async () => {
    for (const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(() => bill([first]),/permission denied/);
      await assert.rejects(() => rpc('register_sandbox_billing',[sandbox,'harness',owner,site]),/permission denied/);
      await assert.rejects(() => db.query('select * from sandbox_billing_sessions'),/permission denied/);
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    await db.query('select * from sandbox_billing_resources');
    await bill([first]);
    await db.exec('RESET ROLE');
  });
  await check('workflow ownership resolves persisted plan and credit admission rejects empty balance', async () => {
    const plan=randomUUID();
    await db.query('INSERT INTO instance_plans VALUES($1,$2)',[plan,other]);
    await assert.rejects(() => rpc('register_sandbox_billing',['workflow','workflow',plan,site]),/ownership mismatch/);
    assert.equal((await rpc('register_sandbox_billing',['workflow','workflow',plan,other])).site_id,other);
    await db.query('UPDATE billing SET legacy_credits_available=0,plan_credits_available=0,purchased_credits_available=0,credits_available=0 WHERE site_id=$1',[other]);
    assert.equal((await rpc('register_sandbox_billing',['workflow','workflow',plan,other])).success,false);
  });
  await check('ledger persistence failure rolls back deduction and watermark together', async () => {
    const interval=session(randomUUID(),floor+2*3600000,floor+2*3600000+1000);
    const before=await one('select credits_available::text amount from billing where site_id=$1',[site]);
    await db.exec(`CREATE FUNCTION synthetic_ledger_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic ledger unavailable'; END $$;
      CREATE TRIGGER fail_ledger BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION synthetic_ledger_failure();`);
    await assert.rejects(() => bill([interval]),/Synthetic ledger unavailable/);
    assert.equal((await one('select credits_available::text amount from billing where site_id=$1',[site])).amount,before.amount);
    assert.equal((await one('select count(*)::int n from sandbox_billing_sessions where session_id=$1',[interval.id])).n,0);
    await db.exec('DROP TRIGGER fail_ledger ON credit_transactions');
    close((await bill([interval])).credits_charged,0.5/3600);
  });
  await check('retirement requires full settled observation, survives delete response loss and reactivates safely',async()=>{
    const name='retire-vm';
    await rpc('register_sandbox_billing',[name,'requirement',req,site]);
    await assert.rejects(()=>rpc('retire_sandbox_billing',[name,'begin']),/settlement is pending/);
    assert.equal((await rpc('retire_sandbox_billing',[name,'finish'])).success,false);
    await rpc('complete_sandbox_billing_observation',[name]);
    await rpc('retire_sandbox_billing',[name,'begin']);
    await assert.rejects(()=>rpc('register_sandbox_billing',[name,'requirement',req,site]),/deletion is pending/);
    assert.equal((await rpc('retire_sandbox_billing',[name,'finish'])).outcome,'retired');
    assert.equal((await rpc('retire_sandbox_billing',[name,'finish'])).outcome,'retired');
    const floorBefore=(await one('select registered_at::text floor from sandbox_billing_resources where sandbox_name=$1',[name])).floor;
    await rpc('register_sandbox_billing',[name,'requirement',req,site]);
    const after=await one('select retired_at,deletion_requested_at,registered_at::text floor from sandbox_billing_resources where sandbox_name=$1',[name]);
    assert.equal(after.retired_at,null);assert.equal(after.deletion_requested_at,null);assert.equal(after.floor,floorBefore);
  });
  console.log(`Sandbox SQL: ${checks} checks passed`);
} finally { await db.close(); }