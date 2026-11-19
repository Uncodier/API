import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const migration = '20261118230002_withdrawable_execution_admission.sql';

it('retains existing scheduler/recovery guards and admits wallet-funded execution (offline PostgreSQL)', () => {
  // Replay the existing real forward-SQL regression suite, then exercise the new
  // gates. No remote DB or provider calls; renewal remains the harness fixture's
  // boundary (actual renewal/debits are covered by wallet-consumption tests).
  const source = readFileSync(resolve(root, 'src/lib/harness/__tests__/requirement-cron-sql.test.ts'), 'utf8');
  let script = source.split('const script = String.raw`')[1].split('`;\n  const child')[0];
  const boundary = "await db.exec(readFileSync('supabase/migrations/20261026030000_requirement_pause_recovery_commands.sql','utf8'));";
  expect(script.split(boundary)).toHaveLength(2);
  script = script.replace(boundary, `${boundary}\nawait db.exec(readFileSync('supabase/migrations/20261114210000_requirement_economic_recovery_contention.sql','utf8'));`);
  const checks = String.raw`
    {
    await reset();
    await db.exec('DELETE FROM harness_model_credit_reservations; ALTER TABLE billing ADD COLUMN account_balance numeric DEFAULT 0; ALTER TABLE sandbox_billing_resources ADD COLUMN registered_at timestamptz DEFAULT now();');
    const workspaceSource=readFileSync('supabase/migrations/20261028230000_assistant_workspace_resources.sql','utf8');
    const start=workspaceSource.indexOf('CREATE OR REPLACE FUNCTION public.register_sandbox_billing(');
    const finishAt=workspaceSource.indexOf('REVOKE ALL',start);
    assert.ok(start>=0 && finishAt>start);
    await db.exec(workspaceSource.slice(start,finishAt));
    await db.exec('REVOKE ALL ON FUNCTION public.register_sandbox_billing(text,text,uuid,uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.register_sandbox_billing(text,text,uuid,uuid) TO service_role;');
    const names=['claim_agent_requirement_run_before_commands','recheck_requirement_economic_pauses','inspect_requirement_commands','register_sandbox_billing'];
    const meta=async()=> (await db.query('SELECT oid,proname,proowner,proacl::text,proconfig,prosecdef FROM pg_proc WHERE proname=ANY($1::text[]) ORDER BY proname',[names])).rows;
    const bodies=async()=> (await db.query('SELECT proname,prosrc FROM pg_proc WHERE proname=ANY($1::text[]) ORDER BY proname',[names])).rows;
    const identity=await meta(), beforeBodies=await bodies();
    const beforeDefinitions=(await db.query('SELECT proname,pg_get_functiondef(oid) definition FROM pg_proc WHERE proname=ANY($1::text[]) ORDER BY proname',[names])).rows;
    const fundsBefore=(await one('SELECT to_jsonb(b) value FROM billing b')).value;
    const forward=readFileSync('supabase/migrations/20261118230002_withdrawable_execution_admission.sql','utf8');
    await db.exec(forward); await db.exec(forward);
    assert.deepEqual(await meta(),identity,'OID/owner/ACL/security/config remain unchanged, including recovery lock_timeout');
    assert.deepEqual((await one('SELECT to_jsonb(b) value FROM billing b')).value,fundsBefore,'installation moves no funds');
    for(const row of await bodies()) {
      assert.ok(row.prosrc.includes('account_balance'),row.proname+' includes wallet');
      assert.notEqual(row.prosrc,beforeBodies.find(b=>b.proname===row.proname).prosrc);
    }
    for(const funding of [
      {regular:0,wallet:39.22,admit:true}, {regular:.1,wallet:-.05,admit:true},
      {regular:0,wallet:0,admit:false}, {regular:.1,wallet:-.1,admit:false},
      {regular:-1,wallet:39.22,admit:false}, {regular:null,wallet:39.22,admit:false},
      {regular:0,wallet:'NaN',admit:false}, {regular:0,wallet:'Infinity',admit:false},
      {regular:1,wallet:'-Infinity',admit:false}, {regular:0,wallet:null,admit:false},
      {regular:1,wallet:null,admit:true},
    ]) {
      await reset(); await db.query('UPDATE billing SET credits_available=$1,account_balance=$2',[funding.regular,funding.wallet]);
      const id=await req(), balance=(await one('SELECT to_jsonb(b)::text value FROM billing b')).value;
      const run=await claim(); assert.equal(run?.run.requirementId??null,funding.admit?id:null,JSON.stringify(funding));
      assert.equal((await one('SELECT to_jsonb(b)::text value FROM billing b')).value,balance,'claim is not a debit');
    }
    for(const guard of ['execution_hold','user_paused','customer_paused','cron_paused']) {
      await reset(); await db.exec('UPDATE billing SET credits_available=0,account_balance=39.22');
      await req('backlog',{[guard]:guard==='execution_hold'?{kind:'security'}:true});
      assert.equal(await claim(),null,'wallet never bypasses '+guard);
    }
    await reset(); await db.exec('UPDATE billing SET credits_available=0,account_balance=39.22; UPDATE sites SET archived_at=now()');
    await req(); assert.equal(await claim(),null,'wallet never bypasses archived site');
    await db.exec('UPDATE sites SET archived_at=NULL');
    // Trusted predispatch shortage resumes the same session only at the actual
    // rejected hold minimum; no new generation or fake paid entitlement.
    await reset(); await db.exec('UPDATE billing SET credits_available=0,account_balance=.4');
    const id=await req(), run=(await claim()).run;
    await session(run,'paused','account_credits_exhausted',{creditRecoveryMinimum:.4});
    await finish(run,'paused','account_credits_exhausted');
    const heldSnapshot=(await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[run.sessionId])).snapshot;
    await db.exec("UPDATE billing SET account_balance=.39; UPDATE requirement_economic_pauses SET checked_at='-infinity'");
    assert.equal(await claim(),null,'wallet below trusted minimum cannot reopen work');
    assert.deepEqual((await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[run.sessionId])).snapshot,heldSnapshot);
    await db.exec("UPDATE billing SET account_balance=.4; UPDATE requirement_economic_pauses SET checked_at='-infinity'");
    const resumed=await claim(); assert.equal(resumed.run.sessionId,run.sessionId); assert.equal(resumed.run.executionGeneration,run.executionGeneration);
    assert.equal((await one('SELECT account_balance::text value FROM billing')).value,'0.4','recovery never spends or fabricates funds');
    // Read-only command diagnostics must use the same total and trusted minimum.
    await reset(); await db.exec('UPDATE billing SET credits_available=0,account_balance=.4');
    const diagnosticId=await req(), diagnosticRun=(await claim()).run;
    await session(diagnosticRun,'paused','account_credits_exhausted',{creditRecoveryMinimum:.4});
    await finish(diagnosticRun,'paused','account_credits_exhausted');
    const actionId=randomUUID();
    await db.query("INSERT INTO instance_logs(id,site_id,user_id,instance_id,log_type,trusted_user_action,details) VALUES($1,$2,$3,$4,'user_action',true,'{\"status\":\"completed\"}')",[actionId,site,user,diagnosticRun.instanceId]);
    await db.query('SELECT submit_requirement_command($1,$2,$3,$4,$5,$6)',[diagnosticId,site,user,diagnosticRun.instanceId,actionId,{status:'in-progress'}]);
    const diagnoseWallet=async()=> (await one('SELECT inspect_requirement_commands($1::uuid[],$2) value',[[diagnosticId],site])).value[diagnosticId];
    const diagnosticFunds=(await one('SELECT to_jsonb(b) value FROM billing b')).value;
    assert.equal((await diagnoseWallet()).reason,'waiting_scheduler');
    assert.deepEqual((await one('SELECT to_jsonb(b) value FROM billing b')).value,diagnosticFunds,'diagnostic cannot debit or renew');
    await db.exec('UPDATE billing SET account_balance=.39');
    assert.equal((await diagnoseWallet()).reason,'credits_insufficient_for_reservation');
    await db.exec("UPDATE billing SET account_balance='NaN'");
    assert.equal((await diagnoseWallet()).reason,'credits_unavailable');
    await db.exec('UPDATE billing SET account_balance=.4');
    // Sandbox admission uses persisted ownership and same funds, without changing
    // a wallet-only account into a paid-plan account or losing deletion fences.
    const sandbox='a-'+diagnosticRun.instanceId;
    const register=()=>one('SELECT register_sandbox_billing($1,$2,$3,$4) value',[sandbox,'instance',diagnosticRun.instanceId,site]);
    assert.equal((await register()).value.success,true);
    await assert.rejects(()=>one('SELECT register_sandbox_billing($1,$2,$3,$4)',[sandbox,'instance',diagnosticRun.instanceId,randomUUID()]),/site ownership mismatch/);
    for(const amount of ['0','NaN','Infinity','-Infinity']) {
      await db.query('UPDATE billing SET account_balance=$1',[amount]);
      assert.equal((await register()).value.success,false,amount+' wallet cannot admit sandbox');
    }
    await db.exec("UPDATE billing SET account_balance=39.22; UPDATE sandbox_billing_resources SET deletion_requested_at=now() WHERE sandbox_name='"+sandbox+"'");
    await assert.rejects(register,/deletion is pending/);
    // Exact body hashes refuse an unrelated changed definition; the transaction
    // must roll back earlier replacements rather than partially installing gates.
    for(const original of beforeDefinitions) await db.exec(original.definition);
    const diagnostic=beforeDefinitions.find(row=>row.proname==='inspect_requirement_commands').definition;
    await db.exec(diagnostic.replace('DECLARE','-- synthetic drift\nDECLARE'));
    const preFailure=await bodies();
    await assert.rejects(db.exec(forward),/Unexpected withdrawable admission definition/);
    await db.exec('ROLLBACK');
    assert.deepEqual(await bodies(),preFailure,'later drift rolls back earlier real replacements');
    console.log('wallet execution admission passed');
    }
  `;
  expect(script.split("console.log('passed');")).toHaveLength(2);
  script = script.replace("console.log('passed');", checks);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || child.stdout);
  expect(child.stdout).toContain('wallet execution admission passed');
}, 130_000);