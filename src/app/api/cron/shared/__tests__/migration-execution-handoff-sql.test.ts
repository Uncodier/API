import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('enforces private, quiescent execution handoff without fabricating validation in isolated PostgreSQL', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { resolve } from 'node:path';
    import { createHash, randomBytes } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db = new PGlite(); // Memory only. No environment, network or live database.
    const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
    const req=id(1), instance=id(2), site=id(3), plan=id(4), request=id(5), tenant=id(6);
    const file='migrations/0001.sql', table='requirement_migration_execution_handoffs';
    const name='transfer_requirement_migration_execution';
    const signature=name+'(uuid,text,integer,integer,uuid,uuid,text,text,jsonb)';
    const generic='resume_instance_execution_on_user_action(uuid,uuid,boolean,text,boolean)';
    const hash=value=>createHash('sha256').update(value).digest('hex');
    const secrets=Array.from({length:6},()=>randomBytes(24).toString('hex'));
    const sql='SELECT 1; -- '+secrets[0], spec='Canonical current specification\n café 🧪 '+secrets[1];
    const oldChecksum=hash(sql), observedChecksum=hash('SELECT 2;'), oldSpec=hash('prior spec'), currentSpec=hash(spec);
    const review={decision:'request_changes',reason:secrets[2]};
    const one=async(q,args=[]) => (await db.query(q,args)).rows[0];
    const row=async(t)=> (await one('SELECT to_jsonb(t) v FROM '+t+' t')).v;
    const life=()=>row('requirement_migration_lifecycle');
    const requirement=()=>row('requirements');
    const role=async(name,fn)=>{await db.exec('SET ROLE '+name);try{return await fn();}finally{await db.exec('RESET ROLE').catch(()=>{});}};
    const rpc=(name,args)=>role('service_role',async()=> (await one('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).v);
    const snapshot=async()=>{
      const result={};
      for(const t of ['requirements','remote_instances','instance_plans','requirement_migration_lifecycle',
        'requirement_migration_diagnostics',table,'requirement_migration_reconciliations',
        'requirement_migration_reconciliation_resumes','requirement_user_action_receipts','instance_logs','requirement_status'])
        result[t]=(await db.query('SELECT to_jsonb(t) v FROM '+t+' t ORDER BY to_jsonb(t)::text')).rows;
      return result;
    };
    const rejected=async(fn,code)=>{
      const before=await snapshot();
      await db.exec('SAVEPOINT rejection');
      await assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
      await db.exec('ROLLBACK TO SAVEPOINT rejection; RELEASE SAVEPOINT rejection; RESET ROLE');
      assert.deepEqual(await snapshot(),before,'rejection must be atomic');
    };
    const evidence=()=>({apps_project_ref:'abcdefghijklmnopqrst',tenant_id:tenant,
      schema:'app_'+req.replaceAll('-','').slice(0,24),sandbox_name:'req-'+req.slice(0,8)+'-'+instance.slice(0,8),
      file,observed_at:new Date(Date.now()-1000).toISOString(),sql_checksum:observedChecksum,
      specification_checksum:currentSpec,receipt_found:false,feedback_registered:true,feedback_checksum:observedChecksum});
    let args;
    const transfer=(overrides={})=>rpc(name,args.map((value,index)=>Object.hasOwn(overrides,index)?overrides[index]:value));
    const resume=(action='operator-resume:'+request,internal=true)=>rpc('resume_instance_execution_on_user_action',[req,instance,false,action,internal]);
    const metadata=patch=>db.query('UPDATE requirements SET metadata=metadata || $1',[patch]);
    const diagnostic=async(state='exhausted')=>db.query('INSERT INTO requirement_migration_diagnostics(requirement_id,file,execution_generation,state,checksum,specification_checksum,result) VALUES($1,$2,7,$3,$4,$5,$6)',
      [req,file,state,oldChecksum,oldSpec,{decision:'unresolved',evidence:[{observed:secrets[3]}]}]);
    const seed=async()=>{
      await db.query('INSERT INTO requirements(id,site_id,status,metadata,instructions,backlog,backlog_revision) VALUES($1,$2,$3,$4,$5,$6,11)',
        [req,site,'blocked',{runner_instance_id:instance,requirement_execution_generation:7,cron_attempts:22,
          no_progress_cycles:3,cron_infrastructure_failure_cycles:9},spec,
          {items:[{id:'db',status:'pending',attempts:3,blocked_by:[]}],cycles_spent_total:123}]);
      await db.query('INSERT INTO remote_instances(id,site_id,status,is_archived) VALUES($1,$2,$3,false)',[instance,site,'pending']);
      await db.query('INSERT INTO requirement_migration_lifecycle(requirement_id,file,version,state,checksum,specification_checksum,original_sql,reason,review,attempts) VALUES($1,$2,12,$3,$4,$5,$6,$7,$8,5)',
        [req,file,'platform_review',oldChecksum,oldSpec,sql,'Prior lifecycle reason '+secrets[4],review]);
      await db.query('INSERT INTO instance_plans(id,instance_id,site_id,status,metadata,steps,retry_count) VALUES($1,$2,$3,$4,$5,$6,4)',
        [plan,instance,site,'blocked',{requirement_id:req},[{id:'db',status:'blocked',retry_count:3,infra_retry_count:2}]]);
      args=[req,file,12,7,instance,request,'offline-operator',secrets[5],evidence()];
    };
    const check=async(title,fn)=>{
      await db.exec('BEGIN');
      try{await seed();await fn();console.log(title);}finally{await db.exec('ROLLBACK; RESET ROLE');}
    };
    const load=async(name)=>db.exec(readFileSync(resolve('supabase/migrations',name),'utf8'));
    const definition=async(signature)=>(await one('SELECT pg_get_functiondef($1::regprocedure) v',[signature])).v;
    try {
      await db.exec("SET TIME ZONE 'UTC'; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;"+
        "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,status text,metadata jsonb,instructions text,backlog jsonb,backlog_revision bigint,cron_lock_active boolean DEFAULT false,cron_lock_expires_at timestamptz,cron_lock_run_id text,updated_at timestamptz DEFAULT clock_timestamp());"+
        "CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,status text,is_archived boolean DEFAULT false,updated_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,status text,metadata jsonb,steps jsonb,instructions text,retry_count integer,completed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL,instance_id uuid NOT NULL,log_type text NOT NULL CHECK(log_type IN ('system','user_action','agent_action','tool_call','tool_result','error','performance','thinking','infrastructure')),level text,message text NOT NULL,details jsonb,created_at timestamptz DEFAULT now());"+
        "CREATE TABLE requirement_status(requirement_id uuid,site_id uuid,instance_id uuid,stage text CHECK(stage IN ('pending','in-progress','on-review','completed','done','failed','blocked','paused','cancelled','backlog','validated','needs_review')),message text);"+
        "CREATE TABLE requirement_user_action_receipts(requirement_id uuid,action_id uuid,action_created_at timestamptz,revision bigint,PRIMARY KEY(requirement_id,action_id));");
      for(const migration of ['20260923230000_durable_review_quarantine.sql','20260930010000_requirement_migration_lifecycle.sql',
        '20261001053000_migration_diagnostic_handoff.sql','20261001190500_migration_hold_visibility.sql',
        '20261002010000_migration_operator_reconciliation.sql']) await load(migration);
      // Reproduce the observed production draft shape, NOT the fresh-resume
      // upgrade. Never call the draft stub or invent a resume evidence record.
      await db.exec('ALTER TABLE requirement_migration_reconciliation_resumes DROP COLUMN evidence; DROP FUNCTION resume_reconciled_requirement_migration(uuid,uuid,jsonb);');
      await db.exec("CREATE FUNCTION resume_reconciled_requirement_migration(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'draft must not be called'; END $$; REVOKE ALL ON FUNCTION resume_reconciled_requirement_migration(uuid,uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION resume_reconciled_requirement_migration(uuid,uuid) TO service_role;");
      const unchanged=['transition_requirement_migration(uuid,text,integer,integer,jsonb)',generic,
        'guard_pending_migration_reconciliation()','publish_requirement_migration_hold()',
        'resume_reconciled_requirement_migration(uuid,uuid)','begin_migration_diagnostic_review(uuid,text,integer,integer,jsonb)'];
      const before=await Promise.all(unchanged.map(definition));
      // Hostile defaults must not turn new private helpers/tables into APIs.
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role;');
      await load('20261003010000_migration_execution_handoff.sql');
      assert.deepEqual(await Promise.all(unchanged.map(definition)),before);
      assert.equal((await one("SELECT to_regprocedure('resume_reconciled_requirement_migration(uuid,uuid,jsonb)') v")).v,null);
      assert.equal((await one("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='requirement_migration_reconciliation_resumes' AND column_name='evidence'")).n,0);

      await check('ACL, RLS and append-only receipts survive hostile default grants and BYPASSRLS',async()=>{
        assert.equal((await one('SELECT relrowsecurity v FROM pg_class WHERE oid=$1::regclass',[table])).v,true);
        for(const who of ['anon','authenticated','service_role']) {
          assert.equal((await one('SELECT has_function_privilege($1,$2,$3) v',[who,signature,'EXECUTE'])).v,who==='service_role');
          assert.equal((await one('SELECT has_table_privilege($1,$2,$3) v',[who,table,'SELECT'])).v,who==='service_role');
          for(const helper of ['guard_migration_execution_handoff()','reject_migration_execution_handoff_mutation()',
            'migration_execution_handoff_matches(requirement_migration_lifecycle)','guard_requirement_migration_status()'])
            assert.equal((await one('SELECT has_function_privilege($1,$2,$3) v',[who,helper,'EXECUTE'])).v,false);
          for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
            assert.equal((await one('SELECT has_table_privilege($1,$2,$3) v',[who,table,privilege])).v,false);
        }
        for(const who of ['anon','authenticated']) {
          await rejected(()=>role(who,()=>db.query('SELECT '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args)),'42501');
          await rejected(()=>role(who,()=>db.query('SELECT * FROM '+table)),'42501');
          assert.equal((await one('SELECT has_function_privilege($1,$2,$3) v',[who,generic,'EXECUTE'])).v,false);
        }
        await transfer();
        assert.equal((await role('service_role',()=>one('SELECT count(*)::int n FROM '+table))).n,1);
        for(const statement of ['DELETE FROM '+table,'TRUNCATE '+table+' CASCADE','UPDATE '+table+' SET reason=reason','INSERT INTO '+table+' SELECT * FROM '+table])
          await rejected(()=>role('service_role',()=>db.exec(statement)),'42501');
        for(const statement of ['DELETE FROM '+table,'TRUNCATE '+table+' CASCADE','UPDATE '+table+' SET created_at=now()'])
          await rejected(()=>db.exec(statement),'23514');
        await db.exec('GRANT SELECT ON '+table+' TO anon,authenticated');
        for(const who of ['anon','authenticated']) assert.equal((await role(who,()=>one('SELECT count(*)::int n FROM '+table))).n,0);
        await db.exec('ALTER ROLE service_role BYPASSRLS');
        await rejected(()=>role('service_role',()=>db.exec('DELETE FROM '+table)),'42501');
      });

      await check('full private history, SQL, checksums, attempts and diagnostic survive without resume or approval',async()=>{
        await diagnostic();
        const prior=await life(), d=await row('requirement_migration_diagnostics'), r=await requirement(), initial=await snapshot();
        assert.deepEqual(await transfer(),{receipt_id:request,state:'transferred',resumed:false});
        const current=await life(), receipt=await row(table);
        assert.deepEqual(current,{...prior,state:'transferred',version:13,updated_at:receipt.created_at});
        assert.deepEqual(receipt.prior_lifecycle,prior);assert.deepEqual(receipt.prior_diagnostic,d);
        assert.deepEqual(receipt.evidence,args[8]);assert.equal(receipt.reason,args[7]);
        assert.equal(receipt.operator_id,args[6]);assert.equal(receipt.execution_generation,7);
        assert.equal(receipt.transferred_version,13);assert.equal(receipt.instance_id,instance);assert.equal(receipt.site_id,site);
        assert.notEqual(receipt.evidence.sql_checksum,current.checksum,'current observed bytes can differ from historical bytes');
        assert.notEqual(receipt.evidence.specification_checksum,current.specification_checksum);
        const expected={...r,metadata:{...r.metadata}};delete expected.metadata.execution_hold;
        assert.deepEqual(await requirement(),expected);
        const after=await snapshot();
        for(const t of ['remote_instances','instance_plans','requirement_migration_diagnostics','requirement_status',
          'requirement_migration_reconciliations','requirement_migration_reconciliation_resumes']) assert.deepEqual(after[t],initial[t]);
        const audit=(await one("SELECT message,details FROM instance_logs WHERE details->>'event'='migration_execution_handoff'"));
        assert.deepEqual(Object.keys(audit.details).sort(),['event','receipt_id','requirement_id','transferred_version','execution_generation','state','resumed'].sort());
        assert.ok(JSON.stringify(audit).length<800);assert.ok(!JSON.stringify(audit).includes(file));
        const publicText=JSON.stringify({logs:after.instance_logs,status:after.requirement_status,metadata:(await requirement()).metadata});
        for(const sensitive of secrets) assert.ok(!publicText.includes(sensitive),'no private SQL/spec/review/diagnostic/reason in public audit');
        assert.equal((await one("SELECT count(*)::int n FROM requirement_migration_lifecycle WHERE state='validated'")).n,0);
      });

      await check('exact request identity replay is read-only after pauses, changed generation and evidence expiry',async()=>{
        const result=await transfer();
        await db.exec("UPDATE requirements SET status='paused',instructions='later specification',metadata=metadata||'{\"requirement_execution_generation\":8}'::jsonb; UPDATE remote_instances SET status='paused'; UPDATE instance_plans SET status='paused'");
        const paused=await snapshot();
        assert.deepEqual(await transfer(),result);assert.deepEqual(await snapshot(),paused);
        for(const patch of [{1:'migrations/other.sql'},{2:13},{3:8},{4:id(99)},{5:id(99)},{6:'other'},{7:'other'},
          {8:{...args[8],observed_at:new Date(Date.now()-3600000).toISOString()}}]) await rejected(()=>transfer(patch),'23505');
        // Freshness is deliberately after exact-identity replay (not a TTL lock).
        const def=await definition(signature);
        assert.ok(def.indexOf('Historical read')<def.indexOf('Stale or future handoff evidence'));
      });

      await check('version/generation CAS and every required parameter fail atomically',async()=>{
        for(const patch of [{2:11},{2:13},{3:6},{3:8},{1:'migrations/missing.sql'}]) await rejected(()=>transfer(patch),'40001');
        await rejected(()=>transfer({0:id(99)}),'P0002');
        for(const patch of [{0:null},{1:null},{1:'../0001.sql'},{1:'migrations/a/../b.sql'},{2:null},{2:0},{2:2147483647},
          {3:null},{3:-1},{3:2147483647},{4:null},{5:null},{6:null},{6:' '},{6:'a'.repeat(201)},
          {7:null},{7:' '},{7:'a'.repeat(2001)},{8:null},{8:[]},{8:{value:'a'.repeat(4097)}}]) await rejected(()=>transfer(patch),'22023');
        for(const generation of [null,'seven',-1,'07',{},2147483648]) {
          await metadata({requirement_execution_generation:generation});
          await rejected(()=>transfer(),generation===2147483648?'40001':'22023');
        }
        await metadata({requirement_execution_generation:7,runner_instance_id:id(99)});await rejected(()=>transfer(),'40001');
      });

      await check('idle lease, same-site runner and manual requirement/instance/plan pauses are mandatory',async()=>{
        await db.exec('UPDATE requirements SET cron_lock_active=true');await rejected(()=>transfer(),'40001');
        await db.exec("UPDATE requirements SET cron_lock_active=false,cron_lock_expires_at=clock_timestamp()+interval '1 hour'");await rejected(()=>transfer(),'40001');
        await db.exec('UPDATE requirements SET cron_lock_expires_at=NULL,cron_lock_active=NULL');await rejected(()=>transfer(),'40001');
        await db.exec('UPDATE requirements SET cron_lock_active=false; ALTER TABLE requirements DISABLE TRIGGER requirement_migration_status_guard');
        for(const status of ['paused','in-progress','done','cancelled','backlog']) {
          await db.query('UPDATE requirements SET status=$1',[status]);await rejected(()=>transfer(),'40001');
        }
        await db.exec("UPDATE requirements SET status='blocked'; ALTER TABLE requirements ENABLE TRIGGER requirement_migration_status_guard");
        for(const status of ['paused','stopped','stopping','starting','error',null]) {
          await db.query('UPDATE remote_instances SET status=$1',[status]);await rejected(()=>transfer(),'40001');
        }
        await db.exec("UPDATE remote_instances SET status='pending',is_archived=true");await rejected(()=>transfer(),'40001');
        await db.query('UPDATE remote_instances SET is_archived=false,site_id=$1',[id(99)]);await rejected(()=>transfer(),'40001');
        await db.query('UPDATE remote_instances SET site_id=$1',[site]);
        await db.exec("UPDATE instance_plans SET status='paused'");await rejected(()=>transfer(),'40001');
        await db.exec("UPDATE instance_plans SET status='blocked'");await transfer();
      });

      await check('evidence requires exact types, current specification, feedback checksum, scope and freshness',async()=>{
        for(const key of Object.keys(args[8])) {
          const missing={...args[8]};delete missing[key];await rejected(()=>transfer({8:missing}),'22023');
          for(const value of [null,{},[],42]) await rejected(()=>transfer({8:{...args[8],[key]:value}}),'22023');
        }
        for(const patch of [{extra:'not allowed'},{apps_project_ref:'bad'},{tenant_id:'bad'},{schema:'app_other'},
          {sandbox_name:'wrong'},{file:'migrations/0002.sql'},{sql_checksum:'bad'},
          {feedback_checksum:oldChecksum},{specification_checksum:oldSpec},{receipt_found:true},
          {receipt_found:'false'},{feedback_registered:false},{feedback_registered:'true'},
          {observed_at:'infinity'},{observed_at:'2026-99-99T00:00:00Z'}]) await rejected(()=>transfer({8:{...args[8],...patch}}),'22023');
        for(const age of [-3600000,3600000]) await rejected(()=>transfer({8:{...args[8],observed_at:new Date(Date.now()+age).toISOString()}}),'40001');
        await db.exec("UPDATE requirements SET instructions='changed after observation'");await rejected(()=>transfer(),'22023');
        for(const value of [null,' ', 'x'.repeat(65537)]) {
          await db.query('UPDATE requirements SET instructions=$1',[value]);await rejected(()=>transfer(),'23514');
        }
      });

      await check('review leases, validation and active diagnostics cannot be transferred or disguised',async()=>{
        for(const state of ['reviewing','validation_pending','validated']) {
          await db.query('UPDATE requirement_migration_lifecycle SET state=$1',[state]);await rejected(()=>transfer(),'23514');
        }
        await db.exec("UPDATE requirement_migration_lifecycle SET state='correction_required'");
        for(const value of [{decision:'approved_for_validation'},'approved_for_validation',[]]) {
          await db.query('UPDATE requirement_migration_lifecycle SET review=$1',[JSON.stringify(value)]);await rejected(()=>transfer(),'23514');
        }
        await db.query('UPDATE requirement_migration_lifecycle SET review=$1',[review]);
        for(const state of ['running','followup_reviewing']) {
          await diagnostic(state);await rejected(()=>transfer(),'23514');await db.exec('DELETE FROM requirement_migration_diagnostics');
        }
        await transfer();assert.equal((await life()).state,'transferred');
      });

      for(const state of [null,'followup_ready','followup_assigned','exhausted']) await check('preserves inactive diagnostic '+state,async()=>{
        if(state) await diagnostic(state);
        const prior=(await snapshot()).requirement_migration_diagnostics;
        await transfer();const receipt=await row(table);
        assert.deepEqual(receipt.prior_diagnostic,state?prior[0].v:null);
        assert.deepEqual((await snapshot()).requirement_migration_diagnostics,prior);
      });

      await check('ordinary RPC and manual writes cannot fabricate transfer, reopen it, mutate history or delete diagnostic parent',async()=>{
        const value={state:'transferred',checksum:oldChecksum,specification_checksum:oldSpec,original_sql:sql,reason:'no',review,attempts:5};
        await rejected(()=>rpc('transition_requirement_migration',[req,file,12,7,value]),'22023');
        await rejected(()=>db.exec("UPDATE requirement_migration_lifecycle SET state='transferred',version=13"),'23514');
        await rejected(()=>db.query("INSERT INTO requirement_migration_lifecycle SELECT requirement_id,'migrations/fake.sql',1,'transferred',checksum,specification_checksum,original_sql,reason,review,attempts,updated_at FROM requirement_migration_lifecycle"),'23514');
        await diagnostic();await transfer();
        for(const state of ['validated','validation_pending','reviewing','correction_required','platform_review'])
          await rejected(()=>rpc('transition_requirement_migration',[req,file,13,7,{...value,state}]),'23514');
        for(const statement of ["state='validated'","version=version+1","checksum=repeat('a',64)","specification_checksum=repeat('a',64)",
          "original_sql='SELECT 3'","reason='changed'","review=NULL","attempts=0","updated_at=clock_timestamp()","file='migrations/moved.sql'"])
          await rejected(()=>db.exec('UPDATE requirement_migration_lifecycle SET '+statement),statement.startsWith('file=')?'23503':'23514');
        await rejected(()=>db.exec('DELETE FROM requirement_migration_lifecycle'),'23503');
        await rejected(()=>db.exec('TRUNCATE requirement_migration_lifecycle CASCADE'),'23514');
        assert.equal((await one("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='requirement_migration_diagnostics'::regclass AND confrelid='requirement_migration_lifecycle'::regclass AND contype='f'")).n,1);
      });

      await check('only matching receipt identity and row version exempt transferred rows from delivery guard',async()=>{
        await transfer();
        for(const change of ["version=14","checksum=repeat('a',64)","reason='different'","updated_at=updated_at+interval '1 second'"]) {
          await db.exec('SAVEPOINT corruption; ALTER TABLE requirement_migration_lifecycle DISABLE TRIGGER requirement_migration_execution_handoff_guard');
          await db.exec('UPDATE requirement_migration_lifecycle SET '+change);
          await db.exec('ALTER TABLE requirement_migration_lifecycle ENABLE TRIGGER requirement_migration_execution_handoff_guard');
          for(const status of ['in-progress','done','on-review']) await rejected(()=>db.query('UPDATE requirements SET status=$1',[status]),'23514');
          await db.exec('ROLLBACK TO SAVEPOINT corruption; RELEASE SAVEPOINT corruption');
        }
        await db.exec("UPDATE requirements SET status='done'");
        assert.equal((await life()).state,'transferred');
      });

      await check('unrelated execution holds and cron blockers are never cleared by transfer',async()=>{
        const original=(await requirement()).metadata;
        for(const hold of [{kind:'billing'},{kind:'migration_platform_review',file:'migrations/other.sql'},null]) {
          await metadata({execution_hold:hold});await rejected(()=>transfer(),'23514');
        }
        await db.query('UPDATE requirements SET metadata=$1',[original]);
        await metadata({cron_blocker_provenance:'platform'});await rejected(()=>transfer(),'23514');
        await db.query('UPDATE requirements SET metadata=$1',[original]);
        const downstream={items:[{id:'downstream',status:'blocked',attempts:2,blocked_by:[{category:'dependency',resolution_actor:'executor',user_action_required:false}]}]};
        await db.query('UPDATE requirements SET backlog=$1',[downstream]);await transfer();
        assert.deepEqual((await requirement()).backlog,downstream);
        assert.equal((await resume()).state,'applied','ordinary downstream dependency is not a requirement-wide hold');
        assert.deepEqual((await requirement()).backlog,downstream);
      });

      await check('durable quarantine remains intact and transfer does not claim generic recovery authority',async()=>{
        const quarantined={items:[{id:'other',status:'needs_review',attempts:4,review_quarantine:{active:true}}]};
        await db.query('UPDATE requirements SET backlog=$1',[quarantined]);await transfer();
        assert.deepEqual((await requirement()).backlog,quarantined);
        await rejected(()=>db.exec("UPDATE requirements SET backlog='{\"items\":[]}'::jsonb"),'P0001');
        // The existing internal generic resume does not release quarantine;
        // its independent trusted-user-action contract is unchanged.
        await resume();assert.deepEqual((await requirement()).backlog,quarantined);
      });

      await check('other untransferred migration holds still block resume and delivery',async()=>{
        await transfer();
        await db.query("INSERT INTO requirement_migration_lifecycle(requirement_id,file,version,state,checksum,specification_checksum,reason,attempts) VALUES($1,'migrations/other.sql',1,'correction_required',$2,$3,'other',0)",[req,oldChecksum,oldSpec]);
        await rejected(()=>db.exec("UPDATE requirements SET status='done'"),'23514');
        await rejected(()=>db.exec("UPDATE requirements SET status='on-review'"),'23514');
        await db.exec("UPDATE requirement_migration_lifecycle SET state='platform_review' WHERE file='migrations/other.sql'");
        await rejected(()=>resume(),'23514');
        assert.equal((await requirement()).metadata.execution_hold.file,'migrations/other.sql');
      });

      await check('old unresumed reconciliation is rejected without a fresh-evidence-column dependency',async()=>{
        const prior=await life();
        await db.query('INSERT INTO requirement_migration_reconciliations(id,requirement_id,file,site_id,instance_id,plan_id,step_id,operator_id,reason,execution_generation,backlog_revision,prior_lifecycle,specification_checksum,specification,evidence,request,lifecycle) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,7,11,$10,$11,$12,$13,$14,$15)',
          [id(20),req,file,site,instance,plan,'db','old-operator','old reconciliation',prior,currentSpec,spec,{}, {},prior]);
        await rejected(()=>transfer(),'23514');
        await rejected(()=>resume(),'23514');
        // Historic draft resume receipt has no evidence column. Transfer checks
        // only whether it already exists; it never consumes or creates one.
        await db.query('INSERT INTO requirement_migration_reconciliation_resumes(receipt_id,requirement_id,execution_generation) VALUES($1,$2,7)',[id(20),req]);
        await transfer();assert.equal((await one('SELECT count(*)::int n FROM requirement_migration_reconciliation_resumes')).n,1);
      });

      await check('separate real generic service-only operator resume works; replay never reopens or consumes twice',async()=>{
        const transferred=await transfer(), frozen=await life();
        assert.equal((await requirement()).status,'blocked');
        assert.equal((await resume('operator-resume:'+request,false)).state,'untrusted');
        assert.equal((await requirement()).metadata.requirement_execution_generation,7);
        assert.equal((await resume()).state,'applied');
        assert.equal((await requirement()).metadata.requirement_execution_generation,8);
        assert.equal((await requirement()).status,'in-progress');
        assert.deepEqual(await life(),frozen);assert.equal((await row(table)).execution_generation,7);
        await db.exec("UPDATE requirements SET status='paused'; UPDATE remote_instances SET status='paused'; UPDATE instance_plans SET status='paused'");
        const paused=await snapshot();
        assert.deepEqual(await transfer(),transferred);assert.equal((await resume()).state,'duplicate');
        assert.deepEqual(await snapshot(),paused);
        await db.exec("UPDATE requirements SET status='done'");assert.equal((await life()).state,'transferred');
      });

      await check('audit failure rolls back receipt, lifecycle and hold projection together',async()=>{
        await db.exec("CREATE FUNCTION fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline audit failure' USING ERRCODE='23514'; END $$; CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON instance_logs FOR EACH ROW EXECUTE FUNCTION fixture_reject_audit()");
        await rejected(()=>transfer(),'23514');
      });
      console.log('passed');
    } catch(error) {
      console.error(error.code,error.message,error.where||'',error.position,error.stack?.split('\n').slice(0,6).join('\n'));
      process.exitCode=1;
    } finally {await db.close();}
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8', timeout: 90_000, maxBuffer: 3 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`${child.stdout}\n${child.stderr?.slice(-8000) || child.error?.message || 'PGlite handoff test failed'}`);
  expect(child.stdout.trim().split('\n').at(-1)).toBe('passed');
  expect(child.stdout).toContain('separate real generic service-only operator resume works');
}, 95_000);