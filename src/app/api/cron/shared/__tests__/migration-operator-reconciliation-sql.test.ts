import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('enforces audited operator reconciliation, one checked resume and the unchanged diagnostic/review boundary in PostgreSQL', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { createHash, randomBytes } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12,'0');
    const req=id(1), instance=id(2), site=id(3), plan=id(4), request=id(5), tenant=id(6);
    const file='migrations/0001.sql', step='implementation';
    const hash = value => createHash('sha256').update(value).digest('hex');
    const privateSql = randomBytes(20).toString('hex'), privateSpec=randomBytes(20).toString('hex');
    const privateReason=randomBytes(20).toString('hex');
    const sql='SELECT 1; -- ' + privateSql, specification='Canonical current specification \n café 🧪 ' + privateSpec;
    const oldSpec=hash('Prior canonical specification'), checksum=hash(sql), currentSpec=hash(specification);
    const legacy='A pending migration has no requirement-bound implementation plan; technical review is required.';
    const one=async(q,args=[]) => (await db.query(q,args)).rows[0];
    const role=async(name,fn)=>{ await db.exec('SET ROLE '+name); try { return await fn(); } finally { await db.exec('RESET ROLE').catch(()=>{}); } };
    const rpc=(name,args)=>role('service_role',async()=> (await one('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS value',args)).value);
    const snapshot=async()=>{
      const result={};
      for (const table of ['requirements','remote_instances','instance_plans','requirement_migration_lifecycle',
        'requirement_migration_diagnostics','requirement_migration_reconciliations',
        'requirement_migration_reconciliation_resumes','instance_logs','requirement_status'])
        result[table]=(await db.query('SELECT to_jsonb(t) AS value FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows;
      return result;
    };
    const lifecycle=async()=> (await one('SELECT to_jsonb(t) AS v FROM requirement_migration_lifecycle t WHERE requirement_id=$1 AND file=$2',[req,file])).v;
    const requirement=async()=> (await one('SELECT to_jsonb(t) AS v FROM requirements t WHERE id=$1',[req])).v;
    const evidence=()=>({apps_project_ref:'abcdefghijklmnopqrst',tenant_id:tenant,
      schema:'app_'+req.replaceAll('-','').slice(0,24),observed_at:new Date().toISOString(),
      sql_checksum:checksum,receipt_found:false,sandbox_name:'req-'+req.slice(0,8)+'-'+instance.slice(0,8),
      specification_checksum:currentSpec});
    const item={id:'db',status:'pending',attempts:2,tier:'core',depends_on:['done'],blocked_by:[],
      tool_failures:{judge:1},review_quarantine:{active:false,kind:'manual',released_at:'2026-09-30T00:00:00Z'}};
    const pending={id:step,status:'pending',requires_sandbox:true,backlog_item_id:'db',retry_count:3,infra_retry_count:2};
    let args;
    const reconcile=(overrides={})=>rpc('reconcile_requirement_migration',args.map((v,i)=>Object.hasOwn(overrides,i)?overrides[i]:v));
    const resume=(r=req,receipt=request,e=evidence())=>rpc('resume_reconciled_requirement_migration',[r,receipt,e]);
    const rejected=async(fn,code)=>{
      const before=await snapshot();
      await db.exec('SAVEPOINT expected_rejection');
      await assert.rejects(fn,e=>{ assert.equal(e.code,code,e.message); return true; });
      await db.exec('ROLLBACK TO SAVEPOINT expected_rejection; RELEASE SAVEPOINT expected_rejection');
      assert.deepEqual(await snapshot(),before,'rejection must have no side effects');
    };
    const updateItem=patch=>db.query("UPDATE requirements SET backlog=jsonb_set(backlog,'{items,0}', $1)",[ {...item,...patch} ]);
    const updateStep=patch=>db.query('UPDATE instance_plans SET steps=$1 WHERE id=$2',[[{...pending,...patch}],plan]);
    const updateMetadata=patch=>db.query('UPDATE requirements SET metadata=metadata || $1 WHERE id=$2',[patch,req]);
    const seed=async()=>{
      await db.query('INSERT INTO requirements(id,site_id,status,metadata,instructions,backlog,backlog_revision) VALUES($1,$2,$3,$4,$5,$6,11)',
        [req,site,'blocked',{runner_instance_id:instance,requirement_execution_generation:7,cron_failures:4,
          cron_attempts:22,no_progress_cycles:3,infrastructure_retries:9},specification,
          {items:[item,{id:'done',status:'done',attempts:3}],cycles_spent_total:123,total_attempts:19}]);
      await db.query('INSERT INTO remote_instances(id,site_id,status,is_archived) VALUES($1,$2,$3,false)',[instance,site,'pending']);
      // Real visibility trigger runs before the replacement pending plan exists,
      // matching the historical missing-plan hold rather than bypassing it.
      await db.query('INSERT INTO requirement_migration_lifecycle(requirement_id,file,version,state,checksum,specification_checksum,original_sql,reason,review,attempts) VALUES($1,$2,12,$3,$4,$5,$6,$7,$8,5)',
        [req,file,'platform_review',checksum,oldSpec,sql,legacy,{decision:'request_changes',reason:'Prior review rejected SQL'}]);
      await db.query('INSERT INTO instance_plans(id,instance_id,site_id,status,metadata,steps,instructions,retry_count) VALUES($1,$2,$3,$4,$5,$6,$7,4)',
        [plan,instance,site,'pending',{requirement_id:req},[pending],'Existing accepted plan instructions']);
      const r=await requirement();
      args=[req,file,12,7,r.updated_at,11,instance,plan,step,request,'offline-operator','Operator evidence: '+privateReason,evidence()];
    };
    const check=async(name,fn)=>{
      await db.exec('BEGIN');
      try { await seed(); await fn(); console.log(name); }
      finally { await db.exec('ROLLBACK; RESET ROLE'); }
    };
    try {
      await db.exec("SET TIME ZONE 'UTC'; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;"+
        "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,status text,metadata jsonb,instructions text,backlog jsonb,backlog_revision bigint,cron_lock_active boolean DEFAULT false,cron_lock_expires_at timestamptz,cron_lock_run_id text,updated_at timestamptz DEFAULT clock_timestamp());"+
        "CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,status text,is_archived boolean DEFAULT false,updated_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,status text,metadata jsonb,steps jsonb,instructions text,retry_count integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL,instance_id uuid NOT NULL,log_type text NOT NULL CHECK(log_type IN ('system','user_action','agent_action','tool_call','tool_result','error','performance','thinking','infrastructure')),level text,message text NOT NULL,details jsonb,created_at timestamptz DEFAULT now());"+
        "CREATE TABLE requirement_status(requirement_id uuid,site_id uuid,instance_id uuid,stage text CHECK(stage IN ('pending','in-progress','on-review','completed','done','failed','blocked','paused','cancelled','backlog','validated','needs_review')),message text);"+
        "CREATE FUNCTION assert_requirement_cron_execution_owner(uuid,text,integer,boolean,boolean) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('current',EXISTS(SELECT 1 FROM public.requirements WHERE id=$1 AND cron_lock_active AND cron_lock_run_id=$2 AND metadata->>'requirement_execution_generation'=$3::text)) $$;");
      for (const name of ['20260930010000_requirement_migration_lifecycle.sql','20261001053000_migration_diagnostic_handoff.sql','20261001190500_migration_hold_visibility.sql'])
        await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
      const ordinaryBefore=await one("SELECT pg_get_functiondef('transition_requirement_migration(uuid,text,integer,integer,jsonb)'::regprocedure) AS definition");
      // Catch accidental reliance on benign default ACLs (including PUBLIC).
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role;');
      await db.exec(readFileSync('supabase/migrations/20261002010000_migration_operator_reconciliation.sql','utf8'));
      const upgrade=readFileSync('supabase/migrations/20261002020000_migration_reconciliation_fresh_resume.sql','utf8');
      const names=[['lock_migration_reconciliation_scope','uuid,text,uuid,uuid,text,integer,bigint'],
        ['reconcile_requirement_migration','uuid,text,integer,integer,timestamptz,bigint,uuid,uuid,text,uuid,text,text,jsonb'],
        ['resume_reconciled_requirement_migration','uuid,uuid,jsonb']];
      const definitions=async()=>Promise.all(names.map(async([name,types])=>(await one('SELECT pg_get_functiondef($1::regprocedure) AS v',[name+'('+types+')'])).v));
      const canonical=await definitions();
      await db.exec(upgrade); // Fresh canonical installation converges too.
      assert.deepEqual(await definitions(),canonical);
      // Simulate the observed unused production draft: no evidence column and
      // the obsolete two-argument overload. No historical receipt is removed.
      await db.exec('ALTER TABLE requirement_migration_reconciliation_resumes DROP COLUMN evidence');
      await db.exec('CREATE FUNCTION resume_reconciled_requirement_migration(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object(\'draft\',true) $$; GRANT EXECUTE ON FUNCTION resume_reconciled_requirement_migration(uuid,uuid) TO service_role;');
      await db.exec(upgrade);
      assert.deepEqual(await definitions(),canonical);
      assert.equal((await one("SELECT to_regprocedure('resume_reconciled_requirement_migration(uuid,uuid)') AS v")).v,null);
      assert.deepEqual(await one("SELECT pg_get_functiondef('transition_requirement_migration(uuid,text,integer,integer,jsonb)'::regprocedure) AS definition"),ordinaryBefore);

      await check('ACLs and actual RLS protect append-only receipts and private helpers',async()=>{
        const sig='reconcile_requirement_migration(uuid,text,integer,integer,timestamptz,bigint,uuid,uuid,text,uuid,text,text,jsonb)';
        for(const who of ['anon','authenticated','service_role']) {
          for(const name of [sig,'resume_reconciled_requirement_migration(uuid,uuid,jsonb)'])
            assert.equal((await one('SELECT has_function_privilege($1,$2,$3) AS ok',[who,name,'EXECUTE'])).ok,who==='service_role');
          for(const name of ['lock_migration_reconciliation_scope(uuid,text,uuid,uuid,text,integer,bigint)',
            'reject_migration_reconciliation_mutation()','guard_pending_migration_reconciliation()'])
            assert.equal((await one('SELECT has_function_privilege($1,$2,$3) AS ok',[who,name,'EXECUTE'])).ok,false);
          for(const table of ['requirement_migration_reconciliations','requirement_migration_reconciliation_resumes']) {
            for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
              assert.equal((await one('SELECT has_table_privilege($1,$2,$3) AS ok',[who,table,privilege])).ok,false);
          }
        }
        for(const who of ['anon','authenticated']) {
          await rejected(()=>role(who,()=>db.query('SELECT resume_reconciled_requirement_migration($1,$2,$3)',[req,request,evidence()])),'42501');
          await rejected(()=>role(who,()=>db.query('SELECT reconcile_requirement_migration('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args)),'42501');
          await rejected(()=>role(who,()=>db.query('SELECT * FROM requirement_migration_reconciliations')),'42501');
        }
        await reconcile(); await resume();
        for(const table of ['requirement_migration_reconciliations','requirement_migration_reconciliation_resumes']) {
          assert.equal((await role('service_role',()=>one('SELECT count(*)::int AS n FROM '+table))).n,1);
          for(const statement of ['DELETE FROM '+table,'TRUNCATE '+table,'UPDATE '+table+' SET created_at=now()','INSERT INTO '+table+' SELECT * FROM '+table])
            await rejected(()=>role('service_role',()=>db.exec(statement)),'42501');
          for(const statement of ['DELETE FROM '+table,'TRUNCATE '+table+' CASCADE','UPDATE '+table+' SET created_at=now()'])
            await rejected(()=>db.exec(statement),'23514');
          await db.exec('GRANT SELECT ON '+table+' TO authenticated');
          assert.equal((await role('authenticated',()=>one('SELECT count(*)::int AS n FROM '+table))).n,0,'RLS, not only ACL, hides receipts');
        }
        await db.exec('ALTER ROLE service_role BYPASSRLS');
        await rejected(()=>role('service_role',()=>db.exec('DELETE FROM requirement_migration_reconciliations')),'42501');
      });

      await check('full immutable provenance and counters survive reconciliation without resume',async()=>{
        const before=await snapshot(), prior=await lifecycle(), r=await requirement();
        const result=await reconcile(), row=await lifecycle();
        assert.deepEqual(result,{receipt_id:request,lifecycle:row,resumed:false});
        assert.equal(row.version,13); assert.equal(row.state,'correction_required'); assert.equal(row.review,null);
        assert.equal(row.specification_checksum,currentSpec); assert.equal(row.checksum,checksum);
        assert.equal(row.original_sql,sql); assert.equal(row.attempts,5);
        const receipt=(await one('SELECT to_jsonb(t) v FROM requirement_migration_reconciliations t')).v;
        assert.deepEqual(receipt.prior_lifecycle,prior); assert.equal(receipt.specification,specification);
        assert.deepEqual(receipt.evidence,args[12]); assert.deepEqual(receipt.lifecycle,row);
        assert.equal(receipt.reason,args[11]); assert.equal(receipt.execution_generation,7);
        const expected={...r,metadata:{...r.metadata}}; delete expected.metadata.execution_hold;
        assert.deepEqual(await requirement(),expected);
        const after=await snapshot();
        for(const key of ['remote_instances','instance_plans','requirement_migration_diagnostics']) assert.deepEqual(after[key],before[key]);
        assert.equal(after.requirement_migration_reconciliation_resumes.length,0);
        const publicText=JSON.stringify([after.instance_logs,after.requirement_status,(await requirement()).metadata]);
        for(const sensitive of [privateSql,privateSpec,privateReason]) assert.equal(publicText.includes(sensitive),false);
        const log=after.instance_logs[0].value;
        assert.equal(log.details.receipt_found,false); assert.equal(log.details.prior_specification_checksum,oldSpec);
        assert.equal(log.details.event,'migration_operator_reconciliation');
      });

      await check('forward upgrade refuses used draft receipts rather than inventing remote evidence',async()=>{
        await reconcile(); await resume();
        await db.exec('ALTER TABLE requirement_migration_reconciliation_resumes DROP COLUMN evidence');
        await assert.rejects(()=>db.exec(upgrade),e=>e.message.includes('do not fabricate evidence'));
        // Upgrade aborts its enclosing fixture transaction. check() rolls it back;
        // other scenarios start from the fully upgraded canonical schema.
      });

      await check('exact replays return frozen receipts; changed arguments and request IDs cannot retry',async()=>{
        const result=await reconcile();
        await db.exec("UPDATE requirement_migration_lifecycle SET reason='Later worker state',version=14; UPDATE remote_instances SET status='paused';");
        const before=await snapshot();
        assert.deepEqual(await reconcile(),result); assert.deepEqual(await snapshot(),before);
        for(const [index,value] of [[0,id(99)],[1,'migrations/other.sql'],[2,11],[3,8],[4,'2026-01-01T00:00:00Z'],[5,12],[6,id(8)],
          [7,id(9)],[8,'other'],[10,'other-operator'],[11,'different reason'],[12,{...args[12],observed_at:'2026-01-01T00:00:00Z'}]])
          await rejected(()=>reconcile({[index]:value}),'23505');
        await rejected(()=>reconcile({9:id(7)}),'23505');
      });

      await check('CAS, metadata and canonical specification mismatches fail closed',async()=>{
        for(const overrides of [{2:11},{3:8},{4:'2026-01-01T00:00:00Z'},{5:12}]) await rejected(()=>reconcile(overrides),'40001');
        for(const value of [-1,2147483647]) await rejected(()=>reconcile({3:value}),'22023');
        for(const overrides of [{0:null},{2:0},{5:-1},{4:'infinity'},{8:' '},{8:'s'.repeat(201)},
          {10:'\n\t'},{10:'o'.repeat(201)},{11:' '},{11:'r'.repeat(2001)},{12:null},
          {1:'migrations/../0001.sql'},{1:file+'\n'},{1:'supabase/migrations/0001.sql'}])
          await rejected(()=>reconcile(overrides),'22023');
        for(const value of [null,[],{},'7.0','-1']) {
          await updateMetadata({requirement_execution_generation:value}); await rejected(()=>reconcile(),'22023');
        }
        await updateMetadata({requirement_execution_generation:7});
        for(const instructions of [null,'','\n\t  ','x'.repeat(65537)]) {
          await db.query('UPDATE requirements SET instructions=$1',[instructions]); await rejected(()=>reconcile(),'23514');
        }
        await db.query('UPDATE requirements SET instructions=$1',[specification+' changed']); await rejected(()=>reconcile(),'22023');
        await db.query('UPDATE requirements SET instructions=$1',[specification]);
        await db.query('UPDATE requirement_migration_lifecycle SET specification_checksum=$1',[currentSpec]);
        await db.exec("UPDATE instance_plans SET status='pending'"); await updateStep({}); args[4]=(await requirement()).updated_at;
        await rejected(()=>reconcile(),'23514');
      });

      await check('strict typed fresh evidence binds schema, sandbox and both checksums',async()=>{
        const invalid=[{extra:true},{tenant_id:'not-a-uuid'},{schema:'app_'+'f'.repeat(24)},{schema:'public'},
          {apps_project_ref:'bad-project'},{receipt_found:true},{receipt_found:'false'},{sandbox_name:'another-sandbox'},
          {sql_checksum:'a'.repeat(64)},{specification_checksum:oldSpec},{observed_at:'infinity'},
          {observed_at:'2026-13-40T00:00:00Z'},{observed_at:123},{tenant_id:null}];
        for(const patch of invalid) await rejected(()=>reconcile({12:{...args[12],...patch}}),'22023');
        for(const key of Object.keys(args[12])) { const e={...args[12]}; delete e[key]; await rejected(()=>reconcile({12:e}),'22023'); }
        for(const offset of [-301000,31000]) await rejected(()=>reconcile({12:{...args[12],observed_at:new Date(Date.now()+offset).toISOString()}}),'40001');
        // A different well-formed tenant UUID is not locally provable: service_role
        // is the attestor; remote registry verification belongs to the host tests.
        const e={...args[12],tenant_id:id(90)};
        await reconcile({12:e}); assert.deepEqual((await one('SELECT evidence FROM requirement_migration_reconciliations')).evidence,e);
      });

      await check('only the exact exhausted legacy hold with no approval can reconcile',async()=>{
        for(const state of ['correction_required','reviewing','validation_pending','validated']) {
          await db.query('UPDATE requirement_migration_lifecycle SET state=$1',[state]); await rejected(()=>reconcile(),'23514');
        }
        await db.query('UPDATE requirement_migration_lifecycle SET state=$1',['platform_review']);
        // Re-publishing the hold blocks plans and changes the requirement CAS.
        await db.exec("UPDATE instance_plans SET status='pending'"); await updateStep({}); args[4]=(await requirement()).updated_at;
        for(const review of [{decision:'approved_for_validation'},{decision:'request_changes',binding:null},
          {decision:'request_changes',diagnostic_id:id(70)},{decision:'request_changes',reason:{decision:'approved_for_validation'}},
          {decision:'platform_review'},'request_changes',{}]) {
          await db.query('UPDATE requirement_migration_lifecycle SET review=$1',[JSON.stringify(review)]);
          await db.exec("UPDATE instance_plans SET status='pending'"); await updateStep({}); args[4]=(await requirement()).updated_at;
          await rejected(()=>reconcile(),'23514');
        }
        await db.query('UPDATE requirement_migration_lifecycle SET review=NULL,attempts=4');
        await db.exec("UPDATE instance_plans SET status='pending'"); await updateStep({}); args[4]=(await requirement()).updated_at;
        await rejected(()=>reconcile(),'23514');
        await db.query('UPDATE requirement_migration_lifecycle SET attempts=5,reason=$1',['Other platform hold']);
        await db.exec("UPDATE instance_plans SET status='pending'"); await updateStep({}); args[4]=(await requirement()).updated_at;
        await rejected(()=>reconcile(),'23514');
      });

      await check('only explicit audited resume opens the reconciliation gap, not ordinary status or user RPCs',async()=>{
        await reconcile();
        await db.exec("CREATE FUNCTION fixture_generic_resume(uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ UPDATE public.requirements SET status='in-progress',metadata=metadata||jsonb_build_object('cron_attempts',0) WHERE id=$1 $$; GRANT EXECUTE ON FUNCTION fixture_generic_resume(uuid) TO authenticated");
        for(const status of ['in-progress','backlog','pending','done','on-review'])
          await rejected(()=>db.query('UPDATE requirements SET status=$1',[status]),'23514');
        await rejected(()=>role('authenticated',()=>db.query('SELECT fixture_generic_resume($1)',[req])),'23514');
        await db.exec("CREATE FUNCTION fixture_hidden_resume() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'hidden_resume'='true' THEN NEW.status='in-progress'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_hidden_resume BEFORE UPDATE ON requirements FOR EACH ROW EXECUTE FUNCTION fixture_hidden_resume()");
        await rejected(()=>updateMetadata({hidden_resume:true}),'23514');
        await db.exec("UPDATE requirements SET status='paused'"); await rejected(()=>resume(),'40001');
        await db.exec("UPDATE requirements SET status='blocked'"); await resume();
      });

      await check('every prior diagnostic including consumed/exhausted is permanent and forbids recovery',async()=>{
        for(const state of ['running','followup_ready','followup_assigned','followup_reviewing','exhausted']) {
          await db.query('INSERT INTO requirement_migration_diagnostics(requirement_id,file,execution_generation,state,checksum,specification_checksum) VALUES($1,$2,7,$3,$4,$5)',[req,file,state,checksum,oldSpec]);
          await rejected(()=>reconcile(),'23514');
          await db.query('DELETE FROM requirement_migration_diagnostics');
        }
      });

      await check('idle ownership, manual pauses, scoped plan and exact pending sandbox step are mandatory',async()=>{
        // No future lease, even if its active bit is false. No active bit even
        // if its timestamp is expired. Neither is cleaned up by reconciliation.
        await db.exec('UPDATE requirements SET cron_lock_active=true'); await rejected(()=>reconcile(),'40001');
        await db.exec("UPDATE requirements SET cron_lock_active=false,cron_lock_expires_at=clock_timestamp()+interval '1 hour'"); await rejected(()=>reconcile(),'40001');
        await db.exec('UPDATE requirements SET cron_lock_expires_at=NULL');
        // Existing platform-review status guard itself prevents reopening; use
        // blocked -> cancelled only after the fixture temporarily removes hold.
        await db.exec("ALTER TABLE requirements DISABLE TRIGGER requirement_migration_status_guard");
        for(const status of ['in-progress','backlog','paused','done','cancelled']) {
          await db.query('UPDATE requirements SET status=$1',[status]); await rejected(()=>reconcile(),'40001');
        }
        await db.exec("UPDATE requirements SET status='blocked'; ALTER TABLE requirements ENABLE TRIGGER requirement_migration_status_guard");
        await updateMetadata({runner_instance_id:id(99)}); await rejected(()=>reconcile(),'40001'); await updateMetadata({runner_instance_id:instance});
        for(const status of ['paused','stopping','stopped','starting','error']) {
          await db.query('UPDATE remote_instances SET status=$1',[status]); await rejected(()=>reconcile(),'40001');
        }
        await db.exec("UPDATE remote_instances SET status='pending',is_archived=true"); await rejected(()=>reconcile(),'40001');
        await db.query('UPDATE remote_instances SET is_archived=false,site_id=$1',[id(99)]); await rejected(()=>reconcile(),'40001');
        await db.query('UPDATE remote_instances SET site_id=$1',[site]);
        for(const status of ['paused','blocked','completed','failed','cancelled']) {
          await db.query('UPDATE instance_plans SET status=$1',[status]); await rejected(()=>reconcile(),'40001');
        }
        await db.exec("UPDATE instance_plans SET status='pending'");
        for(const [field,value] of [['site_id',id(99)],['instance_id',id(99)]]) {
          await db.query('UPDATE instance_plans SET '+field+'=$1',[value]); await rejected(()=>reconcile(),'40001');
          await db.query('UPDATE instance_plans SET '+field+'=$1',[field==='site_id'?site:instance]);
        }
        await db.query('UPDATE instance_plans SET metadata=$1',[{requirement_id:id(99)}]); await rejected(()=>reconcile(),'40001');
        await db.query('UPDATE instance_plans SET metadata=$1',[{requirement_id:req}]);
        for(const patch of [{status:'in_progress'},{status:'completed'},{requires_sandbox:false},{requires_sandbox:'true'},
          {backlog_item_id:'missing'},{metadata:{backlog_item_id:'other'}},{infrastructure_circuit_open:true},
          {infrastructure_state:'backoff'},{infra_retry_count:4}]) {
          await updateStep(patch); await rejected(()=>reconcile(),'23514');
        }
        for(const key of ['migration_correction_key','migration_diagnostic_token','migration_diagnostic_file',
          'migration_correction_run_id','migration_correction_files','repair_run','repair_source_step_id']) {
          await updateStep({metadata:{[key]:null}}); await rejected(()=>reconcile(),'23514');
        }
        for(const steps of [[],[pending,pending],[pending,{id:'other',status:'pending'}],[pending,{id:'other',status:'in_progress'}],
          [pending,{id:'later',status:'completed'}],[pending,{id:'later',status:'cancelled'}]]) {
          await db.query('UPDATE instance_plans SET steps=$1',[steps]); await rejected(()=>reconcile(),'23514');
        }
        await updateStep({});
        for(const status of ['pending','in_progress','active','paused','blocked','completed']) {
          await db.query('INSERT INTO instance_plans(id,instance_id,site_id,status,metadata,steps) VALUES($1,$2,$3,$4,$5,$6)',
            [id(90),instance,site,status,{requirement_id:id(99)},[{id:'competing',status:'pending'}]]);
          await rejected(()=>reconcile(),'40001'); await db.query('DELETE FROM instance_plans WHERE id=$1',[id(90)]);
        }
        // Historical fully terminal plan is not competing work.
        await db.query('INSERT INTO instance_plans(id,instance_id,site_id,status,metadata,steps) VALUES($1,$2,$3,$4,$5,$6)',
          [id(90),instance,site,'completed',{requirement_id:req},[{id:'history',status:'completed'}]]);
        await db.query('UPDATE instance_plans SET steps=$1 WHERE id=$2',[[{id:'previous',status:'completed'},pending],plan]);
        await reconcile();
      });

      await check('backlog budget, direct blockers, quarantine, dependencies and cancellation cannot be reset',async()=>{
        for(const patch of [{status:'done'},{status:'needs_review'},{attempts:4},{attempts:2,tier:'ornamental'},
          {attempts:null},{blocked_by:[{category:'user_decision'}]},{blocked_by:[{category:'dependency'}]},
          {review_quarantine:{active:true}},{plan_cancellation_pending:{reason:'cancel'}},{depends_on:['missing']}]) {
          await updateItem(patch); await rejected(()=>reconcile(),'23514');
        }
        await updateItem({});
        for(const hold of [{kind:'infrastructure'},null,{kind:'migration_platform_review',file:'migrations/other.sql'}]) {
          await updateMetadata({execution_hold:hold}); await rejected(()=>reconcile(),'23514');
        }
        await db.exec("UPDATE requirements SET metadata=metadata-'execution_hold'");
        await updateMetadata({cron_blocker_provenance:'product_no_progress_circuit'}); await rejected(()=>reconcile(),'23514');
        await db.exec("UPDATE requirements SET metadata=metadata-'cron_blocker_provenance'");
        // The legacy incident may predate the hold visibility projection.
        await reconcile(); assert.equal((await requirement()).backlog.items[0].attempts,2);
      });

      await check('other unresolved migrations deny reconciliation; null review legacy snapshots remain eligible',async()=>{
        for(const state of ['correction_required','reviewing','validation_pending']) {
          await db.query('INSERT INTO requirement_migration_lifecycle(requirement_id,file,version,state,checksum,specification_checksum,reason,attempts) VALUES($1,$2,1,$3,$4,$5,$6,1)',
            [req,'migrations/other.sql',state,checksum,oldSpec,'Unresolved']);
          await rejected(()=>reconcile(),'23514');
          await db.query('DELETE FROM requirement_migration_lifecycle WHERE file=$1',['migrations/other.sql']);
        }
        await db.exec('UPDATE requirement_migration_lifecycle SET review=NULL');
        await db.exec("UPDATE instance_plans SET status='pending'"); await updateStep({}); args[4]=(await requirement()).updated_at;
        await reconcile();
        assert.equal((await one('SELECT prior_lifecycle FROM requirement_migration_reconciliations')).prior_lifecycle.review,null);
      });

      await check('reconciliation and resume roll back receipts, lifecycle, visibility and generation on any audit failure',async()=>{
        await db.exec("CREATE FUNCTION fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline audit unavailable'; END $$;");
        for(const table of ['instance_logs','requirement_status']) {
          await db.exec('CREATE TRIGGER fixture_fail BEFORE INSERT ON '+table+' FOR EACH ROW EXECUTE FUNCTION fixture_fail_audit()');
          await rejected(()=>reconcile(),'P0001');
          await db.exec('DROP TRIGGER fixture_fail ON '+table);
        }
        await reconcile();
        for(const table of ['requirement_migration_reconciliation_resumes','instance_logs','requirement_status']) {
          await db.exec('CREATE TRIGGER fixture_fail BEFORE INSERT ON '+table+' FOR EACH ROW EXECUTE FUNCTION fixture_fail_audit()');
          await rejected(()=>resume(),'P0001');
          await db.exec('DROP TRIGGER fixture_fail ON '+table);
        }
        assert.equal((await requirement()).metadata.requirement_execution_generation,7);
        await resume();
      });

      await check('resume checks current scope again and never releases competing holds',async()=>{
        await reconcile();
        await rejected(()=>resume(id(99)),'P0002'); await rejected(()=>resume(req,id(99)),'P0002');
        assert.equal((await one("SELECT to_regprocedure('resume_reconciled_requirement_migration(uuid,uuid)') IS NULL AS absent")).absent,true);
        for(const patch of [{tenant_id:id(99)},{sql_checksum:oldSpec},{specification_checksum:oldSpec},{schema:'public'},
          {apps_project_ref:'zyxwvutsrqponmlkjihg'},{sandbox_name:'wrong'},{receipt_found:true},{receipt_found:'false'},
          {observed_at:'infinity'},{observed_at:'2026-13-99T00:00:00Z'},{observed_at:null},{extra:'untrusted'}])
          await rejected(()=>resume(req,request,{...evidence(),...patch}),'22023');
        for(const e of [null,{},[]]) await rejected(()=>resume(req,request,e),'22023');
        for(const offset of [-301000,31000])
          await rejected(()=>resume(req,request,{...evidence(),observed_at:new Date(Date.now()+offset).toISOString()}),'40001');
        await db.exec('UPDATE requirements SET cron_lock_active=true'); await rejected(()=>resume(),'40001');
        await db.exec('UPDATE requirements SET cron_lock_active=false,backlog_revision=12'); await rejected(()=>resume(),'40001');
        await db.exec('UPDATE requirements SET backlog_revision=11');
        await updateMetadata({requirement_execution_generation:8}); await rejected(()=>resume(),'40001');
        await updateMetadata({requirement_execution_generation:7,runner_instance_id:id(99)}); await rejected(()=>resume(),'40001');
        await updateMetadata({runner_instance_id:instance});
        await db.query('UPDATE requirements SET instructions=$1',[specification+' changed']); await rejected(()=>resume(),'40001');
        await db.query('UPDATE requirements SET instructions=$1',[specification]);
        await db.exec("UPDATE remote_instances SET status='paused'"); await rejected(()=>resume(),'40001');
        await db.exec("UPDATE remote_instances SET status='pending'; UPDATE instance_plans SET status='paused'"); await rejected(()=>resume(),'40001');
        await db.exec("UPDATE instance_plans SET status='pending'");
        await updateStep({status:'in_progress'}); await rejected(()=>resume(),'23514'); await updateStep({});
        await updateItem({blocked_by:[{category:'dependency'}]}); await rejected(()=>resume(),'23514'); await updateItem({});
        await db.query('INSERT INTO requirement_migration_diagnostics(requirement_id,file,execution_generation,state,checksum,specification_checksum) VALUES($1,$2,7,$3,$4,$5)',[req,file,'followup_reviewing',checksum,currentSpec]);
        await rejected(()=>resume(),'23514'); await db.exec('DELETE FROM requirement_migration_diagnostics');
        const frozen=await lifecycle();
        for(const patch of [{version:14},{state:'reviewing'},{specification_checksum:oldSpec},{checksum:'a'.repeat(64)},{review:{decision:'approved_for_validation'}}]) {
          const [key,value]=Object.entries(patch)[0];
          await db.query('UPDATE requirement_migration_lifecycle SET '+key+'=$1',[value]); await rejected(()=>resume(),'40001');
          await db.query('UPDATE requirement_migration_lifecycle SET '+key+'=$1',[frozen[key]]);
        }
        for(const hold of [{kind:'manual'}, {kind:'migration_platform_review',file}]) {
          await updateMetadata({execution_hold:hold}); await rejected(()=>resume(),'23514');
        }
        await db.exec("UPDATE requirements SET metadata=metadata-'execution_hold'");
        await updateMetadata({cron_blocker_provenance:'infrastructure'}); await rejected(()=>resume(),'23514');
        await db.exec("UPDATE requirements SET metadata=metadata-'cron_blocker_provenance'");
        for(const otherState of ['correction_required','reviewing','validation_pending']) {
          await db.query('INSERT INTO requirement_migration_lifecycle(requirement_id,file,version,state,checksum,specification_checksum,reason,attempts) VALUES($1,$2,1,$3,$4,$5,$6,1)',[req,'migrations/0002.sql',otherState,checksum,currentSpec,'Other migration']);
          await rejected(()=>resume(),'23514'); await db.query('DELETE FROM requirement_migration_lifecycle WHERE file=$1',['migrations/0002.sql']);
        }
        for(const other of [{id:'other',status:'pending',blocked_by:[{category:'user_decision',resolution_actor:'user'}]},
          {id:'other',status:'pending',review_quarantine:{active:true}},
          {id:'other',status:'pending',blocked_by:[{category:'dependency',resolution_actor:'platform'}]}]) {
          await db.query("UPDATE requirements SET backlog=jsonb_set(backlog,'{items,2}',$1)",[other]); await rejected(()=>resume(),'23514');
        }
      });

      await check('successful resume preserves downstream dependencies and every budget; replay never reopens a later pause',async()=>{
        const downstream={id:'downstream',status:'pending',attempts:0,depends_on:['db'],blocked_by:[
          {category:'dependency',resolution_actor:'executor',source_item_id:'db',reason:'Waiting for schema',user_action_required:false}]};
        await db.query("UPDATE requirements SET backlog=jsonb_set(backlog,'{items,2}',$1)",[downstream]);
        const reconciled=await reconcile(), before=await snapshot(), r=await requirement();
        const result=await resume();
        assert.deepEqual(result,{receipt_id:request,resumed:true,execution_generation:8});
        const resumeReceipt=await one('SELECT evidence FROM requirement_migration_reconciliation_resumes');
        assert.equal(resumeReceipt.evidence.receipt_found,false); assert.equal(resumeReceipt.evidence.specification_checksum,currentSpec);
        const after=await snapshot(), current=await requirement();
        assert.deepEqual({...current,updated_at:r.updated_at,status:r.status,
          metadata:{...current.metadata,requirement_execution_generation:7}},r);
        assert.equal(current.status,'in-progress'); assert.equal(current.metadata.requirement_execution_generation,8);
        for(const key of ['remote_instances','instance_plans','requirement_migration_lifecycle','requirement_migration_diagnostics','requirement_migration_reconciliations'])
          assert.deepEqual(after[key],before[key]);
        await db.exec("UPDATE requirements SET status='blocked'; UPDATE remote_instances SET status='paused'; UPDATE instance_plans SET status='paused'");
        const paused=await snapshot();
        assert.deepEqual(await resume(),result); assert.deepEqual(await resume(req,request,null),result);
        assert.deepEqual(await reconcile(),reconciled); assert.deepEqual(await snapshot(),paused);
        await rejected(()=>reconcile({9:id(99)}),'23505');
      });

      await check('fresh independent diagnostic, changed SQL, review and validation remain mandatory at attempts five',async()=>{
        await reconcile(); await resume();
        const value=(state,extra={})=>({state,checksum,specification_checksum:currentSpec,original_sql:sql,reason:'Fresh review',attempts:5,...extra});
        const transition=(version,state,extra={})=>rpc('transition_requirement_migration',[req,file,version,8,value(state,extra)]);
        await rejected(()=>db.exec("UPDATE requirements SET status='done'"),'23514');
        await rejected(()=>transition(13,'validated'),'23514');
        await rejected(()=>transition(13,'validation_pending'),'23514');
        await rejected(()=>transition(13,'reviewing'),'23514');
        await rejected(()=>transition(13,'correction_required',{attempts:0}),'23514');
        await rejected(()=>transition(13,'correction_required',{specification_checksum:oldSpec}),'23514');
        const changed=hash('SELECT 2;'), reviewing=value('reviewing',{checksum:changed,review:{decision:'approved_for_validation'}});
        await rejected(()=>rpc('begin_migration_diagnostic_review',[req,file,13,8,reviewing]),'40001');
        await db.exec("UPDATE requirements SET cron_lock_active=true,cron_lock_run_id='offline-run'");
        const claim=await rpc('claim_migration_diagnostic',[req,file,13,8,'offline-run']);
        assert.equal(claim.specification_checksum,currentSpec);
        assert.equal(await rpc('claim_migration_diagnostic',[req,file,13,8,'offline-run']),null);
        await rpc('complete_migration_diagnostic',[req,file,claim.token,8,'offline-run',
          {decision:'repair_candidate',hypothesis:'SQL differs from current canonical contract',instruction:'Materialize correction',verification:'Fresh central review',evidence:[{kind:'schema',observed:'offline only'}]}]);
        await rpc('assign_migration_diagnostic_followup',[req,file,claim.token,8,'offline-run']);
        await rejected(()=>rpc('begin_migration_diagnostic_review',[req,file,13,8,value('reviewing')]),'23514');
        await rejected(()=>rpc('begin_migration_diagnostic_review',[req,file,13,8,{...reviewing,specification_checksum:oldSpec}]),'23514');
        await rejected(()=>rpc('begin_migration_diagnostic_review',[req,file,13,8,{...reviewing,original_sql:'SELECT replaced;'}]),'23514');
        const fresh=await rpc('begin_migration_diagnostic_review',[req,file,13,8,reviewing]);
        assert.equal(fresh.review,null); assert.equal(fresh.attempts,5); assert.equal(fresh.original_sql,sql);
        assert.equal(fresh.specification_checksum,currentSpec); assert.equal(fresh.state,'reviewing');
        assert.equal((await one('SELECT state FROM requirement_migration_diagnostics')).state,'followup_reviewing');
        await rejected(()=>db.exec("UPDATE requirements SET status='on-review'"),'23514');
        await transition(14,'validation_pending',{checksum:changed,review:{decision:'approved_for_validation'}});
        await rejected(()=>db.exec("UPDATE requirements SET status='done'"),'23514');
        await transition(15,'validated',{checksum:changed}); await db.exec("UPDATE requirements SET status='done'");
        const receipt=(await one('SELECT prior_lifecycle,lifecycle FROM requirement_migration_reconciliations'));
        assert.equal(receipt.prior_lifecycle.specification_checksum,oldSpec); assert.equal(receipt.lifecycle.state,'correction_required');
        assert.equal(receipt.prior_lifecycle.original_sql,sql); assert.equal((await lifecycle()).attempts,5);
        assert.equal((await one('SELECT count(*)::int n FROM requirement_migration_diagnostics')).n,1);
      });
      console.log('passed');
    } catch(error) {
      console.error(error.code, error.message, error.where || '', error.position,
        error.query?.slice(Math.max(0,Number(error.position)-300),Number(error.position)+100), error.stack?.split('\n').slice(0,8).join('\n'));
      process.exitCode=1;
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8', timeout: 60_000, maxBuffer: 3 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`${child.stdout}\n${child.stderr?.slice(-8000) || child.error?.message || 'PGlite reconciliation test failed'}`);
  expect(child.stdout.trim().split('\n').at(-1)).toBe('passed');
  expect(child.stdout).toContain('fresh independent diagnostic');
}, 65_000);