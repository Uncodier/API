// Real disposable PostgreSQL, socket only. Never reads .env or database URLs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bin = '/opt/homebrew/opt/postgresql@17/bin';
const directory = mkdtempSync('/tmp/requirement-cron-pg-');
const env = { PATH: process.env.PATH, LC_ALL: 'C', LANG: 'C' };
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', '55448', '-U', 'postgres', '-d', 'postgres'];
const run = (name, argv, options = {}) => execFileSync(join(bin, name), argv,
  { encoding: 'utf8', env, timeout: 60_000, stdio: 'pipe', ...options });
const sql = input => run('psql', args, { input }).trim();
const load = name => sql(readFileSync(join(root, 'supabase/migrations', name), 'utf8'));
const id = n => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const site = id(1), user = id(2), requirement = id(3), badSite = id(4);
const claimSql = "SELECT public.claim_agent_requirement_run('{}',10,300,'{}');";
const claim = () => JSON.parse(sql(claimSql) || 'null');
const seed = () => sql(`INSERT INTO requirements(id,site_id,user_id,status,created_at,updated_at,metadata)
  VALUES('${requirement}','${site}','${user}','backlog','2026-08-01','2026-11-03','{}');`);
const reset = () => sql(`DELETE FROM requirement_migration_lifecycle; DELETE FROM requirement_status;
  DELETE FROM harness_requirement_runs; DELETE FROM harness_sessions; DELETE FROM requirements;
  DELETE FROM instance_plans; DELETE FROM instance_logs; DELETE FROM remote_instances;
  UPDATE sites SET archived_at=NULL; UPDATE billing SET credits_available=20;`);
const evidence = () => sql(`SELECT jsonb_build_object('requirements',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM requirements r),
  'instances',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM remote_instances i),
  'mappings',(SELECT jsonb_agg(to_jsonb(h) ORDER BY requirement_id) FROM harness_requirement_runs h),
  'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM harness_sessions s),
  'statuses',(SELECT jsonb_agg(to_jsonb(st) ORDER BY id) FROM requirement_status st));`);
const waitFor = async predicate => {
  for (let i=0; i<200; i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,25)); }
  throw new Error('Timed out waiting for disposable PostgreSQL lock');
};
const connection = input => {
  const child=spawn(join(bin,'psql'),args,{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr=''; child.stdout.on('data',v=>stdout+=v); child.stderr.on('data',v=>stderr+=v);
  const result=new Promise((resolve,reject)=>child.on('exit',code=>code===0?resolve(stdout.trim()):reject(new Error(stderr))));
  child.stdin.write(input); return {child,result};
};
try {
  run('initdb',['-D',join(directory,'data'),'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',join(directory,'data'),'-l',join(directory,'server.log'),'-o',
    `-F -p 55448 -k ${directory} -c listen_addresses='' -c lc_messages=C`, '-w','start']);
  // Reuse the existing harness's minimal schema verbatim, not a scheduler mock.
  const harness=readFileSync(join(root,'src/lib/harness/__tests__/requirement-cron-sql.test.ts'),'utf8');
  const setup=harness.slice(harness.indexOf("      await db.exec('CREATE ROLE"),harness.indexOf('      // Install real historical'));
  await runInNewContext('(async()=>{'+setup+'})()', {db:{exec:async text=>sql(text)}});
  for(const name of ['20260923225900_review_quarantine_receipts.sql','20260923230000_durable_review_quarantine.sql',
    '20260923230100_stamp_review_quarantine.sql','20260930010000_requirement_migration_lifecycle.sql',
    '20261003010000_migration_execution_handoff.sql','20261014010000_portable_harness_sessions.sql',
    '20261014020000_portable_harness_host_state.sql','20261014030000_agent_driven_requirement_cron.sql',
    '20261020200000_requirement_cross_instance_commands.sql','20261023200000_agent_requirement_nonblocking_wait.sql',
    '20261103210000_requirement_created_or_updated_scope.sql']) load(name);
  sql(`ALTER TABLE sites ADD COLUMN archived_at timestamptz;
    CREATE TABLE billing(site_id uuid PRIMARY KEY,credits_available numeric);
    INSERT INTO sites(id) VALUES('${site}'),('${badSite}'); INSERT INTO auth.users VALUES('${user}');
    INSERT INTO billing VALUES('${site}',20),('${badSite}',20);`);
  seed();const before=evidence();
  const functions = () => JSON.parse(sql(`SELECT json_agg(json_build_object('oid',oid,'name',proname,'owner',proowner,
    'acl',proacl,'definer',prosecdef,'config',proconfig,'definition',pg_get_functiondef(oid)) ORDER BY proname)
    FROM pg_proc WHERE proname IN ('claim_agent_requirement_run','claim_agent_requirement_run_before_commands');`));
  const old=functions();
  const migration='20261104110000_requirement_site_credit_admission.sql';
  load(migration);load(migration);
  const current=functions();assert.deepEqual(current[0],old[0],'public command wrapper unchanged');
  assert.deepEqual({...current[1],definition:null},{...old[1],definition:null});
  assert.equal(evidence(),before,'migration/reapply performs no data writes');
  for(const obstruction of ['archived','missing','null','zero','negative']) {
    reset();seed();
    if(obstruction==='archived') sql(`UPDATE sites SET archived_at=now() WHERE id='${site}'`);
    else if(obstruction==='missing') sql(`DELETE FROM billing WHERE site_id='${site}'`);
    else sql(`UPDATE billing SET credits_available=${{null:'NULL',zero:'0',negative:'-1'}[obstruction]} WHERE site_id='${site}'`);
    const before=evidence();assert.equal(claim(),null,obstruction);assert.equal(evidence(),before);
    sql(`UPDATE sites SET archived_at=NULL; INSERT INTO billing VALUES('${site}',0.0001)
      ON CONFLICT(site_id) DO UPDATE SET credits_available=EXCLUDED.credits_available;`);
    assert.equal(claim().run.requirementId,requirement,'recharge restores eligibility');
  }
  for(const obstruction of ['archived','zero']) {
    reset();seed();
    sql(`INSERT INTO requirements(id,site_id,user_id,status,created_at,updated_at,metadata)
      SELECT gen_random_uuid(),'${badSite}','${user}','backlog','2026-09-01','2026-09-01','{}' FROM generate_series(1,1001);`);
    sql(obstruction==='archived'?`UPDATE sites SET archived_at=now() WHERE id='${badSite}'`:
      `UPDATE billing SET credits_available=0 WHERE site_id='${badSite}'`);
    assert.equal(claim().run.requirementId,requirement,'ineligible rows cannot fill candidate window');
    assert.equal(sql('SELECT count(*) FROM remote_instances'),'1');
  }
  // Candidate was visible before a mapping lock wait; a second connection changes
  // site/billing before that wait ends. The locked recheck must see the change.
  for(const obstruction of ['archived','zero','missing']) {
    reset();seed();const initial=claim();
    sql('UPDATE requirements SET cron_lock_active=false,cron_lock_expires_at=NULL,cron_lock_run_id=NULL');
    const before=evidence();
    const holder=connection(`SET application_name='cron-admission-holder'; BEGIN;
      SELECT requirement_id FROM harness_requirement_runs WHERE requirement_id='${requirement}' FOR UPDATE;\n`);
    await waitFor(()=>sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='cron-admission-holder' AND state='idle in transaction'")==='1');
    const worker=connection("SET application_name='cron-admission-worker'; SET statement_timeout='10s'; "+claimSql+'\n');worker.child.stdin.end();
    await waitFor(()=>sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='cron-admission-worker' AND wait_event_type='Lock'")==='1');
    holder.child.stdin.end((obstruction==='archived'?`UPDATE sites SET archived_at=now() WHERE id='${site}';`:
      obstruction==='missing'?`DELETE FROM billing WHERE site_id='${site}';`:
      `UPDATE billing SET credits_available=0 WHERE site_id='${site}';`)+' COMMIT;\n');
    await holder.result;assert.equal(await worker.result,'','stale candidate rejected after lock wait');
    assert.equal(evidence(),before,'skip does not mutate ownership or leases');
    sql(`UPDATE sites SET archived_at=NULL; INSERT INTO billing VALUES('${site}',20)
      ON CONFLICT(site_id) DO UPDATE SET credits_available=20;`);
    assert.equal(claim().run.sessionId,initial.run.sessionId,'recharge retains session and generation');
  }
  // Real billing renewal, not a success-only stub: the scheduler must neither
  // renew a zero balance itself nor leave a durable hold after renewal succeeds.
  reset();seed();
  sql('DROP TABLE billing; ALTER TABLE sites ADD COLUMN name text, ADD COLUMN user_id uuid;');
  const billingFixture=readFileSync(join(root,'src/lib/services/billing/__tests__/credit-fixture.sql'),'utf8')
    .replace(/CREATE ROLE [^;]+;/g,'').replace('CREATE SCHEMA auth;','')
    .replace(/CREATE TABLE public.sites\([^;]+;/,'');
  sql(billingFixture);
  for(const name of ['20261003230000_credit_buckets_and_monthly_reset.sql',
    '20261003230001_stripe_plan_credit_reset.sql','20261003230002_classified_credit_operations.sql',
    '20261005230000_exact_credit_accounting_precision.sql','20261007003000_remove_signup_credit_bonus.sql',
    '20261007180000_annual_subscription_credit_periods.sql','20261007180001_subscription_checkout_leases.sql',
    '20261008210000_preserve_canceled_subscription_credit_usage.sql']) load(name);
  sql(`SELECT initialize_site_billing('${site}'); UPDATE billing SET plan='commission',
    plan_credits_available=0,purchased_credits_available=0,legacy_credits_available=0,credits_available=0,
    plan_credit_period_start=now()-interval '2 months',plan_credit_period_end=now()-interval '1 month',
    plan_credit_anchor=NULL WHERE site_id='${site}';`);
  const balanceBefore=sql('SELECT to_jsonb(b) FROM billing b');
  assert.equal(claim(),null,'stored zero balance is skipped even when renewal is due');
  assert.equal(sql('SELECT to_jsonb(b) FROM billing b'),balanceBefore,'admission does not invoke lazy renewal');
  const renewed=JSON.parse(sql(`SELECT renew_site_plan_credits('${site}')`));
  assert.equal(renewed.success,true);assert.ok(Number(renewed.credits_available)>0);
  const renewedBalance=sql('SELECT to_jsonb(b) FROM billing b');
  assert.equal(claim().run.requirementId,requirement,'real monthly renewal restores admission');
  assert.equal(sql('SELECT to_jsonb(b) FROM billing b'),renewedBalance,'claim does not debit or alter billing');
  console.log('PASS native PostgreSQL: admission, recharge/real renewal, pre-LIMIT filtering, locked rechecks, migration identity/ACLs');
} finally {
  if(existsSync(join(directory,'data/postmaster.pid'))) run('pg_ctl',['-D',join(directory,'data'),'-m','immediate','-w','stop']);
  rmSync(directory,{recursive:true,force:true});
}