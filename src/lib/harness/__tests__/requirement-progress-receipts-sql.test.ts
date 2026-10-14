import { spawnSync } from 'node:child_process';

describe('agent requirement progress receipts (real offline PostgreSQL)', () => {
  let passed: string[];

  beforeAll(() => {
    // Real migrations, owner assertion, constraints and triggers in ephemeral
    // PGlite. Serial interleavings do not prove multi-connection lock contention.
    const script = String.raw`
      import { PGlite } from '@electric-sql/pglite';
      import { readFileSync } from 'node:fs';
      import { randomUUID } from 'node:crypto';
      import assert from 'node:assert/strict';
      const db = new PGlite();
      const site = randomUUID(), user = randomUUID(), passed = [];
      const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
      const migration = file => readFileSync('supabase/migrations/' + file, 'utf8');
      const signature = 'patch_agent_requirement_progress(uuid,text,integer,uuid,uuid,text,text,text,text,bigint)';
      const receiptKeys = ['state','status_changed','message_recorded','backlog_revision',
        'plan_id','plan_status','step_id','step_status','item_id','item_status',
        'plan_steps_total','plan_steps_completed','backlog_items_total','backlog_items_completed'].sort();
      const progress = async (f, args = {}) => {
        const a = { ...f.run, planId: null, stepId: null, itemId: null, status: null, message: null, revision: 0, ...args };
        return (await one('SELECT patch_agent_requirement_progress($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value',
          [a.requirementId,a.runId,a.executionGeneration,a.sessionId,a.planId,a.stepId,a.itemId,a.status,a.message,a.revision])).value;
      };
      const receipt = (actual, expected = {}) => {
        assert.deepEqual(Object.keys(actual).sort(), receiptKeys, 'bounded scalar receipt, never metadata or snapshots');
        assert.deepEqual(actual, { state: 'unchanged', status_changed: false, message_recorded: false, backlog_revision: 0,
          plan_id: null, plan_status: null, step_id: null, step_status: null, item_id: null, item_status: null,
          plan_steps_total: 0, plan_steps_completed: 0, backlog_items_total: 2, backlog_items_completed: 0, ...expected });
      };
      // Lease renewal is deliberately preserved. Everything else is compared,
      // including progress timestamps and UPDATE attempts caught by the audit.
      const snapshot = async () => ({
        requirements: (await db.query("SELECT to_jsonb(r)-'cron_lock_expires_at' value FROM requirements r ORDER BY id")).rows,
        plans: (await db.query('SELECT * FROM instance_plans ORDER BY id')).rows,
        history: (await db.query('SELECT * FROM requirement_status ORDER BY id')).rows,
        writes: (await db.query('SELECT * FROM progress_test_writes ORDER BY id')).rows,
      });
      const rejectWithoutProgress = async (f, args, expected) => {
        const before = await snapshot();
        assert.deepEqual(await progress(f, args), expected);
        assert.deepEqual(await snapshot(), before);
      };
      const writeCounts = async () => (await db.query('SELECT target,count(*)::int n FROM progress_test_writes GROUP BY target ORDER BY target')).rows;
      const fixture = async () => {
        await db.exec('DELETE FROM requirement_migration_lifecycle;DELETE FROM requirement_status;DELETE FROM harness_requirement_runs;DELETE FROM harness_sessions;DELETE FROM requirements;DELETE FROM instance_plans;DELETE FROM instance_logs;DELETE FROM remote_instances;DELETE FROM progress_test_writes;');
        const id = randomUUID(), plan = randomUUID();
        const backlog = { note: 'Preserve original backlog', items: [
          { id: 'item', status: 'pending', attempts: 999, acceptance: { approved: false }, constraints: ['Keep ownership'], evidence: { tests: { passed: false } } },
          { id: 'other-item', status: 'failed', metadata: { retained: true } },
        ] };
        const steps = [
          { id: 'step', status: 'pending', title: 'First', metadata: { backlog_item_id: 'item', acceptance: 'Unchanged' } },
          { id: 'other-step', status: 'failed', evidence: { tests: false } },
        ];
        await db.query("INSERT INTO requirements(id,site_id,user_id,status,metadata,backlog,created_at,updated_at) VALUES($1,$2,$3,'backlog',$4,$5,'2026-09-15','2026-09-15')",
          [id,site,user,{ requirement_execution_generation: 7, no_progress_cycles: 999, legacy_circuit: { open: true } },backlog]);
        const { run } = (await one("SELECT claim_agent_requirement_run('{}'::uuid[],10,300,'{}'::uuid[]) value")).value;
        const initial = { id: run.sessionId, version: 0, status: 'queued', request: { objective: 'Offline task',
          repository: { url: 'https://example.test/repository' }, limits: { maxTurns: 10, maxOutputTokens: 1024, maxTotalTokens: 10000, maxActiveMs: 30000 } },
          messages: [], turns: 0, allocatedTokens: 0, activeMs: 0, uncertainOperations: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
        await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[run.sessionId,site,user,initial]);
        await db.query("INSERT INTO instance_plans(id,site_id,instance_id,status,metadata,steps,updated_at) VALUES($1,$2,$3,'pending',$4,$5,'2026-09-15')",
          [plan,site,run.instanceId,{ requirement_id: id, security: 'Unchanged' },steps]);
        return { id, plan, run, backlog, steps };
      };
      const check = async (name, fn) => { await fn(await fixture()); passed.push(name); };
      try {
        await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE sites(id uuid PRIMARY KEY);');
        await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;');
        await db.exec(
          "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,user_id uuid NOT NULL,title text DEFAULT 'Offline',status text CHECK(status IN ('backlog','in-progress','blocked','on-review','done','cancelled')),cron text,created_at timestamptz,updated_at timestamptz,metadata jsonb,backlog jsonb DEFAULT '{}',backlog_revision bigint DEFAULT 0,cron_lock_run_id text,cron_lock_expires_at timestamptz,cron_lock_active boolean DEFAULT false);"+
          "CREATE TABLE remote_instances(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL,user_id uuid NOT NULL,created_by uuid NOT NULL,name text NOT NULL,instance_type text CHECK(instance_type IN ('browser','ubuntu','windows')),status text CHECK(status IN ('pending','starting','running','paused','stopping','stopped','error')),is_archived boolean DEFAULT false,created_at timestamptz DEFAULT now());"+
          "CREATE TABLE instance_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),instance_id uuid REFERENCES remote_instances(id),site_id uuid,status text CHECK(status IN ('pending','in_progress','active','paused','completed','failed','cancelled','blocked')),metadata jsonb,steps jsonb,steps_total int DEFAULT 777,steps_completed int DEFAULT 776,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());"+
          "CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid,instance_id uuid,log_type text,trusted_user_action boolean,details jsonb,created_at timestamptz DEFAULT now());"+
          "CREATE TABLE requirement_status(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),requirement_id uuid REFERENCES requirements(id),site_id uuid,instance_id uuid,stage text,cycle text,message text,repo_url text,metadata jsonb,updated_at timestamptz DEFAULT now());"
        );
        for (const file of ['20260923230000_durable_review_quarantine.sql','20260923230100_stamp_review_quarantine.sql',
          '20260930010000_requirement_migration_lifecycle.sql','20261003010000_migration_execution_handoff.sql',
          '20261014010000_portable_harness_sessions.sql','20261014020000_portable_harness_host_state.sql',
          '20261014030000_agent_driven_requirement_cron.sql','20261014040000_agent_requirement_progress.sql']) await db.exec(migration(file));
        const catalog = async () => (await db.query("SELECT oid,proname,proowner,proacl,prosecdef,proconfig,proargnames,pronargdefaults,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows;
        const oldCatalog = await catalog();
        const forward = migration('20261014195500_agent_progress_receipts.sql');
        await db.exec(forward);
        await db.exec(forward); // CREATE OR REPLACE preserves identity/defaults and is safe to reapply offline.
        const newCatalog = await catalog();
        assert.equal(newCatalog.length, oldCatalog.length);
        for (let i = 0; i < oldCatalog.length; i++) {
          const { prosrc: oldSource, ...oldProperties } = oldCatalog[i];
          const { prosrc: newSource, ...newProperties } = newCatalog[i];
          assert.deepEqual(newProperties, oldProperties, 'signature, function owner and permissions unchanged');
          if (oldProperties.proname === 'patch_agent_requirement_progress') assert.notEqual(newSource, oldSource);
          else assert.equal(newSource, oldSource, 'no unrelated function replaced');
        }
        assert.match(forward,/WHERE id=p_requirement_id FOR UPDATE/);
        assert.match(forward,/instance_id::text=r\.metadata->>'runner_instance_id' FOR UPDATE/);
        await db.exec("CREATE TABLE progress_test_writes(id bigint GENERATED ALWAYS AS IDENTITY,target text);"+
          "CREATE FUNCTION progress_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.progress_test_writes(target) VALUES(TG_TABLE_NAME); RETURN NEW; END $$;"+
          "CREATE TRIGGER progress_test_requirement_write AFTER UPDATE OF backlog,backlog_revision ON requirements FOR EACH ROW EXECUTE FUNCTION progress_test_audit();"+
          "CREATE TRIGGER progress_test_plan_write AFTER UPDATE ON instance_plans FOR EACH ROW EXECUTE FUNCTION progress_test_audit();");
        await db.query('INSERT INTO sites VALUES($1)',[site]);
        await db.query('INSERT INTO auth.users VALUES($1)',[user]);

        await check('preserves function security and legacy SQL call signatures', async f => {
          const props = await one('SELECT prosecdef,proconfig,pronargdefaults FROM pg_proc WHERE oid=$1::regprocedure',[signature]);
          assert.equal(props.prosecdef,true);assert.deepEqual(props.proconfig,['search_path=pg_catalog']);assert.equal(props.pronargdefaults,1);
          for (const role of ['anon','authenticated','service_role']) {
            assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).allowed,role==='service_role');
            await db.exec('SET ROLE '+role);
            if (role !== 'service_role') await assert.rejects(() => progress(f,{ message: 'Denied' }),/permission denied/);
            else {
              const args = [f.id,f.run.runId,7,f.run.sessionId,f.plan,'step','item','done','Legacy positional caller'];
              const result = (await one('SELECT patch_agent_requirement_progress($1,$2,$3,$4,$5,$6,$7,$8,$9) value',args)).value;
              receipt(result,{ state:'updated',status_changed:true,message_recorded:true,backlog_revision:1,
                plan_id:f.plan,plan_status:'pending',step_id:'step',step_status:'completed',item_id:'item',item_status:'done',
                plan_steps_total:2,plan_steps_completed:1,backlog_items_completed:1 });
              const named = (await one('SELECT patch_agent_requirement_progress(p_requirement_id=>$1,p_run_id=>$2,p_generation=>$3,p_session_id=>$4,p_plan_id=>$5,p_step_id=>$6,p_item_id=>$7,p_status=>$8,p_message=>$9,p_expected_backlog_revision=>$10) value',
                [...args.slice(0,7),'failed','Named RPC caller',1])).value;
              assert.equal(named.state,'updated');assert.equal(named.backlog_revision,2);
            }
            await db.exec('RESET ROLE');
          }
        });

        await check('completing every step never auto closes; only explicit plan progress closes', async f => {
          for (const stepId of ['step','other-step']) {
            const result = await progress(f,{ planId:f.plan,stepId,status:'done' });
            assert.equal(result.plan_status,'pending');assert.equal(result.step_status,'completed');assert.equal(result.backlog_revision,0);
          }
          const before = await snapshot();
          receipt(await progress(f,{ planId:f.plan,stepId:'other-step',status:'completed' }),{
            plan_id:f.plan,plan_status:'pending',step_id:'other-step',step_status:'completed',plan_steps_total:2,plan_steps_completed:2 });
          assert.deepEqual(await snapshot(),before,'same canonical status performs no progress UPDATE');
          receipt(await progress(f,{ planId:f.plan,status:'completed' }),{
            state:'updated',status_changed:true,plan_id:f.plan,plan_status:'completed',plan_steps_total:2,plan_steps_completed:2 });
          const closed = await snapshot();
          receipt(await progress(f,{ planId:f.plan,status:'done' }),{
            plan_id:f.plan,plan_status:'completed',plan_steps_total:2,plan_steps_completed:2 });
          assert.deepEqual(await snapshot(),closed);
          assert.equal((await one('SELECT status FROM requirements')).status,'in-progress');
          assert.deepEqual(await writeCounts(),[{ target:'instance_plans',n:3 }]);
        });

        await check('partial and empty plans can explicitly complete without quality or repetition gates', async f => {
          receipt(await progress(f,{ planId:f.plan,status:'done',message:'Partial plan deliberately closed; tests still fail.' }),{
            state:'updated',status_changed:true,message_recorded:true,plan_id:f.plan,plan_status:'completed',plan_steps_total:2 });
          assert.deepEqual((await one('SELECT steps FROM instance_plans')).steps,f.steps);
          assert.deepEqual((await one('SELECT backlog FROM requirements')).backlog,f.backlog);
          await db.query("UPDATE instance_plans SET status='pending',steps='[]'");
          receipt(await progress(f,{ planId:f.plan,status:'completed' }),{
            state:'updated',status_changed:true,plan_id:f.plan,plan_status:'completed' });
          for (const status of ['pending','in_progress','failed','done','completed','pending','done']) {
            const result = await progress(f,{ planId:f.plan,status });
            assert.equal(result.plan_status,status==='done'?'completed':status);
            assert.equal(result.state,status==='completed'?'unchanged':'updated');
          }
          assert.equal((await one('SELECT status FROM requirements')).status,'in-progress');
        });

        await check('unchanged retries retain every message but never rewrite progress or timestamps', async f => {
          const args = { planId:f.plan,stepId:'step',itemId:'item',status:'done',message:'Implemented; acceptance is unverified.' };
          const first = await progress(f,args);
          assert.equal(first.state,'updated');assert.equal(first.backlog_revision,1);
          const before = await snapshot();
          for (let i=0;i<12;i++) {
            receipt(await progress(f,{ ...args,status:i%2?'completed':'done',revision:1 }),{
              message_recorded:true,backlog_revision:1,plan_id:f.plan,plan_status:'pending',step_id:'step',step_status:'completed',
              item_id:'item',item_status:'done',plan_steps_total:2,plan_steps_completed:1,backlog_items_completed:1 });
          }
          const after = await snapshot();
          assert.deepEqual(after.requirements,before.requirements);assert.deepEqual(after.plans,before.plans);assert.deepEqual(after.writes,before.writes);
          assert.equal(after.history.length,13);
          for (const row of after.history) {
            assert.equal(row.message,args.message);assert.equal(row.requirement_id,f.id);assert.equal(row.site_id,site);
            assert.equal(row.instance_id,f.run.instanceId);assert.equal(row.stage,'in-progress');
          }
          const noMessage = await progress(f,{ ...args,message:null,revision:1 });
          assert.equal(noMessage.state,'unchanged');assert.equal(noMessage.message_recorded,false);
          assert.equal((await snapshot()).history.length,13);
          await rejectWithoutProgress(f,{ ...args,revision:0 },{ state:'revision_conflict',backlog_revision:1 });
          const next = await progress(f,{ ...args,status:'failed',revision:1 });
          assert.equal(next.state,'updated');assert.equal(next.backlog_revision,2);
          assert.deepEqual((await one('SELECT backlog FROM requirements')).backlog,{ ...f.backlog,items:[{ ...f.backlog.items[0],status:'failed' },f.backlog.items[1]] });
          assert.deepEqual((await one('SELECT steps FROM instance_plans')).steps,[{ ...f.steps[0],status:'failed' },f.steps[1]]);
          assert.deepEqual(await writeCounts(),[{ target:'instance_plans',n:2 },{ target:'requirements',n:2 }]);
        });

        await check('message-only calls preserve supplied text and absent targets without status changes', async f => {
          const message = '  Preserve spaces\nAnd every supplied progress detail.  ';
          const before = await snapshot();
          receipt(await progress(f,{ message }),{ message_recorded:true });
          receipt(await progress(f,{ planId:f.plan,stepId:'step',itemId:'item',message }),{
            message_recorded:true,plan_id:f.plan,plan_status:'pending',step_id:'step',step_status:'pending',
            item_id:'item',item_status:'pending',plan_steps_total:2 });
          receipt(await progress(f,{ planId:f.plan,stepId:'missing',itemId:'missing',message }),{
            message_recorded:true,plan_id:f.plan,plan_status:'pending',plan_steps_total:2 });
          const after = await snapshot();
          assert.deepEqual(after.requirements,before.requirements);assert.deepEqual(after.plans,before.plans);assert.deepEqual(after.writes,before.writes);
          assert.deepEqual(after.history.map(row=>row.message),[message,message,message]);
          receipt(await progress(f,{ itemId:'item',status:'pending',message:'' }),{ item_id:'item',item_status:'pending' });
          assert.equal((await snapshot()).history.length,3);
        });

        await check('full-array counts ignore previews and cached totals; mixed targets bump only backlog changes', async f => {
          const steps = Array.from({ length:137 },(_,i)=>({ id:'s'+i,status:i<51?(i%2?'completed':'done'):'pending' }));
          const items = Array.from({ length:151 },(_,i)=>({ id:'i'+i,status:i<63?(i%2?'completed':'done'):'pending' }));
          await db.query('UPDATE instance_plans SET steps=$1',[JSON.stringify(steps)]);
          await db.query('UPDATE requirements SET backlog=$1',[{ items }]);
          await db.exec('DELETE FROM progress_test_writes');
          receipt(await progress(f,{ planId:f.plan,stepId:'s136',itemId:'i150',status:'completed' }),{
            state:'updated',status_changed:true,backlog_revision:1,plan_id:f.plan,plan_status:'pending',
            step_id:'s136',step_status:'completed',item_id:'i150',item_status:'done',
            plan_steps_total:137,plan_steps_completed:52,backlog_items_total:151,backlog_items_completed:64 });
          assert.deepEqual(await writeCounts(),[{ target:'instance_plans',n:1 },{ target:'requirements',n:1 }]);
          await db.exec('DELETE FROM progress_test_writes');
          let result = await progress(f,{ planId:f.plan,stepId:'s135',itemId:'i150',status:'done',revision:1 });
          assert.equal(result.state,'updated');assert.equal(result.backlog_revision,1);assert.equal(result.plan_steps_completed,53);
          assert.deepEqual(await writeCounts(),[{ target:'instance_plans',n:1 }]);
          await db.exec('DELETE FROM progress_test_writes');
          result = await progress(f,{ planId:f.plan,stepId:'s135',itemId:'i149',status:'done',revision:1 });
          assert.equal(result.state,'updated');assert.equal(result.backlog_revision,2);assert.equal(result.backlog_items_completed,65);
          assert.deepEqual(await writeCounts(),[{ target:'requirements',n:1 }]);
          result = await progress(f,{ planId:f.plan,itemId:'i149',status:'completed',revision:2 });
          assert.equal(result.state,'updated');assert.equal(result.plan_status,'completed');assert.equal(result.backlog_revision,2);
          assert.equal(result.plan_steps_completed,53,'explicit close never fabricates completed steps');
        });

        await check('fences stale owners, tenant mismatches and pauses before progress or messages', async f => {
          const args = { planId:f.plan,stepId:'step',itemId:'item',status:'done',message:'Must not leak through a fence' };
          for (const identity of [{ requirementId:randomUUID() },{ runId:randomUUID() },{ runId:null },
            { executionGeneration:6 },{ executionGeneration:null },{ sessionId:randomUUID() },{ sessionId:null }]) {
            await rejectWithoutProgress(f,{ ...args,...identity },{ state:'stale' });
          }
          const fences = [
            ["UPDATE requirements SET cron_lock_active=false"],
            ["UPDATE requirements SET cron_lock_expires_at=now()-interval '1 second'"],
            ["UPDATE requirements SET cron_lock_expires_at=NULL"],
            ["UPDATE requirements SET status='blocked'"],
            ["UPDATE requirements SET metadata=metadata||'{\"execution_hold\":{\"kind\":\"user_pause\"}}'"],
            ...['customer_paused','user_paused','cron_paused'].map(key=>['UPDATE requirements SET metadata=metadata||$1',[{ [key]:true }]]),
            ["UPDATE requirements SET metadata=metadata||$1",[{ runner_instance_id:randomUUID() }]],
            ["UPDATE harness_requirement_runs SET site_id=$1",[randomUUID()]],
            ["UPDATE harness_requirement_runs SET generation=8"],
            ["UPDATE harness_requirement_runs SET session_id=$1",[randomUUID()]],
            ...['paused','stopped','stopping'].map(status=>['UPDATE remote_instances SET status=$1',[status]]),
            ["UPDATE remote_instances SET is_archived=true"],
            ["UPDATE remote_instances SET site_id=$1",[randomUUID()]],
            ["UPDATE instance_plans SET status='paused'"],
            ["INSERT INTO instance_logs(site_id,instance_id,log_type,trusted_user_action,details) VALUES($1,$2,'user_action',true,'{\"status\":\"running\"}')",[site,f.run.instanceId]],
          ];
          for (const [sql,values=[]] of fences) {
            await db.exec('BEGIN');
            try {
              // harness_requirement_runs has a real site FK.
              if (sql==='UPDATE harness_requirement_runs SET site_id=$1') await db.query('INSERT INTO sites VALUES($1)',values);
              await db.query(sql,values);
              await rejectWithoutProgress(f,args,{ state:'stale' });
            } finally { await db.exec('ROLLBACK'); }
          }
          assert.equal((await progress(f,args)).state,'updated','fences do not add permanent repetition gates');
        });

        await check('keeps plan tenant, runner and requirement scope plus the optional revision check', async f => {
          const args = { planId:f.plan,stepId:'step',itemId:'item',status:'done',message:'Scoped progress' };
          await rejectWithoutProgress(f,{ ...args,revision:9 },{ state:'revision_conflict',backlog_revision:0 });
          await rejectWithoutProgress(f,{ ...args,planId:randomUUID() },{ state:'stale' });
          for (const [sql,values] of [
            ['UPDATE instance_plans SET site_id=$1',[randomUUID()]],
            ['UPDATE instance_plans SET metadata=metadata||$1',[{ requirement_id:randomUUID() }]],
            ['UPDATE instance_plans SET instance_id=$1',[randomUUID()]],
          ]) {
            await db.exec('BEGIN');
            try {
              if (sql==='UPDATE instance_plans SET instance_id=$1') {
                await db.query("INSERT INTO remote_instances(id,site_id,user_id,created_by,name,instance_type,status) VALUES($1,$2,$3,$3,'Other runner','browser','running')",[values[0],site,user]);
              }
              await db.query(sql,values);
              await rejectWithoutProgress(f,args,{ state:'stale' });
            } finally { await db.exec('ROLLBACK'); }
          }
          // The original RPC allowed instance-owned legacy plans without a
          // requirement_id. Do not import the stricter plan-edit RPC semantics.
          await db.exec("UPDATE instance_plans SET metadata=metadata-'requirement_id';UPDATE requirements SET backlog_revision=8");
          await rejectWithoutProgress(f,args,{ state:'revision_conflict',backlog_revision:8 });
          const result = await progress(f,{ ...args,revision:null });
          assert.equal(result.state,'updated');assert.equal(result.backlog_revision,9);
          assert.equal(result.plan_status,'pending');assert.equal(result.item_status,'done');
          await rejectWithoutProgress(f,{ ...args,revision:8 },{ state:'revision_conflict',backlog_revision:9 });
          const again = await progress(f,{ ...args,revision:9 });
          assert.equal(again.state,'unchanged');assert.equal(again.message_recorded,true);
        });

        await check('validates both targets atomically, including duplicate and malformed arrays', async f => {
          const args = { planId:f.plan,stepId:'step',itemId:'item',status:'done',message:'Should not partially commit' };
          await rejectWithoutProgress(f,{ ...args,stepId:'missing' },{ state:'not_found' });
          await rejectWithoutProgress(f,{ ...args,itemId:'missing' },{ state:'not_found' });
          await rejectWithoutProgress(f,{ ...args,stepId:null,itemId:'missing' },{ state:'not_found' });
          for (const steps of [null,{},[f.steps[0],f.steps[0]],[]]) {
            await db.exec('BEGIN');
            try {
              await db.query('UPDATE instance_plans SET steps=$1',[JSON.stringify(steps)]);
              await rejectWithoutProgress(f,args,{ state:'not_found' });
            } finally { await db.exec('ROLLBACK'); }
          }
          for (const backlog of [null,{}, { items:null },{ items:{} },{ items:[] },{ items:[f.backlog.items[0],f.backlog.items[0]] }]) {
            await db.exec('BEGIN');
            try {
              await db.query('UPDATE requirements SET backlog=$1',[JSON.stringify(backlog)]);
              await rejectWithoutProgress(f,args,{ state:'not_found' });
            } finally { await db.exec('ROLLBACK'); }
          }
          await db.query('UPDATE requirements SET backlog=$1',[{ items:[{ id:'item',status:null }] }]);
          await db.query('UPDATE instance_plans SET steps=$1',[JSON.stringify([{ id:'step' }])]);
          receipt(await progress(f,args),{
            state:'updated',status_changed:true,message_recorded:true,backlog_revision:1,
            plan_id:f.plan,plan_status:'pending',step_id:'step',step_status:'completed',item_id:'item',item_status:'done',
            plan_steps_total:1,plan_steps_completed:1,backlog_items_total:1,backlog_items_completed:1 });
          await db.exec("UPDATE requirements SET backlog='{}';UPDATE instance_plans SET steps=NULL");
          receipt(await progress(f,{ planId:f.plan,message:'No arrays',revision:1 }),{
            message_recorded:true,backlog_revision:1,plan_id:f.plan,plan_status:'pending',backlog_items_total:0 });
        });

        await check('retains original validation and accepts every original status after repeated completion', async f => {
          const valid = { planId:f.plan,stepId:'step',itemId:'item',status:'done' };
          for (const args of [{},{ message:'' },{ status:'done' },{ stepId:'step',status:'done' },
            ...['paused','validated','blocked','cancelled','arbitrary'].map(status=>({ ...valid,status })),
            { ...valid,message:'m'.repeat(20001) },{ ...valid,stepId:'s'.repeat(201) },{ ...valid,itemId:'i'.repeat(201) }]) {
            const before = await snapshot();
            await assert.rejects(()=>progress(f,args),/Invalid agent progress patch/);
            assert.deepEqual(await snapshot(),before);
          }
          let revision = 0, previous = 'pending';
          for (const status of ['in_progress','failed','done','completed','pending','failed','in_progress','completed','done']) {
            const canonical = status==='completed'?'done':status;
            const changed = canonical!==previous;
            const result = await progress(f,{ ...valid,status,revision });
            if (changed) revision++;
            assert.equal(result.state,changed?'updated':'unchanged');assert.equal(result.status_changed,changed);
            assert.equal(result.backlog_revision,revision);assert.equal(result.item_status,canonical);
            assert.equal(result.step_status,status==='done'?'completed':status);assert.equal(result.plan_status,'pending');
            previous=canonical;
          }
          const longId = 'x'.repeat(200), message = 'm'.repeat(20000);
          await db.query('UPDATE requirements SET backlog=$1',[{ items:[{ id:longId,status:'pending' }] }]);
          const result = await progress(f,{ itemId:longId,status:'done',message,revision });
          assert.equal(result.state,'updated');assert.equal(result.message_recorded,true);
          assert.equal((await one('SELECT message FROM requirement_status')).message,message);
        });

        await check('preserves quarantine evidence without turning it into a completion gate', async f => {
          const quarantine = { active:true,kind:'verification_exhausted',reason:'Legacy judge',quarantined_at:'2026-09-15T00:00:00Z',external_action_revision:0 };
          const item = { ...f.backlog.items[0],status:'needs_review',review_quarantine:quarantine };
          await db.query('UPDATE requirements SET backlog=$1',[{ items:[item] }]);
          await db.exec('SET ROLE service_role');
          const result = await progress(f,{ itemId:'item',status:'done',message:'Agent claim, not validated acceptance' });
          await db.exec('RESET ROLE');
          assert.equal(result.state,'updated');assert.equal(result.item_status,'done');assert.equal(result.backlog_revision,1);
          const stored = (await one('SELECT backlog FROM requirements')).backlog.items[0];
          assert.deepEqual(stored,{ ...item,status:'done' });
          await assert.rejects(()=>db.query('UPDATE requirements SET backlog=$1',[{ items:[{ ...stored,attempts:0 }] }]),/quarantined/);
          assert.equal((await one('SELECT status FROM requirements')).status,'in-progress');
        });

        console.log(JSON.stringify(passed));
      } finally { await db.close(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline progress receipts SQL test failed');
    passed = JSON.parse(child.stdout.trim());
  }, 65_000);

  it.each([
    'preserves function security and legacy SQL call signatures',
    'completing every step never auto closes; only explicit plan progress closes',
    'partial and empty plans can explicitly complete without quality or repetition gates',
    'unchanged retries retain every message but never rewrite progress or timestamps',
    'message-only calls preserve supplied text and absent targets without status changes',
    'full-array counts ignore previews and cached totals; mixed targets bump only backlog changes',
    'fences stale owners, tenant mismatches and pauses before progress or messages',
    'keeps plan tenant, runner and requirement scope plus the optional revision check',
    'validates both targets atomically, including duplicate and malformed arrays',
    'retains original validation and accepts every original status after repeated completion',
    'preserves quarantine evidence without turning it into a completion gate',
  ])('%s', name => {
    expect(passed).toContain(name);
  });
});