import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real multi-session PostgreSQL using a disposable Unix socket, never a developer DB.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const bin = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin'].find(p => existsSync(join(p, 'initdb')));
if (!bin) throw new Error('Concurrency regression needs local PostgreSQL 15+ binaries');
const temp = mkdtempSync('/tmp/openrouter-cost-pg-'), data = join(temp, 'data');
const env = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C', HOME: temp };
const port = String(randomInt(20000,60000));
const args = ['-X','-qAt','-h',temp,'-p',port,'-U','usage_test_admin','-d','postgres','-v','ON_ERROR_STOP=1'];
let started = false;
const active = new Set();
const command = (name, argv) => {
  const r = spawnSync(join(bin,name), argv, { env, encoding:'utf8', timeout:30000 });
  if (r.status !== 0) throw new Error(`${name}: ${r.stderr || r.stdout || r.error?.message}`);
};
const quote = v => `'${String(v).replaceAll("'","''")}'`;
const client = (sql, hold = false) => {
  const name = `actual_cost_${randomUUID()}`;
  const child = spawn(join(bin,'psql'), args, { env:{ ...env, PGAPPNAME:name }, stdio:['pipe','pipe','pipe'] });
  active.add(child);
  let output='', errors='';
  child.stdout.on('data', v => { output += v; }); child.stderr.on('data', v => { errors += v; });
  const done = new Promise((res,rej) => {
    child.on('error',rej);
    child.on('close',code => { active.delete(child); if(code===0)res(output.trim()); else rej(new Error(errors || output)); });
  });
  done.catch(()=>{});
  const timeout = setTimeout(()=>child.kill('SIGKILL'),20000);
  done.finally(()=>clearTimeout(timeout)).catch(()=>{});
  child.stdin.on('error',()=>{});
  child.stdin.write("SET statement_timeout='10s'; SET lock_timeout='5s'; SET request.jwt.claim.role='service_role';\n"+sql+'\n');
  if(!hold)child.stdin.end();
  return { child, done, name, output:()=>output };
};
const sql = async text => (await client(text).done).split('\n').filter(Boolean).at(-1);
const wait = async (predicate, label) => {
  const end=Date.now()+7000;
  while(Date.now()<end){ if(await predicate())return; await new Promise(r=>setTimeout(r,20)); }
  throw new Error(`Timed out waiting for ${label}`);
};
const race = async (first,second) => {
  const a=client(`BEGIN; ${first} \n\\echo USAGE_LOCK_HELD`,true);
  let b;
  try {
    await wait(()=>a.output().includes('USAGE_LOCK_HELD'),'first transaction');
    b=client(`BEGIN; ${second} COMMIT;`);
    await wait(async()=>await sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${quote(b.name)} AND wait_event_type='Lock');`)==='t','contender lock');
    a.child.stdin.end('COMMIT;\n');
    await Promise.all([a.done,b.done]);
  } finally {
    if(!a.child.stdin.writableEnded)a.child.stdin.end('ROLLBACK;\n');
    await a.done.catch(()=>{}); if(b)await b.done.catch(()=>{});
  }
};
try {
  command('initdb',['-D',data,'-U','usage_test_admin','--auth=trust','--no-locale','--encoding=UTF8']);
  command('pg_ctl',['-D',data,'-l',join(temp,'server.log'),'-o',`-k ${temp} -p ${port} -c listen_addresses=''`,'-w','start']);
  started=true;
  await sql(readFileSync(resolve(root,'src/lib/services/billing/__tests__/credit-fixture.sql'),'utf8'));
  for(const file of ['20261003230000_credit_buckets_and_monthly_reset.sql','20261003230001_stripe_plan_credit_reset.sql',
    '20261003230002_classified_credit_operations.sql','20261005230000_exact_credit_accounting_precision.sql',
    '20261014230000_openrouter_actual_cost_ledger.sql'])await sql(readFileSync(resolve(root,'supabase/migrations',file),'utf8'));
  const site=randomUUID(),event=`gen-${randomUUID()}`;
  await sql(`INSERT INTO sites(id,name)VALUES(${quote(site)},'Synthetic concurrency'); SELECT initialize_site_billing(${quote(site)});
    UPDATE billing SET purchased_credits_available=10 WHERE site_id=${quote(site)};`);
  const bill=(cost,id=event)=>`SELECT bill_openrouter_generation(${quote(site)},${quote(id)},${cost},'{}');`;
  await race(bill('0.04'),bill('0.04'));
  assert.equal(await sql(`SELECT count(*) FROM credit_transactions WHERE site_id=${quote(site)};`),'1');
  assert.equal(await sql(`SELECT credits_used=0.05 FROM billing WHERE site_id=${quote(site)};`),'t');
  // Different generation keys still serialize through the site's bucket lock.
  await race(bill('0.08',randomUUID()),bill('0.12',randomUUID()));
  assert.equal(await sql(`SELECT credits_used=0.3 AND credits_available=plan_credits_available+legacy_credits_available+purchased_credits_available FROM billing WHERE site_id=${quote(site)};`),'t');
  assert.equal(await sql(`SELECT count(*) FROM credit_transactions WHERE site_id=${quote(site)};`),'3');
  console.log('PASS real PostgreSQL concurrent generation registration and bucket conservation');
  await sql('CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid); CREATE TABLE harness_sessions(id uuid PRIMARY KEY,site_id uuid,snapshot jsonb);');
  await sql(readFileSync(resolve(root,'supabase/migrations/20261014230002_sandbox_session_billing.sql'),'utf8'));
  const requirement=randomUUID(), name=`sandbox-${randomUUID()}`, session=`vm-${randomUUID()}`;
  await sql(`INSERT INTO requirements VALUES(${quote(requirement)},${quote(site)});
    SELECT register_sandbox_billing(${quote(name)},'requirement',${quote(requirement)},${quote(site)});
    UPDATE sandbox_billing_resources SET registered_at=now()-interval '3 hours' WHERE sandbox_name=${quote(name)};`);
  const end=Date.now()-60000, start=end-3600000;
  const interval=through=>quote(JSON.stringify([{id:session,started_at:new Date(start).toISOString(),ended_at:new Date(through).toISOString()}]));
  const observe=through=>`SELECT bill_sandbox_sessions(${quote(name)},${interval(through)}::jsonb,${quote(new Date(end).toISOString())}::timestamptz);`;
  await race(observe(end),observe(end));
  assert.equal(await sql(`SELECT credits_charged=0.5 FROM sandbox_billing_sessions WHERE session_id=${quote(session)};`),'t');
  assert.equal(await sql(`SELECT count(*) FROM credit_transactions WHERE transaction_type='sandbox_usage' AND site_id=${quote(site)};`),'1');
  assert.equal(await sql(`SELECT credits_used=0.8 FROM billing WHERE site_id=${quote(site)};`),'t');
  // A delayed ongoing observation cannot rewind usage or contradict the final stop.
  const earlier=quote(JSON.stringify([{id:session,started_at:new Date(start).toISOString(),ended_at:null}]));
  await sql(`SELECT bill_sandbox_sessions(${quote(name)},${earlier}::jsonb,${quote(new Date(end-1800000).toISOString())}::timestamptz);`);
  assert.equal(await sql(`SELECT credits_used=0.8 FROM billing WHERE site_id=${quote(site)};`),'t');
  console.log('PASS real PostgreSQL concurrent sandbox settlement and monotonic billing progress');
  await sql(`ALTER TABLE harness_sessions ADD lease_owner text,ADD lease_expires_at timestamptz;
    CREATE FUNCTION assert_agent_requirement_run(uuid,text,integer,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='owner' $$;`);
  await sql(readFileSync(resolve(root,'supabase/migrations/20261014050000_agent_requirement_credit_reservation.sql'),'utf8'));
  await sql(readFileSync(resolve(root,'supabase/migrations/20261014230001_agent_actual_cost_settlement.sql'),'utf8'));
  const harness=randomUUID(),heldEvent=randomUUID(),generation=`gen-${randomUUID()}`;
  // Use purchased funds for this concurrency case; period expiry is covered by
  // exact-bucket SQL tests, independently of the wall clock of a lock race.
  await sql(`UPDATE billing SET plan_credits_available=0,legacy_credits_available=0,purchased_credits_available=10 WHERE site_id=${quote(site)};
    INSERT INTO harness_sessions(id,site_id,snapshot,lease_owner,lease_expires_at)
    VALUES(${quote(harness)},${quote(site)},'{"status":"running"}','owner',now()+interval '1 hour');`);
  const reserve=`SELECT reserve_agent_requirement_credits(${quote(requirement)},'owner',0,${quote(harness)},${quote(heldEvent)},1);`;
  await race(reserve,reserve);
  assert.equal(await sql(`SELECT count(*) FROM harness_model_credit_reservations WHERE event_id=${quote(heldEvent)};`),'1');
  await sql(`SELECT dispatch_harness_model_reservation(${quote(harness)},${quote(heldEvent)});`);
  const settle=`SELECT settle_harness_model_reservation(${quote(harness)},${quote(heldEvent)},0.04,${quote(generation)},'openai/gpt-6.1-sol');`;
  await race(settle,settle);
  assert.equal(await sql(`SELECT credits_used=0.85 FROM billing WHERE site_id=${quote(site)};`),'t');
  assert.equal(await sql(`SELECT count(*) FROM credit_transactions WHERE transaction_type='agent_model_refund' AND metadata->>'event_id'=${quote(heldEvent)};`),'1');
  // The standalone completion adapter and the hold settlement share a global key.
  await sql(bill('0.04',generation));
  assert.equal(await sql(`SELECT credits_used=0.85 FROM billing WHERE site_id=${quote(site)};`),'t');
  console.log('PASS real PostgreSQL concurrent model hold/refund settlement and cross-adapter idempotency');
} finally {
  for(const child of active)child.kill('SIGKILL');
  if(started || existsSync(join(data,'postmaster.pid'))) command('pg_ctl',['-D',data,'-w','-t','10','-m','immediate','stop']);
  rmSync(temp,{recursive:true,force:true});
}