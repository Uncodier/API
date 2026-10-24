import { spawnSync } from 'node:child_process';

it('claims and fences agent cron without product gates, preserves pauses, resumes safely and records review progress offline', () => {
  // Real forward SQL in ephemeral PGlite only. This tests serial interleavings,
  // not multi-connection advisory lock contention or a production deployment.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db=new PGlite();
    const site=randomUUID(),user=randomUUID();
    const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
    const claim=async(excluded=[],max=10,due=[]) => (await one('SELECT claim_agent_requirement_run($1::uuid[],$2,300,$3::uuid[]) value',[excluded,max,due])).value;
    const owner=async(run,terminal=false) => (await one('SELECT assert_agent_requirement_run($1,$2,$3,$4,$5) value',[run.requirementId,run.runId,run.executionGeneration,run.sessionId,terminal])).value;
    const finish=async(run,status,reason='implemented') => (await one('SELECT finish_agent_requirement_cycle($1,$2,$3,$4,$5,$6,$7) value',[run.requirementId,run.runId,run.executionGeneration,run.sessionId,status,reason,'Offline progress'])).value;
    const req=async(status='backlog',metadata={},extra={}) => {
      const id=randomUUID(); await db.query('INSERT INTO requirements(id,site_id,user_id,status,metadata,cron,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[id,site,user,status,metadata,extra.cron??null,extra.created??'2026-09-15']); return id;
    };
    const reset=() => db.exec('DELETE FROM requirement_migration_lifecycle;DELETE FROM requirement_status;DELETE FROM harness_requirement_runs;DELETE FROM harness_sessions;DELETE FROM requirements;DELETE FROM instance_plans;DELETE FROM instance_logs;DELETE FROM remote_instances;');
    const initial=id=>({id,version:0,status:'queued',request:{objective:'Offline task',repository:{url:'https://example.test/repository'},limits:{maxTurns:10,maxOutputTokens:1024,maxTotalTokens:10000,maxActiveMs:30000}},messages:[],turns:0,allocatedTokens:0,activeMs:0,uncertainOperations:[],createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()});
    const session=async(run,status,reason,extra={}) => {
      await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[run.sessionId,site,user,initial(run.sessionId)]);
      const s=(await one('SELECT claim_harness_session($1,$2,$3,300) value',[run.sessionId,site,'offline-owner'])).value;
      await db.query('SELECT save_harness_session($1,$2,$3,$4)',[run.sessionId,site,'offline-owner',{...s,status,reason,turns:3,allocatedTokens:100,activeMs:20,...extra}]);
      await db.query('SELECT release_harness_session($1,$2,$3)',[run.sessionId,site,'offline-owner']);
    };
    try {
      await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE sites(id uuid PRIMARY KEY);');
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;');
      await db.exec(
        "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,user_id uuid NOT NULL,title text DEFAULT 'Offline',status text CHECK(status IN ('backlog','in-progress','blocked','on-review','done','cancelled')),cron text,created_at timestamptz,updated_at timestamptz,metadata jsonb,backlog jsonb DEFAULT '{}',backlog_revision bigint DEFAULT 0,cron_lock_run_id text,cron_lock_expires_at timestamptz,cron_lock_active boolean DEFAULT false);"+
        "CREATE TABLE remote_instances(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL,user_id uuid NOT NULL,created_by uuid NOT NULL,name text NOT NULL,instance_type text CHECK(instance_type IN ('browser','ubuntu','windows')),status text CHECK(status IN ('pending','starting','running','paused','stopping','stopped','error')),is_archived boolean DEFAULT false,created_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),instance_id uuid REFERENCES remote_instances(id),site_id uuid,status text CHECK(status IN ('pending','in_progress','active','paused','completed','failed','cancelled','blocked')),metadata jsonb,steps jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid,instance_id uuid,log_type text,trusted_user_action boolean,details jsonb,created_at timestamptz DEFAULT now());"+
        "CREATE TABLE requirement_status(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),requirement_id uuid REFERENCES requirements(id),site_id uuid,instance_id uuid,stage text,cycle text,message text,repo_url text,metadata jsonb,updated_at timestamptz DEFAULT now());"
      );
      // Install real historical lifecycle/handoff SQL, including its AFTER
      // status gate, rather than a permissive mock of that trigger.
      for(const file of ['20260923225900_review_quarantine_receipts.sql','20260923230000_durable_review_quarantine.sql','20260923230100_stamp_review_quarantine.sql','20260930010000_requirement_migration_lifecycle.sql','20261003010000_migration_execution_handoff.sql','20261014010000_portable_harness_sessions.sql','20261014020000_portable_harness_host_state.sql','20261014030000_agent_driven_requirement_cron.sql','20261020200000_requirement_cross_instance_commands.sql']) await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
      await db.query('INSERT INTO sites VALUES($1)',[site]);await db.query('INSERT INTO auth.users VALUES($1)',[user]);
      // Produce incident rows using the real OLD finish, not a hand-built mock.
      const incidents=[];
      const recoveryCases=['intact','manual-edit','manual-status','different-cycle','later-status','missing-status',
        'reason-mismatch','missing-session','paused-session','cancelled-session','wrong-user','wrong-requirement',
        'live-session','live-cron','user_paused','customer_paused','cron_paused','execution_hold',
        'paused-owner','archived-owner','paused-plan','trusted-action'];
      for(const name of recoveryCases) {
        await req();const c=await claim();assert.ok(c,name);
        await session(c.run,'waiting','Need user decision');
        assert.equal(await finish(c.run,'waiting','Need user decision'),true);
        assert.equal((await one('SELECT status FROM requirements WHERE id=$1',[c.run.requirementId])).status,'blocked');
        incidents.push({name,run:c.run});
      }
      const evidence=async()=> (await db.query('SELECT to_jsonb(r) requirement,to_jsonb(h) mapping,to_jsonb(s) session FROM requirements r JOIN harness_requirement_runs h ON h.requirement_id=r.id JOIN harness_sessions s ON s.id=h.session_id ORDER BY r.id')).rows;
      const beforeMigration=await evidence();
      const forward=readFileSync('supabase/migrations/20261023200000_agent_requirement_nonblocking_wait.sql','utf8');
      await db.exec(forward);await db.exec(forward);
      assert.deepEqual(await evidence(),beforeMigration,'install/reapply never rewrites incident rows or leases');
      for(const {name,run} of incidents) {
        const id=run.requirementId;
        if(name==='manual-edit') await db.query("UPDATE requirements SET title='Manual hold' WHERE id=$1",[id]);
        if(name==='manual-status') await db.query("UPDATE requirements SET status='blocked' WHERE id=$1",[id]);
        if(name==='different-cycle') await db.query("UPDATE requirement_status SET cycle='manual' WHERE requirement_id=$1",[id]);
        if(name==='later-status') await db.query("INSERT INTO requirement_status(requirement_id,site_id,stage,cycle,updated_at) VALUES($1,$2,'blocked','manual',clock_timestamp())",[id,site]);
        if(name==='missing-status') await db.query('DELETE FROM requirement_status WHERE requirement_id=$1',[id]);
        if(name==='reason-mismatch') await db.query("UPDATE harness_requirement_runs SET pause_reason='Different reason' WHERE requirement_id=$1",[id]);
        if(name==='missing-session') await db.query('DELETE FROM harness_sessions WHERE id=$1',[run.sessionId]);
        if(name==='paused-session'||name==='cancelled-session') await db.query('SELECT control_harness_session($1,$2,$3)',[run.sessionId,site,name==='paused-session'?'pause':'cancel']);
        if(name==='wrong-user'||name==='wrong-requirement') {
          await db.query('DELETE FROM harness_sessions WHERE id=$1',[run.sessionId]);
          const otherUser=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[otherUser]);
          const snapshot=initial(run.sessionId);if(name==='wrong-requirement') snapshot.request.requirementId=randomUUID();
          await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[run.sessionId,site,name==='wrong-user'?otherUser:user,snapshot]);
        }
        if(name==='live-session') await db.query("UPDATE harness_sessions SET lease_owner='other-owner',lease_expires_at=now()+interval '1 hour' WHERE id=$1",[run.sessionId]);
        if(name==='live-cron') await db.query("UPDATE requirements SET cron_lock_run_id='other-cron',cron_lock_active=true,cron_lock_expires_at=now()+interval '1 hour' WHERE id=$1",[id]);
        if(['user_paused','customer_paused','cron_paused','execution_hold'].includes(name)) await db.query('UPDATE requirements SET metadata=metadata||$2 WHERE id=$1',[id,{[name]:name==='execution_hold'?{kind:'security'}:true}]);
        if(name==='paused-owner') await db.query("UPDATE remote_instances SET status='paused' WHERE id=$1",[run.instanceId]);
        if(name==='archived-owner') await db.query('UPDATE remote_instances SET is_archived=true WHERE id=$1',[run.instanceId]);
        if(name==='paused-plan') await db.query("INSERT INTO instance_plans(site_id,instance_id,status) VALUES($1,$2,'paused')",[site,run.instanceId]);
        if(name==='trusted-action') await db.query("INSERT INTO instance_logs(site_id,instance_id,log_type,trusted_user_action,details) VALUES($1,$2,'user_action',true,'{\"status\":\"running\"}')",[site,run.instanceId]);
        const snapshotBefore=await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[run.sessionId]);
        const recovered=await claim(incidents.filter(x=>x.run.requirementId!==id).map(x=>x.run.requirementId));
        if(name==='intact') {
          assert.ok(recovered,'historical exact-agent wait is recoverable');
          assert.equal(recovered.run.sessionId,run.sessionId);assert.equal(recovered.run.executionGeneration,run.executionGeneration);
          assert.equal(recovered.run.instanceId,run.instanceId);assert.notEqual(recovered.run.runId,run.runId);
          const after=(await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[run.sessionId])).snapshot;
          assert.deepEqual({...after,status:snapshotBefore.snapshot.status,version:snapshotBefore.snapshot.version,updatedAt:snapshotBefore.snapshot.updatedAt},snapshotBefore.snapshot,'historical recovery preserves every budget/request/message field');
          assert.equal(after.status,'queued');assert.equal(await owner(run),false);
          await finish(recovered.run,'running');
        } else {
          assert.equal(recovered,null,name+' must remain fenced');
          assert.equal((await one('SELECT status FROM requirements WHERE id=$1',[id])).status,'blocked');
        }
      }
      await reset();
      // More than a full candidate window of old blocked mappings must not
      // starve either a genuine historical recovery or ordinary ready work.
      // Bulk fixtures reproduce the old finish's shared transaction evidence;
      // the incident cases above separately exercise the real old finish.
      for(const obstruction of ['missing-session','paused-session','manual-edit','paused-owner','no-mapping','malformed-generation']) {
        const rows=Array.from({length:1001},(_,n)=>({
          id:randomUUID(),sid:randomUUID(),iid:randomUUID(),recoverable:n===1000,
        }));
        const retained=rows[1000];
        await db.exec('BEGIN');
        await db.exec('CREATE TEMP TABLE starvation_fixture(id uuid,sid uuid,iid uuid,recoverable boolean)');
        await db.query('INSERT INTO starvation_fixture SELECT * FROM jsonb_to_recordset($1) AS x(id uuid,sid uuid,iid uuid,recoverable boolean)',[JSON.stringify(rows)]);
        await db.query("INSERT INTO remote_instances(id,site_id,user_id,created_by,name,instance_type,status) SELECT iid,$1,$2,$2,'req-runner-'||id,'browser','pending' FROM starvation_fixture",[site,user]);
        await db.query("INSERT INTO requirements(id,site_id,user_id,status,metadata,created_at,updated_at) SELECT id,$1,$2,'blocked',jsonb_build_object('runner_instance_id',iid,'requirement_execution_generation',0),'2026-09-15',CASE WHEN recoverable THEN '2026-09-16'::timestamptz ELSE '2026-09-15'::timestamptz END FROM starvation_fixture",[site,user]);
        await db.query("INSERT INTO harness_requirement_runs(requirement_id,site_id,session_id,generation,pause_reason,last_cycle_id) SELECT id,$1,sid,0,'Need user decision','offline-historical-'||id FROM starvation_fixture",[site]);
        await db.query("INSERT INTO harness_sessions(id,site_id,user_id,snapshot) SELECT sid,$1,$2,$3::jsonb||jsonb_build_object('id',sid) FROM starvation_fixture",[site,user,initial(randomUUID())]);
        await db.exec("UPDATE harness_sessions SET version=version+1,snapshot=snapshot||jsonb_build_object('version',version+1,'status','waiting','reason','Need user decision')");
        await db.query("INSERT INTO requirement_status(requirement_id,site_id,instance_id,stage,cycle) SELECT id,$1,iid,'blocked','agent:offline-historical-'||id FROM starvation_fixture",[site]);
        await db.exec('COMMIT');
        // Mutate in a separate transaction so unchanged manual blocks lose xmin
        // provenance, just as a later human edit of an old incident would.
        if(obstruction==='missing-session') await db.exec('DELETE FROM harness_sessions WHERE id IN (SELECT sid FROM starvation_fixture WHERE NOT recoverable)');
        if(obstruction==='no-mapping') await db.exec('DELETE FROM harness_requirement_runs WHERE requirement_id IN (SELECT id FROM starvation_fixture WHERE NOT recoverable)');
        if(obstruction==='malformed-generation') await db.exec("UPDATE requirements SET metadata=metadata||'{\"requirement_execution_generation\":\"invalid\"}' WHERE id IN (SELECT id FROM starvation_fixture WHERE NOT recoverable)");
        if(obstruction==='paused-session') await db.query("SELECT control_harness_session(sid,$1,'pause') FROM starvation_fixture WHERE NOT recoverable",[site]);
        if(obstruction==='manual-edit') await db.exec("UPDATE requirements SET title='Manual hold' WHERE id IN (SELECT id FROM starvation_fixture WHERE NOT recoverable)");
        if(obstruction==='paused-owner') await db.exec("UPDATE remote_instances SET status='paused' WHERE id IN (SELECT iid FROM starvation_fixture WHERE NOT recoverable)");
        const ready=await req('backlog',{}, {created:'2026-09-17'});
        assert.equal((await one('SELECT count(*)::integer count FROM requirements WHERE updated_at<$1',[ '2026-09-16' ])).count,1000);
        const blockedEvidence=async()=> (await db.query('SELECT to_jsonb(r) requirement,to_jsonb(h) mapping,to_jsonb(s) session,to_jsonb(i) instance FROM starvation_fixture f JOIN requirements r ON r.id=f.id LEFT JOIN harness_requirement_runs h ON h.requirement_id=f.id LEFT JOIN harness_sessions s ON s.id=f.sid JOIN remote_instances i ON i.id=f.iid WHERE NOT f.recoverable ORDER BY f.id')).rows;
        const before=await blockedEvidence();
        await db.exec('SET ROLE service_role');
        const recovered=await claim();
        assert.equal(recovered?.run.requirementId,retained.id,obstruction+': true recovery survives pre-LIMIT filtering');
        assert.equal(recovered.run.sessionId,retained.sid);
        assert.equal(recovered.run.instanceId,retained.iid);
        assert.equal(recovered.run.executionGeneration,0);
        const claimedReady=await claim();
        assert.equal(claimedReady?.run.requirementId,ready,obstruction+': 1000 old blocked mappings cannot starve ready work');
        await db.exec('RESET ROLE');
        assert.deepEqual(await blockedEvidence(),before,obstruction+': blocked rows, sessions and ownership remain untouched');
        await db.exec('DROP TABLE starvation_fixture');
        await reset();
      }
      for(const role of ['anon','authenticated','service_role']) {
        assert.equal((await one('SELECT has_table_privilege($1,$2,$3) allowed',[role,'harness_requirement_runs','UPDATE'])).allowed,false);
        for(const fn of ['claim_agent_requirement_run(uuid[],integer,integer,uuid[])','assert_agent_requirement_run(uuid,text,integer,uuid,boolean,integer)','finish_agent_requirement_cycle(uuid,text,integer,uuid,text,text,text,text)','patch_agent_requirement_progress(uuid,text,integer,uuid,uuid,text,text,text,text,bigint)'])
          assert.equal((await one('SELECT has_function_privilege($1,$2,$3) allowed',[role,fn,'EXECUTE'])).allowed,role==='service_role');
      }
      assert.equal((await one("SELECT relrowsecurity value FROM pg_class WHERE oid='harness_requirement_runs'::regclass")).value,true);
      assert.equal((await one("SELECT has_function_privilege('service_role','agent_requirement_runner_allowed(uuid,uuid)','EXECUTE') allowed")).allowed,false);
      for(const role of ['anon','authenticated','service_role']) assert.equal((await one('SELECT has_function_privilege($1,$2,$3) allowed',[role,'claim_agent_requirement_run_before_commands(uuid[],integer,integer,uuid[])','EXECUTE'])).allowed,false);
      for(const role of ['anon','authenticated']) {
        await db.exec('SET ROLE '+role);
        await assert.rejects(()=>claim(),/permission denied/);
        await db.exec('RESET ROLE');
      }
      await req('backlog',{}, {created:'2026-08-31'});assert.equal(await claim(),null);await reset();
      const id=await req('blocked',{cron_blocker_provenance:'product_no_progress_circuit',no_progress_cycles:999,requirement_execution_generation:7});
      await db.query("UPDATE requirements SET backlog=$2 WHERE id=$1",[id,{items:[{id:'item',status:'failed',attempts:999,acceptance:{approved:false}}]}]);
      const a=await claim();assert.equal(a.run.requirementId,id);assert.equal(a.run.executionGeneration,7);assert.equal(a.requirement.status,'in-progress');
      assert.equal(await claim(),null);assert.deepEqual(await claim([],1),{state:'capacity_full'});assert.equal(await owner(a.run),true);
      assert.equal(await owner({...a.run,runId:'stale'}),false);assert.equal(await owner({...a.run,sessionId:randomUUID()}),false);
      assert.equal(await finish(a.run,'running'),true);assert.equal(await finish(a.run,'running'),false);
      const b=await claim();assert.equal(b.run.sessionId,a.run.sessionId);assert.notEqual(b.run.runId,a.run.runId);assert.equal(await owner(a.run),false);
      const plan=randomUUID();await db.query("INSERT INTO instance_plans(id,site_id,instance_id,status,metadata,steps) VALUES($1,$2,$3,'pending',$4,$5)",[plan,site,b.run.instanceId,{requirement_id:id,security:'unchanged'},[{id:'step',status:'pending',metadata:{acceptance:'unchanged'}}]]);
      const patch=async(run,revision=0,status='done',item='item',step=null) => (await one('SELECT patch_agent_requirement_progress($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value',[run.requirementId,run.runId,run.executionGeneration,run.sessionId,plan,step,item,status,'Agent-selected progress',revision])).value;
      assert.equal((await patch(a.run)).state,'stale');assert.equal((await patch(b.run,99)).state,'revision_conflict');
      assert.equal((await patch(b.run)).state,'updated');const after=await one('SELECT * FROM requirements WHERE id=$1',[id]);assert.equal(after.backlog.items[0].attempts,999);assert.deepEqual(after.backlog.items[0].acceptance,{approved:false});assert.equal(after.backlog_revision,1);
      assert.equal((await patch(b.run,1,'completed',null,'step')).state,'updated');
      assert.equal((await one('SELECT steps FROM instance_plans WHERE id=$1',[plan])).steps[0].metadata.acceptance,'unchanged');
      assert.equal((await patch(b.run,1,'completed','item','step')).state,'updated');
      assert.equal((await one('SELECT backlog FROM requirements WHERE id=$1',[id])).backlog.items[0].status,'done');
      assert.equal((await one('SELECT steps FROM instance_plans WHERE id=$1',[plan])).steps[0].status,'completed');
      assert.equal((await patch(b.run,2,null,'item','step')).state,'updated');
      assert.equal((await one('SELECT backlog FROM requirements WHERE id=$1',[id])).backlog.items[0].status,'done','message-only target preserves status');
      assert.equal((await patch(b.run,2,'completed',null,null)).state,'updated');
      assert.equal((await one('SELECT status FROM instance_plans WHERE id=$1',[plan])).status,'completed');
      await db.exec('SET ROLE service_role');assert.equal((await patch(b.run,2,null,null,null)).state,'updated');await db.exec('RESET ROLE');
      await assert.rejects(()=>patch(b.run,1,'validated',null,'step'),/Invalid agent progress/);
      assert.equal(await finish(b.run,'completed'),true);assert.equal((await one('SELECT status FROM requirements WHERE id=$1',[id])).status,'on-review');assert.equal(await claim(),null);
      await db.query("UPDATE requirements SET cron='0 * * * *' WHERE id=$1",[id]);assert.equal(await claim(),null);
      const c=await claim([],10,[id]);assert.notEqual(c.run.sessionId,b.run.sessionId);assert.equal(c.run.executionGeneration,8);
      assert.equal((await one('SELECT previous_session_id FROM harness_requirement_runs WHERE requirement_id=$1',[id])).previous_session_id,b.run.sessionId);
      await finish(c.run,'running');const continued=await claim();assert.equal(continued.run.sessionId,c.run.sessionId);
      assert.equal((await one('SELECT previous_session_id FROM harness_requirement_runs WHERE requirement_id=$1',[id])).previous_session_id,b.run.sessionId,'ordinary claims preserve prior occurrence provenance');
      await db.exec('SET ROLE service_role');
      await assert.rejects(()=>db.query('UPDATE harness_requirement_runs SET previous_session_id=$1 WHERE requirement_id=$2',[randomUUID(),id]),/permission denied/,'host provenance cannot be overwritten directly');
      await db.exec('RESET ROLE');
      await reset();
      for(const provenance of ['product_no_progress_circuit','cron_infrastructure','product_attempt_budget','product_replan_circuit']) {await req('blocked',{cron_blocker_provenance:provenance});assert.ok(await claim());await reset();}
      for(const metadata of [{},{cron_blocker_provenance:'customer'},{cron_blocker_provenance:'product_failure'},{cron_blocker_provenance:'cron_infrastructure',execution_hold:{}},{cron_blocker_provenance:'cron_infrastructure',customer_paused:true}]) {await req('blocked',metadata);assert.equal(await claim(),null);await reset();}
      const legacy=await req();const inst=randomUUID();await db.query("INSERT INTO remote_instances(id,name,instance_type,status,site_id,user_id,created_by) VALUES($1,'legacy','browser','running',$2,$3,$3)",[inst,site,user]);
      await db.query("INSERT INTO instance_plans(instance_id,site_id,status,metadata,steps) VALUES($1,$2,'paused',$3,'[]')",[inst,site,{requirement_id:legacy}]);assert.equal(await claim(),null);
      await db.exec("UPDATE instance_plans SET status='pending';UPDATE remote_instances SET is_archived=true");assert.equal(await claim(),null);assert.equal((await one('SELECT count(*)::int n FROM remote_instances')).n,1);
      await db.exec('UPDATE remote_instances SET is_archived=false');await db.query("INSERT INTO instance_logs(instance_id,site_id,log_type,trusted_user_action,details) VALUES($1,$2,'user_action',true,'{\"status\":\"running\"}')",[inst,site]);assert.equal(await claim(),null);
      await db.exec("UPDATE instance_logs SET details='{\"status\":\"completed\"}'");const d=await claim();assert.equal(d.run.instanceId,inst);
      await db.exec("UPDATE remote_instances SET status='paused'");assert.equal(await owner(d.run),false);assert.equal(await finish(d.run,'completed'),false);assert.equal((await one('SELECT status FROM requirements WHERE id=$1',[legacy])).status,'in-progress');
      await reset();
      const waiting=await req();const e=await claim();await session(e.run,'waiting','model_unavailable: offline');assert.equal(await finish(e.run,'waiting','model_unavailable: offline'),true);assert.equal(await claim(),null);
      await db.exec("UPDATE harness_requirement_runs SET next_run_at=now()-interval '1 second'");const f=await claim();assert.equal(f.run.sessionId,e.run.sessionId);
      let stored=(await one('SELECT snapshot FROM harness_sessions')).snapshot;assert.equal(stored.status,'queued');assert.equal(stored.turns,3);assert.equal(stored.allocatedTokens,100);
      await finish(f.run,'waiting','Need user decision');assert.equal(await claim(),null);
      assert.equal((await one('SELECT status FROM requirements WHERE id=$1',[waiting])).status,'in-progress');
      assert.equal((await one("SELECT pause_reason,next_run_at BETWEEN now()+interval '55 seconds' AND now()+interval '65 seconds' delayed FROM harness_requirement_runs")).delayed,true);
      assert.equal((await one('SELECT pause_reason FROM harness_requirement_runs')).pause_reason,null);
      await db.exec("UPDATE harness_requirement_runs SET next_run_at=now()-interval '1 second'");
      const g=await claim();assert.equal(g.run.sessionId,f.run.sessionId);assert.equal(g.run.executionGeneration,f.run.executionGeneration);
      await finish(g.run,'paused','token_budget_exhausted');assert.equal(await claim(),null);await reset();
      for(const reason of ['Need user decision','requirements_need_clarification','ordinary wait',null]) {
        await req();const run=(await claim()).run;await session(run,'waiting',reason,{
          workspace:{provider:'vercel',id:'offline-workspace',root:'/workspace'},
          messages:[{role:'user',content:'Preserve the original request'}],uncertainOperations:['offline-uncertain-write'],
          pending:{call:{id:'offline-pending',name:'read_file',arguments:'{}'},fingerprint:'offline-fingerprint',effect:'read'},
        });
        const before=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
        assert.equal(await finish(run,'waiting',reason),true);
        assert.equal((await one('SELECT status FROM requirements')).status,'in-progress');
        assert.equal((await one('SELECT stage FROM requirement_status')).stage,'in-progress');
        assert.equal(await claim(),null,'all waits back off, not a hot retry loop');
        await db.exec("UPDATE harness_requirement_runs SET next_run_at=now()-interval '1 second'");
        await db.exec('SET ROLE service_role');const again=await claim();await db.exec('RESET ROLE');
        assert.equal(again.run.sessionId,run.sessionId);assert.equal(again.run.executionGeneration,run.executionGeneration);
        const after=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
        assert.equal(after.status,'queued');
        assert.deepEqual({...after,status:before.status,version:before.version,updatedAt:before.updatedAt},before,'retry preserves complete session and budgets');
        assert.equal(await finish(run,'completed'),false,'old run cannot project after reclaim');
        await reset();
      }
      for(const metadata of [{user_paused:true},{customer_paused:true},{cron_paused:true},{execution_hold:{kind:'security'}}]) {
        await req();const run=(await claim()).run;await session(run,'waiting','Need user decision');
        await db.query('UPDATE requirements SET metadata=metadata||$1',[metadata]);
        assert.equal(await finish(run,'waiting','Need user decision'),false,'user/security hold wins final projection');
        assert.equal(await claim(),null,'holds fence ordinary in-progress waits too');
        assert.equal((await one('SELECT cron_lock_active FROM requirements')).cron_lock_active,false);
        assert.equal((await one('SELECT snapshot FROM harness_sessions')).snapshot.status,'waiting');await reset();
      }
      for(const reason of ['user_pause','token_budget_exhausted','turn_budget_exhausted','active_time_budget_exhausted','billing_required','WORKSPACE_AUTHORIZATION_REQUIRED','WORKSPACE_PROVIDER_BILLING_REQUIRED','WORKSPACE_AUTH_CONFIGURATION_REQUIRED']) {
        await req();const run=(await claim()).run;await session(run,'paused',reason);
        assert.equal(await finish(run,'waiting','stale agent wait'),true,'durable pause wins stale wait projection');
        assert.equal((await one('SELECT status FROM requirements')).status,'blocked');
        assert.deepEqual(await one('SELECT pause_reason,next_run_at FROM harness_requirement_runs'),{pause_reason:reason,next_run_at:null});
        assert.equal(await claim(),null,reason+' cannot auto-retry');await reset();
      }
      const live=await req();await db.query("UPDATE requirements SET cron_lock_run_id='legacy-live',cron_lock_active=true,cron_lock_expires_at=now()+interval '1 hour' WHERE id=$1",[live]);assert.equal(await claim(),null);assert.equal((await one('SELECT cron_lock_run_id FROM requirements')).cron_lock_run_id,'legacy-live');
      await db.exec("UPDATE requirements SET cron_lock_expires_at=now()-interval '1 second'");assert.ok(await claim());
      await reset();
      await req('backlog',{requirement_execution_generation:'bad'});assert.equal(await claim(),null);await reset();
      await req();const paused=await claim();await session(paused.run,'paused','token_budget_exhausted');
      assert.equal(await finish(paused.run,'completed'),true);assert.equal((await one('SELECT status FROM requirements')).status,'blocked');assert.equal(await claim(),null);
      await db.exec("UPDATE requirements SET metadata=metadata||'{\"requirement_execution_generation\":1}'");
      const resumed=await claim();assert.equal(resumed.run.sessionId,paused.run.sessionId);
      stored=(await one('SELECT snapshot FROM harness_sessions')).snapshot;assert.equal(stored.status,'queued');assert.equal(stored.allocatedTokens,100);assert.equal(stored.turns,3);
      const sessionOwner=(await one('SELECT claim_harness_session($1,$2,$3,60) value',[resumed.run.sessionId,site,'separate-session-token'])).value;
      assert.equal(await owner(resumed.run),true);
      assert.equal((await one('SELECT lease_owner FROM harness_sessions')).lease_owner,'separate-session-token');
      await db.exec("UPDATE harness_sessions SET lease_expires_at=now()-interval '1 second'");assert.equal(await owner(resumed.run),true);
      assert.equal((await one('SELECT lease_expires_at<now() expired FROM harness_sessions')).expired,true,'cron assertion cannot revive an expired session lease');
      assert.equal((await one('SELECT snapshot FROM harness_sessions')).snapshot.allocatedTokens,sessionOwner.allocatedTokens);
      await finish(resumed.run,'running');
      await db.query('UPDATE harness_sessions SET lease_expires_at=now()+interval \'1 minute\' WHERE id=$1',[resumed.run.sessionId]);
      assert.equal(await claim(),null,'a live session lease prevents cron reassignment');
      await reset();
      await req();const cross=await claim();const otherSite=randomUUID();await db.query('INSERT INTO sites VALUES($1)',[otherSite]);
      await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[cross.run.sessionId,otherSite,user,initial(cross.run.sessionId)]);
      assert.equal(await owner(cross.run),false,'session identity remains site bound');
      await db.exec("UPDATE requirements SET cron_lock_expires_at=now()-interval '1 second'");assert.equal(await claim(),null);
      await reset();await req();const dispatch=await claim();await finish(dispatch.run,'waiting','dispatch_unavailable: offline');
      assert.equal((await one('SELECT status FROM requirements')).status,'in-progress');assert.equal(await claim(),null);
      await db.exec("UPDATE harness_requirement_runs SET next_run_at=now()-interval '1 second'");assert.ok(await claim());
      await reset();await req();const interrupted=await claim();await session(interrupted.run,'completed','implemented');
      assert.equal(await claim(),null,'live cron lease remains untouched even after a terminal save');
      await db.exec("UPDATE requirements SET cron_lock_expires_at=now()-interval '1 second'");assert.equal(await claim(),null);
      assert.equal((await one('SELECT status FROM requirements')).status,'on-review');assert.equal((await one('SELECT count(*)::int n FROM requirement_status')).n,1);
      assert.equal(await claim(),null);assert.equal((await one('SELECT count(*)::int n FROM requirement_status')).n,1,'terminal crash projection is idempotent');
      assert.equal((await one('SELECT session_id FROM harness_requirement_runs')).session_id,interrupted.run.sessionId);
      await db.exec("UPDATE requirements SET status='in-progress',metadata=metadata||'{\"requirement_execution_generation\":1}'");
      const reopened=await claim();assert.equal(reopened.run.sessionId,interrupted.run.sessionId);assert.equal(reopened.run.executionGeneration,1);
      stored=(await one('SELECT snapshot FROM harness_sessions')).snapshot;assert.equal(stored.status,'queued');assert.equal(stored.turns,3);assert.equal(stored.allocatedTokens,100);
      await reset();await req();const cancelled=await claim();await session(cancelled.run,'cancelled','User cancelled');await finish(cancelled.run,'cancelled','User cancelled');
      await db.exec("UPDATE requirements SET status='in-progress',metadata=metadata||'{\"requirement_execution_generation\":1}'");assert.equal(await claim(),null,'cancelled session never automatically reopens');
      await reset();await req();const unvalidated=await claim();
      await db.query("INSERT INTO requirement_migration_lifecycle(requirement_id,file,version,state,checksum,specification_checksum,reason,attempts) VALUES($1,'migrations/offline.sql',1,'validation_pending',repeat('a',64),repeat('b',64),'Offline pending',1)",[unvalidated.run.requirementId]);
      await assert.rejects(()=>db.exec("UPDATE requirements SET status='on-review'"),/unvalidated/,'no completed session means no legacy-gate exemption');
      await session(unvalidated.run,'completed','implemented');assert.equal(await finish(unvalidated.run,'completed'),true);
      assert.equal((await one('SELECT status FROM requirements')).status,'on-review');
      assert.equal((await one('SELECT state FROM requirement_migration_lifecycle')).state,'validation_pending','review does not fabricate migration validation');
      await assert.rejects(()=>db.exec("UPDATE requirements SET status='done'"),/unvalidated/);
      await db.exec("UPDATE requirement_migration_lifecycle SET state='platform_review';UPDATE requirements SET status='blocked'");
      await assert.rejects(()=>db.exec("UPDATE requirements SET status='on-review'"),/platform review/,'explicit platform hold survives completed session');
      await reset();const quarantined=await req();const quarantine={active:true,kind:'verification_exhausted',reason:'Legacy judge',quarantined_at:'2026-09-15T00:00:00Z',external_action_revision:0};
      const quarantinedItem={id:'technical',status:'needs_review',attempts:99,acceptance:['Unchanged acceptance'],review_quarantine:quarantine};
      await db.query('UPDATE requirements SET backlog=$1',[{items:[quarantinedItem]}]);
      await assert.rejects(()=>db.query('UPDATE requirements SET backlog=$1',[{items:[{...quarantinedItem,status:'done'}]}]),/quarantined/,'legacy callers cannot clear quarantine');
      const qr=await claim();await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[qr.run.sessionId,site,user,initial(qr.run.sessionId)]);
      const qp=async status => (await one('SELECT patch_agent_requirement_progress($1,$2,$3,$4,null,null,$5,$6,$7,0) value',[qr.run.requirementId,qr.run.runId,qr.run.executionGeneration,qr.run.sessionId,'technical',status,'Technical work chosen by agent'])).value;
      await db.exec('SET ROLE service_role');assert.equal((await qp('in_progress')).state,'updated');await db.exec('RESET ROLE');
      const preserved=(await one('SELECT backlog FROM requirements')).backlog.items[0];assert.deepEqual(preserved,{...quarantinedItem,status:'in_progress'});
      await assert.rejects(()=>db.query('UPDATE requirements SET backlog=$1',[{items:[{...preserved,attempts:0}]}]),/quarantined/,'even the agent cannot rewrite quarantine evidence');
      await db.exec("UPDATE requirements SET metadata=metadata||'{\"execution_hold\":{\"kind\":\"user_pause\"}}'");assert.equal((await qp('done')).state,'stale');
      await reset();await req();assert.equal(await claim([(await one('SELECT id FROM requirements')).id]),null);
      await assert.rejects(()=>claim([],0),/Invalid agent cron claim/);
      await reset();
      await db.exec(readFileSync('supabase/migrations/20261024010000_requirement_source_checkpoints.sql','utf8'));
      await req(); const backupRun=(await claim()).run;
      await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[backupRun.sessionId,site,user,initial(backupRun.sessionId)]);
      await db.query('SELECT claim_harness_session($1,$2,$3,300)',[backupRun.sessionId,site,'backup-owner']);
      const backupResult={state:'saved',sha:'a'.repeat(40),repoUrl:'https://github.com/example/test/tree/'+ 'a'.repeat(40)};
      const backupBaseline={version:1,commitSha:'a'.repeat(40),files:{'README.md':'b'.repeat(40)}};
      const publication={parentSha:'c'.repeat(40),expectedSha:backupResult.sha,createRef:false,baseline:backupBaseline};
      const prepareBackup=async(owner='backup-owner',intent=publication)=>
        (await one('SELECT prepare_requirement_source_checkpoint($1,$2,$3,$4,$5,$6) value',
          [backupRun.requirementId,backupRun.runId,backupRun.executionGeneration,backupRun.sessionId,owner,intent])).value;
      const recordBackup=async(owner='backup-owner',result=backupResult,baseline=backupBaseline)=>
        (await one('SELECT record_requirement_source_checkpoint($1,$2,$3,$4,$5,$6,$7) value',
          [backupRun.requirementId,backupRun.runId,backupRun.executionGeneration,backupRun.sessionId,owner,result,baseline])).value;
      for(const role of ['anon','authenticated','service_role']) {
        assert.equal((await one('SELECT has_table_privilege($1,$2,$3) allowed',[role,'requirement_source_checkpoints','UPDATE'])).allowed,false);
        assert.equal((await one('SELECT has_table_privilege($1,$2,$3) allowed',[role,'requirement_source_checkpoints','SELECT'])).allowed,role==='service_role');
        assert.equal((await one('SELECT has_function_privilege($1,$2,$3) allowed',[role,'prepare_requirement_source_checkpoint(uuid,text,integer,uuid,text,jsonb)','EXECUTE'])).allowed,role==='service_role');
      }
      assert.equal(await prepareBackup('wrong-owner'),false);
      await db.exec('SET ROLE service_role'); assert.equal(await prepareBackup(),true); await db.exec('RESET ROLE');
      assert.deepEqual((await one('SELECT pending_publication,baseline FROM requirement_source_checkpoints')),{pending_publication:publication,baseline:null});
      assert.equal((await one('SELECT count(*)::int n FROM requirement_status')).n,0,'preparing is not a published receipt');
      assert.equal(await recordBackup('backup-owner',{state:'unknown',reason:'lost_ack'},null),true);
      assert.deepEqual((await one('SELECT pending_publication FROM requirement_source_checkpoints')).pending_publication,publication);
      assert.equal(await recordBackup('wrong-owner'),false);
      await db.exec('SET ROLE service_role');assert.equal(await recordBackup(),true);await db.exec('RESET ROLE');
      assert.equal((await one('SELECT status FROM requirements')).status,'in-progress');
      assert.equal((await one('SELECT snapshot FROM harness_sessions')).snapshot.status,'running');
      assert.equal((await one('SELECT repo_url FROM requirement_status WHERE repo_url IS NOT NULL')).repo_url,backupResult.repoUrl);
      assert.equal((await one('SELECT pending_publication FROM requirement_source_checkpoints')).pending_publication,null);
      assert.equal(await prepareBackup(),true);
      assert.deepEqual((await one('SELECT baseline FROM requirement_source_checkpoints')).baseline,backupBaseline,'new intent preserves confirmed baseline');
      assert.equal(await recordBackup('backup-owner',{state:'unknown',reason:'provider_unavailable'},null),true);
      assert.deepEqual((await one('SELECT baseline FROM requirement_source_checkpoints')).baseline,backupBaseline);
      await assert.rejects(()=>recordBackup('backup-owner',{state:'saved',sha:'invalid'},backupBaseline),/Invalid source checkpoint/);
      await assert.rejects(()=>prepareBackup('backup-owner',{...publication,expectedSha:'invalid'}),/Invalid checkpoint publication intent/);
      await db.query("SELECT control_harness_session($1,$2,'pause',null)",[backupRun.sessionId,site]);
      assert.equal(await recordBackup(),false,'user pause fences backup receipts');
      assert.equal(await prepareBackup(),false,'user pause fences publication preparation');
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline requirement cron SQL test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 65_000);