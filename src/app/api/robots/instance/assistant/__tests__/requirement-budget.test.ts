import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const rpc = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
import { evaluateRequirementCycleBudget, RequirementBudgetError } from '../requirement-budget';
import { requirementCycleFailure } from '../requirement-cycle-failure';
import { cycleRuntime } from './helpers/requirement-cycle-runtime';
import type { SessionStore } from '@/lib/harness/types';
import { requirementChargeMetadata, withRequirementChargeContext } from '@/lib/services/billing/requirement-charge-context';

const run = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(),
  sessionId: randomUUID(), instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 2 };
beforeEach(() => jest.clearAllMocks());

test.each(['unlimited', 'available', 'exhausted'])('cycle receipt %s', async state => {
  rpc.mockResolvedValue({ data: { state } });
  expect(await evaluateRequirementCycleBudget(run)).toBe(state === 'exhausted');
  expect(rpc).toHaveBeenCalledWith('evaluate_requirement_cycle_budget', {
    p_requirement_id: run.requirementId, p_run_id: run.runId,
    p_generation: run.executionGeneration, p_session_id: run.sessionId,
  });
});

test.each([null, undefined, { error: {} }, { data: null }, { data: { state: 'unknown' } }])('unavailable accounting is not zero spend', async receipt => {
  rpc.mockResolvedValue(receipt);
  await expect(evaluateRequirementCycleBudget(run)).rejects.toThrow('evaluation unavailable');
});

test.each([
  [{ code: 'P0001', message: 'Invalid requirement monetary budget' }, 'configuration_invalid'],
  [{ code: 'P0001', message: 'Other SQL failure' }, 'evaluation_unavailable'],
  [{ code: '42501', message: 'Invalid requirement monetary budget' }, 'evaluation_unavailable'],
  [{ message: 'Invalid requirement monetary budget' }, 'evaluation_unavailable'],
  [{ code: 'P0001', message: 'Invalid requirement monetary budget: extra detail' }, 'evaluation_unavailable'],
] as const)('only exact SQLSTATE and safe SQL message classify invalid configuration: %j', async (error, code) => {
  rpc.mockResolvedValue({ error });
  await expect(evaluateRequirementCycleBudget(run)).rejects.toMatchObject({ name: 'RequirementBudgetError', code });
});

test.each(['cloud', 'workspace'] as const)('budget failure before %s execution pauses in the real outer catch', async environment => {
  const execute = jest.fn();
  const store = {} as SessionStore; // Admission fails before any session I/O.
  const runtime = cycleRuntime({ store, environment, execute, evaluateBudget: () => evaluateRequirementCycleBudget(run) });
  for (const [receipt, reason] of [
    [{ error: { code: 'P0001', message: 'Invalid requirement monetary budget' } }, 'requirement_budget_configuration_invalid'],
    [{ data: null }, 'requirement_budget_evaluation_unavailable'],
  ] as const) {
    rpc.mockResolvedValue(receipt);
    const result = await runtime.run(run);
    expect(result.status).toBe('paused');
    expect(runtime.finish).toHaveBeenLastCalledWith(run, 'paused', reason, expect.any(String), undefined);
    expect(execute).not.toHaveBeenCalled();
  }
});

test('rejected budget I/O remains safely fenced without exposing database detail', async () => {
  rpc.mockRejectedValue(new Error('Offline database detail'));
  const error = await evaluateRequirementCycleBudget(run).catch(error => error);
  expect(error).toBeInstanceOf(RequirementBudgetError);
  expect(error.message).not.toContain('Offline database detail');
  expect(requirementCycleFailure(error)).toEqual({ status: 'paused', reason: 'requirement_budget_evaluation_unavailable' });
});

test('check precedes workspace/profile/model execution in the only runtime', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/app/api/robots/instance/assistant/requirement-runtime.ts'), 'utf8');
  const check = source.indexOf('await evaluateRequirementCycleBudget(run)');
  expect(check).toBeGreaterThan(0);
  expect(check).toBeLessThan(source.indexOf('await buildRequirementProfile('));
  expect(check).toBeLessThan(source.indexOf('await executeRequirementAssistantWorkspace('));
});

test('real SQL finish freezes admission failures without changing budget or overriding user controls offline', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { randomUUID } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const db=new PGlite(), rid=randomUUID(), site=randomUUID(), sid=randomUUID(), iid=randomUUID();
    try {
      await db.exec("CREATE TABLE requirements(id uuid,site_id uuid,budget numeric,status text,metadata jsonb,updated_at timestamptz,cron_lock_run_id text,cron_lock_expires_at timestamptz,cron_lock_active boolean); CREATE TABLE harness_sessions(id uuid,snapshot jsonb); CREATE TABLE harness_requirement_runs(requirement_id uuid,session_id uuid,generation integer,last_cycle_id text,pause_reason text,next_run_at timestamptz); CREATE TABLE requirement_status(requirement_id uuid,site_id uuid,instance_id uuid,stage text,cycle text,message text,repo_url text); CREATE FUNCTION assert_agent_requirement_run(uuid,text,integer,uuid,boolean,integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;");
      const migration=readFileSync('supabase/migrations/20261023200000_agent_requirement_nonblocking_wait.sql','utf8');
      await db.exec(migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.finish_agent_requirement_cycle('),migration.indexOf('REVOKE ALL ON FUNCTION public.claim_agent_requirement_run_before_commands')));
      await db.query("INSERT INTO requirements(id,site_id,budget,status,metadata,cron_lock_run_id,cron_lock_active) VALUES($1,$2,-1,'in-progress',$3,'owned',true)",[rid,site,{runner_instance_id:iid,requirement_execution_generation:'2'}]);
      await db.query("INSERT INTO harness_requirement_runs(requirement_id,session_id,generation,next_run_at) VALUES($1,$2,2,now())",[rid,sid]);
      for (const reason of ['requirement_budget_configuration_invalid','requirement_budget_evaluation_unavailable','sandbox_credits_required','sandbox_reconciliation_required']) {
        assert.equal((await db.query("SELECT finish_agent_requirement_cycle($1,'owned',2,$2,'paused',$3,'Safe failure') AS value",[rid,sid,reason])).rows[0].value,true);
        const row=(await db.query('SELECT budget::text AS budget,status,cron_lock_run_id,cron_lock_active FROM requirements')).rows[0];
        assert.deepEqual(row,{budget:'-1',status:'blocked',cron_lock_run_id:null,cron_lock_active:false});
        const mapping=(await db.query('SELECT pause_reason,next_run_at FROM harness_requirement_runs')).rows[0];
        assert.deepEqual(mapping,{pause_reason:reason,next_run_at:null});
      }
      await db.query('INSERT INTO harness_sessions VALUES($1,$2)',[sid,{status:'paused',reason:'user_pause'}]);
      await db.query("SELECT finish_agent_requirement_cycle($1,'owned',2,$2,'paused','requirement_budget_configuration_invalid','Safe failure')",[rid,sid]);
      assert.equal((await db.query('SELECT pause_reason FROM harness_requirement_runs')).rows[0].pause_reason,'user_pause');
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
}, 35000);

test('concurrent tool charge attribution is host-scoped and never crosses tenants', async () => {
  const other = { ...run, siteId: randomUUID(), requirementId: randomUUID(), sessionId: randomUUID() };
  await Promise.all([run, other].map(context => withRequirementChargeContext(context, async () => {
    await Promise.resolve();
    expect(requirementChargeMetadata(context.siteId)).toEqual({ requirement_id: context.requirementId, session_id: context.sessionId });
    expect(() => requirementChargeMetadata(randomUUID())).toThrow('tenant mismatch');
  })));
  expect(requirementChargeMetadata(run.siteId)).toEqual({});
});

test('real cycle budget SQL sums attributed charges without holds/refund duplication offline', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { randomUUID } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const site=randomUUID(), rid=randomUUID(), sid=randomUUID(), other=randomUUID();
    try {
      await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      await db.exec("CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,budget numeric,status text); CREATE TABLE harness_sessions(id uuid,site_id uuid,snapshot jsonb); CREATE TABLE harness_model_credit_reservations(requirement_id uuid,site_id uuid,state text,charged numeric); CREATE TABLE credit_transactions(site_id uuid,amount numeric,transaction_type text,metadata jsonb); CREATE TABLE sandbox_billing_resources(sandbox_name text,site_id uuid,owner_kind text,owner_id uuid); CREATE TABLE sandbox_billing_sessions(sandbox_name text,credits_charged numeric); CREATE TABLE projections(reason text,summary text);");
      await db.exec("CREATE FUNCTION assert_agent_requirement_run(uuid,text,integer,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='owned' $$; CREATE FUNCTION finish_agent_requirement_cycle(uuid,text,integer,uuid,text,text,text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN UPDATE public.requirements SET status='blocked' WHERE id=$1; INSERT INTO public.projections VALUES($6,$7); RETURN true; END $$;");
      await db.exec(readFileSync('supabase/migrations/20261026010000_requirement_cycle_budget.sql','utf8'));
      // Exercise the final deployed definitions too; full recovery/trigger wiring
      // is separately exercised by requirement-cron-sql.test.ts.
      const recovery=readFileSync('supabase/migrations/20261026020000_requirement_economic_recovery.sql','utf8');
      await db.exec(recovery.slice(recovery.indexOf('CREATE FUNCTION public.requirement_budget_observation('),
        recovery.indexOf('-- Called only for a verified finish receipt')));
      const check=async(run='owned') => (await db.query('SELECT evaluate_requirement_cycle_budget($1,$2,2,$3) value',[rid,run,sid])).rows[0].value;
      await db.query("INSERT INTO requirements VALUES($1,$2,NULL,'in-progress')",[rid,site]);
      await db.query("INSERT INTO harness_sessions VALUES($1,$2,$3)",[sid,site,{request:{requirementId:rid}}]);
      assert.equal((await check()).state,'unlimited');
      await db.exec('ALTER TABLE credit_transactions RENAME TO temporarily_unavailable_ledger');
      assert.equal((await check()).state,'unlimited','no-budget admission never scans the ledger');
      await db.exec('ALTER TABLE temporarily_unavailable_ledger RENAME TO credit_transactions');
      await db.query('UPDATE requirements SET budget=10 WHERE id=$1',[rid]);
      assert.equal((await check()).spent_usd,0);
      await db.query("INSERT INTO harness_model_credit_reservations VALUES($1,$2,'settled',6),($1,$2,'cancelled',0),($1,$2,'pending',NULL),($3,$2,'settled',100)",[rid,site,other]);
      const charge=async(amount,type,metadata,tenant=site)=>db.query('INSERT INTO credit_transactions VALUES($1,$2,$3,$4)',[tenant,amount,type,metadata]);
      await charge(-20,'agent_model_reservation',{requirement_id:rid});
      await charge(14,'agent_model_refund',{requirement_id:rid});
      await charge(-1,'agent_model_actual_cost',{requirement_id:rid});
      await charge(0,'agent_model_settlement',{requirement_id:rid});
      await charge(-3,'web_search',{requirement_id:rid,session_id:sid});
      await charge(1,'tool_refund',{session_id:sid});
      await charge(-100,'web_search',{requirement_id:other});
      await charge(-100,'web_search',{requirement_id:rid},randomUUID());
      await charge(-100,'web_search',{});
      await db.query("INSERT INTO sandbox_billing_resources VALUES('owned-vm',$1,'requirement',$2),('other-vm',$1,'requirement',$3)",[site,rid,other]);
      await db.exec("INSERT INTO sandbox_billing_sessions VALUES('owned-vm',1.5),('other-vm',100)");
      await charge(-1.5,'sandbox_usage',{requirement_id:rid,sandbox_name:'owned-vm'});
      let result=await check();
      assert.equal(result.state,'available'); assert.equal(result.spent_usd,9.5);
      assert.equal(result.model_usd,6); assert.equal(result.tools_usd,2); assert.equal(result.sandbox_usd,1.5);
      assert.equal(result.pending_model_reservations,1);
      assert.equal((await db.query('SELECT * FROM projections')).rows.length,0);
      await charge(-0.5,'web_search',{session_id:sid});
      result=await check(); assert.equal(result.state,'exhausted'); assert.equal(result.spent_usd,10);
      assert.equal((await db.query('SELECT reason FROM projections')).rows[0].reason,'token_budget_exhausted');
      await charge(-1,'web_search',{requirement_id:rid});
      assert.equal((await check()).spent_usd,11);
      await db.exec('UPDATE requirements SET budget=12');
      assert.equal((await check()).state,'available');
      for (const invalid of ['-1','NaN','Infinity','-Infinity']) {
        await db.query('UPDATE requirements SET budget=$1::numeric WHERE id=$2',[invalid,rid]);
        await assert.rejects(check(),error=>error.code==='P0001' && error.message==='Invalid requirement monetary budget');
        assert.equal((await db.query('SELECT budget::text AS budget FROM requirements WHERE id=$1',[rid])).rows[0].budget,invalid);
      }
      await db.exec('UPDATE requirements SET budget=NULL');
      assert.equal((await check()).state,'unlimited');
      await db.exec('UPDATE requirements SET budget=0');
      assert.equal((await check()).state,'exhausted');
      await assert.rejects(()=>check('foreign'),'unauthorized cycle');
      for (const role of ['anon','authenticated']) {
        assert.equal((await db.query("SELECT has_function_privilege($1,'evaluate_requirement_cycle_budget(uuid,text,integer,uuid)','EXECUTE') ok",[role])).rows[0].ok,false);
      }
      // Same-site scale fixture: unrelated rows must not be scanned every cycle.
      await db.query("INSERT INTO credit_transactions SELECT $1,-0.1,'web_search',jsonb_build_object('requirement_id',$2::text,'session_id',md5(n::text)) FROM generate_series(1,50000) n",[site,other]);
      await db.query("INSERT INTO harness_sessions SELECT md5(n::text)::uuid,$1,jsonb_build_object('request',jsonb_build_object('requirementId',$2::text)) FROM generate_series(1,10000) n",[site,other]);
      await db.query("INSERT INTO harness_model_credit_reservations SELECT $1,$2,'settled',0.1 FROM generate_series(1,50000)",[other,site]);
      await db.query("INSERT INTO sandbox_billing_resources SELECT 'noise-'||n,$1,'requirement',$2 FROM generate_series(1,10000) n",[site,other]);
      await db.exec("INSERT INTO sandbox_billing_sessions SELECT 'noise-'||n,0.1 FROM generate_series(1,10000) n; ANALYZE;");
      const migration=readFileSync('supabase/migrations/20261026010000_requirement_cycle_budget.sql','utf8');
      const queries=[
        migration.match(/SELECT coalesce\(sum\(charged\)[\s\S]*?WHERE requirement_id=r.id AND site_id=r.site_id;/)[0],
        migration.match(/SELECT greatest\(0,coalesce\(-sum\(charges.amount\)[\s\S]*?\) charges;/)[0],
        migration.match(/SELECT coalesce\(sum\(s.credits_charged\)[\s\S]*?b.owner_id=r.id;/)[0],
      ].map(sql=>sql.replace(/INTO model_spent,pending_models|INTO tool_spent|INTO sandbox_spent/g,'')
        .replace(/\br\.site_id\b/g,'$1::uuid').replace(/\br\.id\b/g,'$2::uuid'));
      const plans=async()=>Promise.all(queries.map(async sql=>(await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,[site,rid])).rows[0]['QUERY PLAN'][0]));
      const before=await plans();
      // Apply the complete batch inside a transaction, as migration runners do.
      const indexes=readFileSync('supabase/migrations/20261026010100_requirement_budget_indexes.sql','utf8');
      assert.equal((indexes.match(/^CREATE INDEX IF NOT EXISTS /gm)||[]).length,6);
      assert.doesNotMatch(indexes,/^CREATE INDEX CONCURRENTLY /m);
      await db.exec('BEGIN;\n'+indexes+'\nCOMMIT;');
      // Reapplying the batch must preserve six usable indexes.
      await db.exec('BEGIN;\n'+indexes+'\nCOMMIT;');
      const validity=await db.query("SELECT i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('harness_model_requirement_cost_idx','credit_transactions_requirement_cost_idx','credit_transactions_session_cost_idx','harness_sessions_requirement_cost_idx','sandbox_resources_requirement_cost_idx','sandbox_sessions_resource_cost_idx')");
      assert.equal(validity.rows.length,6);
      assert.ok(validity.rows.every(index=>index.indisvalid && index.indisready));
      await db.exec('ANALYZE');
      const after=await plans();
      const nodes=plan=>[plan,...(plan.Plans||[]).flatMap(nodes)];
      for (const [index,plan] of after.entries()) {
        assert.ok(nodes(plan.Plan).some(n=>n['Index Name']),'indexed access for component '+index);
        assert.ok(!nodes(plan.Plan).some(n=>n['Node Type']==='Seq Scan'),'no global sequential scan for component '+index);
      }
      await db.exec('UPDATE requirements SET budget=12');
      assert.equal((await check()).spent_usd,11,'unrelated history does not affect total');
      // Same-value transactions are distinct; dual requirement/session attribution
      // is counted once; malformed legacy session IDs never require UUID casts.
      await charge(-0.1,'web_search',{requirement_id:rid,session_id:sid});
      await charge(-0.1,'web_search',{requirement_id:rid,session_id:sid});
      await charge(-0.1,'web_search',{requirement_id:other,session_id:sid});
      await charge(-100,'web_search',{session_id:'not-a-uuid'});
      assert.equal((await check()).spent_usd,11.2,'explicit foreign requirement is not charged again via session');
      console.log(JSON.stringify({ fixture:{ledger:50000,models:50000,sessions:10000,resources:10000},
        before_ms:before.map(p=>p['Execution Time']),after_ms:after.map(p=>p['Execution Time']) }));
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  console.info('Cycle budget SQL benchmark (local PGlite):', result.stdout.trim());
}, 35000);