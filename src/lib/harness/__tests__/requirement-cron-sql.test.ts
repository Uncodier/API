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
      // Economic recovery uses the real claim/finish/session/lifecycle SQL above.
      // Billing renewal is an offline boundary; no remote accounts are touched.
      {
      await reset();
      await db.exec("ALTER TABLE requirements ADD COLUMN budget numeric; CREATE TABLE billing(site_id uuid PRIMARY KEY,credits_available numeric); CREATE TABLE harness_model_credit_reservations(requirement_id uuid,site_id uuid,session_id uuid,state text,charged numeric); CREATE TABLE credit_transactions(site_id uuid,amount numeric,transaction_type text,metadata jsonb); CREATE TABLE sandbox_billing_resources(sandbox_name text,site_id uuid,owner_kind text,owner_id uuid); CREATE TABLE sandbox_billing_sessions(sandbox_name text,credits_charged numeric); CREATE FUNCTION renew_site_plan_credits(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{\"success\":true}'::jsonb $$;");
      await db.query('INSERT INTO billing VALUES($1,0)',[site]);
      await db.exec(readFileSync('supabase/migrations/20261026010000_requirement_cycle_budget.sql','utf8'));
      await db.exec('ALTER TABLE sandbox_billing_resources ADD COLUMN deletion_requested_at timestamptz, ADD COLUMN retired_at timestamptz');
      await db.exec(readFileSync('supabase/migrations/20261022000001_sandbox_lifecycle_evidence.sql','utf8'));
      const legacyId=await req(),legacyRun=(await claim()).run;
      await session(legacyRun,'paused','token_budget_exhausted');
      await finish(legacyRun,'paused','token_budget_exhausted');
      await db.exec(readFileSync('supabase/migrations/20261026020000_requirement_economic_recovery.sql','utf8'));
      await db.exec(readFileSync('supabase/migrations/20261026030000_requirement_pause_recovery_commands.sql','utf8'));
      await db.exec(readFileSync('supabase/migrations/20261026030100_requirement_command_diagnostics.sql','utf8'));
      const diagnose=async id=>(await one('SELECT inspect_requirement_commands($1::uuid[],$2) value',[[id],site])).value[id];
      assert.equal((await one('SELECT count(*)::int n FROM requirement_economic_pauses')).n,1,'intact historical token pause imported');
      assert.equal(await claim(),null,'zero account credits keeps legacy pause');
      await db.query('UPDATE billing SET credits_available=20 WHERE site_id=$1',[site]);
      assert.equal(await claim(),null,'backoff prevents immediate repeated scans');
      const retryEconomic=()=>db.exec("UPDATE requirement_economic_pauses SET checked_at='-infinity'");
      await retryEconomic();
      const legacyResume=await claim();
      assert.equal(legacyResume.run.sessionId,legacyRun.sessionId);
      assert.equal(legacyResume.run.executionGeneration,legacyRun.executionGeneration);
      assert.equal((await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[legacyRun.sessionId])).snapshot.allocatedTokens,100);
      assert.equal((await one('SELECT count(*)::int n FROM requirement_status WHERE cycle LIKE \'economic-recovery:%\'')).n,1);
      const economicFixture=async(extra={},reason='token_budget_exhausted') => {
        await reset();
        await db.exec('DELETE FROM harness_model_credit_reservations; DELETE FROM credit_transactions; DELETE FROM sandbox_billing_resources; DELETE FROM sandbox_billing_sessions; UPDATE billing SET credits_available=0');
        const id=await req(),run=(await claim()).run;
        await db.query('UPDATE requirements SET budget=5 WHERE id=$1',[id]);
        await session(run,'paused',reason,{...(reason==='account_credits_exhausted'?{creditRecoveryMinimum:0.4}:{}),...extra});
        await db.query("INSERT INTO harness_model_credit_reservations VALUES($1,$2,$3,'settled',5)",[id,site,run.sessionId]);
        await finish(run,'paused',reason);
        assert.equal((await one('SELECT count(*)::int n FROM requirement_economic_pauses')).n,1);
        return {id,run};
      };
      let econ=await economicFixture();
      const preserved=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
      await db.exec('UPDATE billing SET credits_available=20');
      assert.equal(await claim(),null,'credit top-up alone does not bypass exhausted requirement budget');
      await db.exec('UPDATE requirements SET budget=6; UPDATE billing SET credits_available=0');
      await retryEconomic();assert.equal(await claim(),null,'budget increase alone does not create account credits');
      await db.exec('UPDATE billing SET credits_available=20');await retryEconomic();
      const economicResume=await claim();assert.equal(economicResume.run.sessionId,econ.run.sessionId);
      assert.equal(economicResume.run.executionGeneration,econ.run.executionGeneration);
      const recoveredSnapshot=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
      for(const key of ['messages','turns','allocatedTokens','activeMs','request','uncertainOperations']) assert.deepEqual(recoveredSnapshot[key],preserved[key],key+' retained');
      assert.equal(recoveredSnapshot.status,'queued');
      assert.equal((await one('SELECT count(*)::int n FROM requirement_economic_pauses')).n,0);
      assert.equal(await claim(),null,'same session cannot be claimed twice');
      // Real cleanup triggers reject resume even after leases expire. One fenced
      // requirement must not abort the cron claim for unrelated ordinary work.
      econ=await economicFixture();await db.exec('UPDATE requirements SET budget=10; UPDATE billing SET credits_available=20');
      const cleanupToken=randomUUID();
      await db.query("UPDATE harness_sessions SET sandbox_cleanup_token=$1,sandbox_cleanup_resource='offline-cleanup',sandbox_cleanup_started_at=clock_timestamp() WHERE id=$2",[cleanupToken,econ.run.sessionId]);
      const unrelated=await req();
      assert.equal((await claim()).run.requirementId,unrelated,'cleanup pause cannot block unrelated admission');
      assert.equal((await one('SELECT status FROM requirements WHERE id=$1',[econ.id])).status,'blocked');
      assert.equal((await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[econ.run.sessionId])).snapshot.status,'paused');
      await db.query('SELECT finish_harness_sandbox_cleanup($1,$2,$3)',[econ.run.sessionId,site,cleanupToken]);
      await retryEconomic();
      assert.equal((await claim([unrelated])).run.requirementId,econ.id,'verified cleanup release permits later recovery');
      econ=await economicFixture();await db.exec('UPDATE requirements SET budget=10; UPDATE billing SET credits_available=20');
      const rollbackSnapshot=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
      const independent=await req();
      await db.exec("CREATE FUNCTION reject_economic_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.cycle LIKE 'economic-recovery:%' THEN RAISE EXCEPTION 'Offline audit persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_economic_audit BEFORE INSERT ON requirement_status FOR EACH ROW EXECUTE FUNCTION reject_economic_audit()");
      // Exercise the public entrypoint as service_role, not only as DB owner.
      await db.exec('SET ROLE service_role');
      assert.equal((await claim()).run.requirementId,independent,'audit failure stays isolated');
      await db.exec('RESET ROLE');
      assert.deepEqual((await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[econ.run.sessionId])).snapshot,rollbackSnapshot,'late failure rolls back session resume');
      assert.equal((await one('SELECT status FROM requirements WHERE id=$1',[econ.id])).status,'blocked');
      assert.equal((await one('SELECT pause_reason FROM harness_requirement_runs WHERE requirement_id=$1',[econ.id])).pause_reason,'token_budget_exhausted');
      assert.equal((await one('SELECT last_error_code FROM requirement_economic_pauses WHERE requirement_id=$1',[econ.id])).last_error_code,'P0001');
      await db.exec('DROP TRIGGER reject_economic_audit ON requirement_status; DROP FUNCTION reject_economic_audit()');
      await retryEconomic();assert.equal((await claim([independent])).run.requirementId,econ.id);
      // Every failure leaves the durable pause and its transcript untouched.
      for(const obstruction of ['manual-status','session-pause','held','runner-paused','plan-paused','live-cron','live-session',
        'status-edited','newer-status','generation-edited','billing-missing','billing-nan','billing-error','pending-model','foreign-session-model','excluded']) {
        econ=await economicFixture();
        await db.exec('UPDATE requirements SET budget=10; UPDATE billing SET credits_available=20');
        if(obstruction==='manual-status') await db.exec("UPDATE requirements SET status='blocked'");
        if(obstruction==='session-pause') await db.query("SELECT control_harness_session($1,$2,'pause')",[econ.run.sessionId,site]);
        if(obstruction==='held') await db.exec("UPDATE requirements SET metadata=metadata||'{\"execution_hold\":{\"kind\":\"security\"}}'");
        if(obstruction==='runner-paused') await db.exec("UPDATE remote_instances SET status='paused'");
        if(obstruction==='plan-paused') await db.query("INSERT INTO instance_plans(site_id,instance_id,status) VALUES($1,$2,'paused')",[site,econ.run.instanceId]);
        if(obstruction==='live-cron') await db.exec("UPDATE requirements SET cron_lock_expires_at=now()+interval '1 hour',cron_lock_active=true");
        if(obstruction==='live-session') await db.exec("UPDATE harness_sessions SET lease_owner='offline-owner',lease_expires_at=now()+interval '1 hour'");
        if(obstruction==='status-edited') await db.exec("UPDATE requirement_status SET message='Manual stop'");
        if(obstruction==='newer-status') await db.query("INSERT INTO requirement_status(requirement_id,site_id,stage,updated_at) VALUES($1,$2,'blocked',clock_timestamp()+interval '1 second')",[econ.id,site]);
        if(obstruction==='generation-edited') await db.exec("UPDATE requirements SET metadata=metadata||'{\"requirement_execution_generation\":\"bad\"}'");
        if(obstruction==='billing-missing') await db.exec('DELETE FROM billing');
        if(obstruction==='billing-nan') await db.exec("UPDATE billing SET credits_available='NaN'");
        if(obstruction==='billing-error') await db.exec("CREATE OR REPLACE FUNCTION renew_site_plan_credits(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{\"success\":false}'::jsonb $$");
        if(obstruction==='pending-model'||obstruction==='foreign-session-model') await db.query("INSERT INTO harness_model_credit_reservations VALUES($1,$2,$3,'pending',NULL)",[obstruction==='pending-model'?econ.id:randomUUID(),site,econ.run.sessionId]);
        const beforePause=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
        assert.equal(await claim(obstruction==='excluded'?[econ.id]:[]),null,obstruction+' must not auto-resume');
        assert.equal((await one('SELECT status FROM requirements')).status,'blocked');
        assert.deepEqual((await one('SELECT snapshot FROM harness_sessions')).snapshot,beforePause);
        if(obstruction==='billing-missing') await db.query('INSERT INTO billing VALUES($1,0)',[site]);
        if(obstruction==='billing-error') await db.exec("CREATE OR REPLACE FUNCTION renew_site_plan_credits(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{\"success\":true}'::jsonb $$");
      }
      for(const extra of [
        {uncertainOperations:['offline-fingerprint']},
        {messages:[{role:'assistant',content:'',toolCalls:[{id:'offline-call',name:'exec',arguments:'{}'}]}]},
      ]) {
        econ=await economicFixture(extra);await db.exec('UPDATE requirements SET budget=10; UPDATE billing SET credits_available=20');
        assert.equal(await claim(),null,'uncertain or unfinished effects stay fenced');
      }
      econ=await economicFixture();await db.exec('UPDATE requirements SET budget=10; UPDATE billing SET credits_available=20');
      await db.query("SELECT control_harness_session($1,$2,'pause')",[econ.run.sessionId,site]);
      assert.equal((await one('SELECT snapshot FROM harness_sessions')).snapshot.reason,'user_pause','manual controls cannot inherit an exhausted reason');
      await finish(econ.run,'paused','token_budget_exhausted');
      assert.equal(await claim(),null,'stale economic finish cannot recapture a manual pause');
      // Real trusted command admission must not invalidate a recoverable pause.
      await db.exec("ALTER TABLE instance_logs ADD COLUMN user_id uuid; ALTER TABLE requirements ADD COLUMN completion_status text DEFAULT 'pending'; CREATE FUNCTION site_user_has_effective_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;");
      const queueReopen=async(fixture,patch={status:'in-progress'},status='completed') => {
        const actionId=randomUUID();
        await db.query("INSERT INTO instance_logs(id,site_id,user_id,instance_id,log_type,trusted_user_action,details,created_at) VALUES($1,$2,$3,$4,'user_action',true,$5,clock_timestamp())",
          [actionId,site,user,fixture.run.instanceId,{status}]);
        await db.query('SELECT submit_requirement_command($1,$2,$3,$4,$5,$6)',[fixture.id,site,user,fixture.run.instanceId,actionId,patch]);
        return actionId;
      };
      for(const reason of ['token_budget_exhausted','account_credits_exhausted','turn_budget_exhausted','active_time_budget_exhausted']) {
        econ=await economicFixture({},reason);
        await db.exec('UPDATE requirements SET budget=NULL; UPDATE billing SET credits_available=20');
        if(reason==='turn_budget_exhausted'||reason==='active_time_budget_exhausted') {
          assert.equal(await claim(),null,'retired limits require explicit authorization');await retryEconomic();
        }
        const before=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
        await queueReopen(econ);
        const diagnosticBefore=await diagnose(econ.id);
        assert.equal(diagnosticBefore.state,'queued',JSON.stringify(diagnosticBefore));
        assert.equal(diagnosticBefore.reason,'waiting_scheduler');
        const resumed=await claim();
        assert.equal(resumed.run.sessionId,econ.run.sessionId,reason+' retains session');
        assert.equal(resumed.run.executionGeneration,econ.run.executionGeneration+1,reason+' command increments generation once');
        assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE applied_at IS NULL')).n,0);
        assert.equal((await diagnose(econ.id)).state,'applied','applied receipt does not claim delivery');
        const after=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
        for(const key of ['messages','turns','allocatedTokens','activeMs','request','uncertainOperations']) assert.deepEqual(after[key],before[key],reason+' retains '+key);
      }
      econ=await economicFixture({},'account_credits_exhausted');
      await db.exec('UPDATE requirements SET budget=NULL; UPDATE billing SET credits_available=20');
      assert.equal((await claim()).run.sessionId,econ.run.sessionId,'proven predispatch credit rejection recovers without another message');
      econ=await economicFixture({},'account_credits_exhausted');
      await db.exec('UPDATE requirements SET budget=NULL; UPDATE billing SET credits_available=0.01');
      await queueReopen(econ);
      const underfundedSnapshot=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
      for(let retry=0;retry<2;retry++) {
        await retryEconomic();assert.equal(await claim(),null,'positive but inadequate unchanged balance cannot restart workspace');
        assert.equal((await diagnose(econ.id)).reason,'credits_insufficient_for_reservation');
        assert.deepEqual((await one('SELECT snapshot FROM harness_sessions')).snapshot,underfundedSnapshot);
      }
      await db.exec('UPDATE billing SET credits_available=0.4');await retryEconomic();
      assert.equal((await claim()).run.sessionId,econ.run.sessionId,'exact rejected reservation amount permits recovery');
      for(const creditRecoveryMinimum of [null,0,-1,'0.4']) {
        econ=await economicFixture({creditRecoveryMinimum},'account_credits_exhausted');
        await db.exec('UPDATE requirements SET budget=NULL; UPDATE billing SET credits_available=20');
        await queueReopen(econ);
        assert.equal(await claim(),null,'invalid admission evidence cannot authorize recovery');
        assert.equal((await diagnose(econ.id)).reason,'credit_admission_evidence_unavailable');
      }
      for(const patch of [{budget:10},{budget:null}]) {
        econ=await economicFixture();await db.exec('UPDATE billing SET credits_available=20');
        await queueReopen(econ,patch);
        assert.equal((await claim()).run.sessionId,econ.run.sessionId,'queued budget repair applies atomically with resume');
        assert.equal((await one('SELECT budget::float8 AS budget FROM requirements')).budget,patch.budget);
      }
      for(const obstruction of ['zero-budget','no-credits','running-action','cancelled-action','manual-pause','unrelated-edit',
        'forged-revision','pending-model','uncertain','pending-call','cleanup','audit-failure']) {
        econ=await economicFixture(obstruction==='uncertain'?{uncertainOperations:['offline-unknown']}:
          obstruction==='pending-call'?{pending:{call:{id:'offline-pending',name:'exec',arguments:'{}'},fingerprint:'offline-fingerprint',effect:'write'}}:{});
        await db.exec('UPDATE billing SET credits_available=20');
        const actionId=await queueReopen(econ,{budget:obstruction==='zero-budget'?0:10},obstruction==='running-action'?'running':'completed');
        if(obstruction==='cancelled-action') await db.query("UPDATE instance_logs SET details='{\"status\":\"cancelled\"}' WHERE id=$1",[actionId]);
        if(obstruction==='no-credits') await db.exec('UPDATE billing SET credits_available=0');
        if(obstruction==='manual-pause') await db.query("SELECT control_harness_session($1,$2,'pause')",[econ.run.sessionId,site]);
        if(obstruction==='unrelated-edit') await db.exec("UPDATE requirements SET title='Operator hold'");
        if(obstruction==='forged-revision') await db.exec('UPDATE requirements SET external_user_action_revision=external_user_action_revision+1');
        if(obstruction==='pending-model') await db.query("INSERT INTO harness_model_credit_reservations VALUES($1,$2,$3,'pending',NULL)",[econ.id,site,econ.run.sessionId]);
        if(obstruction==='cleanup') await db.exec("UPDATE harness_sessions SET sandbox_cleanup_token=gen_random_uuid(),sandbox_cleanup_resource='offline-vm',sandbox_cleanup_started_at=clock_timestamp()");
        if(obstruction==='audit-failure') await db.exec("CREATE FUNCTION reject_command_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.cycle LIKE 'economic-recovery:%' THEN RAISE EXCEPTION 'offline audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_command_recovery_audit BEFORE INSERT ON requirement_status FOR EACH ROW EXECUTE FUNCTION reject_command_recovery_audit();");
        const before=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
        assert.equal(await claim(),null,obstruction+' stays safely blocked');
        assert.equal((await one('SELECT status FROM requirements')).status,'blocked');
        assert.equal((await one('SELECT applied_at FROM requirement_commands')).applied_at,null);
        assert.equal((await one('SELECT budget::float8 AS budget FROM requirements')).budget,5,'no partial budget mutation');
        assert.deepEqual((await one('SELECT snapshot FROM harness_sessions')).snapshot,before,'no partial session resume');
        const expectedReason={
          'zero-budget':'budget_exhausted','no-credits':'credits_exhausted','running-action':'action_unfinished',
          'cancelled-action':'action_cancelled','manual-pause':'session_paused','unrelated-edit':'economic_provenance_mismatch',
          'forged-revision':'economic_provenance_mismatch','pending-model':'model_reservation_pending','uncertain':'effects_pending',
          'pending-call':'effects_pending','cleanup':'cleanup_pending','audit-failure':'recovery_failed',
        }[obstruction];
        const diagnostic=await diagnose(econ.id);
        assert.equal(diagnostic.state,'blocked',obstruction+JSON.stringify(diagnostic));
        assert.equal(diagnostic.reason,expectedReason,obstruction+JSON.stringify(diagnostic));
        assert.deepEqual((await one('SELECT snapshot FROM harness_sessions')).snapshot,before,'diagnostics are read-only');
        if(obstruction==='audit-failure') await db.exec('DROP TRIGGER reject_command_recovery_audit ON requirement_status; DROP FUNCTION reject_command_recovery_audit()');
      }
      // Pre-install command admission changes requirement xmin, but does not
      // alter the original mapping/status finish transaction. Reproduce the
      // production shape with missing capture and several real trusted commands.
      const importCommandPauses=()=>db.exec(readFileSync('supabase/migrations/20261027010000_requirement_command_pause_import.sql','utf8'));
      for(const obstruction of ['none','later-row-write','forged-revision','status-edit','mapping-edit',
        'manual-pause','wrong-user','missing-session','cancelled-action','running-action','no-credits','pending-model']) {
        econ=await economicFixture();
        await db.exec('DELETE FROM requirement_economic_pauses; UPDATE billing SET credits_available=20');
        await queueReopen(econ,{budget:10});
        const newest=await queueReopen(econ,{status:'in-progress'},obstruction==='running-action'?'running':'completed');
        if(obstruction==='later-row-write') await db.exec("UPDATE requirements SET title='Operator edit'");
        if(obstruction==='forged-revision') await db.exec('UPDATE requirements SET external_user_action_revision=external_user_action_revision+1');
        if(obstruction==='status-edit') await db.exec("UPDATE requirement_status SET message='Operator edit'");
        if(obstruction==='mapping-edit') await db.exec("UPDATE harness_requirement_runs SET workspace_id='other'");
        if(obstruction==='manual-pause') await db.query("SELECT control_harness_session($1,$2,'pause')",[econ.run.sessionId,site]);
        if(obstruction==='wrong-user') {
          const otherUser=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[otherUser]);
          await db.exec('DELETE FROM harness_sessions');
          await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[econ.run.sessionId,site,otherUser,initial(econ.run.sessionId)]);
          const owned=(await one('SELECT claim_harness_session($1,$2,$3,300) value',[econ.run.sessionId,site,'other-user'])).value;
          await db.query('SELECT save_harness_session($1,$2,$3,$4)',[econ.run.sessionId,site,'other-user',{...owned,status:'paused',reason:'token_budget_exhausted'}]);
          await db.query('SELECT release_harness_session($1,$2,$3)',[econ.run.sessionId,site,'other-user']);
        }
        if(obstruction==='missing-session') await db.exec('DELETE FROM harness_sessions');
        if(obstruction==='cancelled-action') await db.query("UPDATE instance_logs SET details='{\"status\":\"cancelled\"}' WHERE id=$1",[newest]);
        if(obstruction==='no-credits') await db.exec('UPDATE billing SET credits_available=0');
        if(obstruction==='pending-model') await db.query("INSERT INTO harness_model_credit_reservations VALUES($1,$2,$3,'pending',NULL)",[econ.id,site,econ.run.sessionId]);
        const before=(await one('SELECT snapshot FROM harness_sessions'))?.snapshot;
        await importCommandPauses();await importCommandPauses();
        assert.deepEqual((await one('SELECT snapshot FROM harness_sessions'))?.snapshot,before,'import does not resume or reset');
        assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE applied_at IS NOT NULL')).n,0,'import does not apply commands');
        const expectedImport=['none','no-credits','pending-model'].includes(obstruction);
        assert.equal((await one('SELECT count(*)::int n FROM requirement_economic_pauses')).n,expectedImport?1:0,obstruction+' import eligibility');
        const resumed=await claim();
        if(obstruction==='none') {
          assert.equal(resumed.run.sessionId,econ.run.sessionId);
          assert.equal(resumed.run.executionGeneration,econ.run.executionGeneration+1);
          assert.equal((await one('SELECT budget::float8 AS budget FROM requirements')).budget,10);
          const after=(await one('SELECT snapshot FROM harness_sessions')).snapshot;
          for(const key of ['messages','request','turns','allocatedTokens','activeMs']) assert.deepEqual(after[key],before[key],key+' preserved after legacy import');
        } else assert.equal(resumed,null,obstruction+' cannot start');
      }
      // Ambiguous billing and explicit manual controls never gain economic provenance.
      for(const reason of ['assistant_execution_requires_reconciliation','billing_unavailable_or_exhausted','user_pause','provider_admission_requires_operator']) {
        await reset();await db.exec('DELETE FROM harness_model_credit_reservations; UPDATE billing SET credits_available=20');
        const id=await req(),run=(await claim()).run;
        await session(run,'paused',reason);await finish(run,'paused',reason);
        await queueReopen({id,run});
        await importCommandPauses();
        assert.equal((await one('SELECT count(*)::int n FROM requirement_economic_pauses')).n,0);
        assert.equal(await claim(),null,reason+' requires diagnosis, not blind retry');
      }
      // A real authorized session resume must not remain blocked by its old
      // non-economic mapping reason. An active/manual pause is still excluded.
      for(const reason of ['WORKSPACE_AUTHORIZATION_REQUIRED','user_pause']) {
        await reset();await db.exec('DELETE FROM harness_model_credit_reservations; UPDATE billing SET credits_available=20');
        const id=await req(),run=(await claim()).run;
        await session(run,'paused',reason);await finish(run,'paused',reason);
        await queueReopen({id,run});
        assert.equal(await claim(),null,'command alone cannot clear '+reason);
        await db.query("SELECT control_harness_session($1,$2,'resume')",[run.sessionId,site]);
        assert.equal((await diagnose(id)).reason,'waiting_scheduler','old mapping reason is not an active pause');
        assert.equal((await claim()).run.sessionId,run.sessionId,'explicitly resumed session accepts queued command');
      }
      // Run the actual one-time operator SQL, substituting only incident IDs and
      // the fixture's exact session version. No production connection or writes.
      {
        const repairSource=readFileSync('scripts/repair-aed8167c-reconciliation-pause.sql','utf8');
        const repairFixture=async(extra={}) => {
          await reset();await db.exec('DELETE FROM harness_model_credit_reservations; UPDATE billing SET credits_available=20');
          const id=await req('backlog',{requirement_execution_generation:2}),run=(await claim()).run;
          const snapshot=initial(run.sessionId);snapshot.request.requirementId=id;
          await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[run.sessionId,site,user,snapshot]);
          const leased=(await one('SELECT claim_harness_session($1,$2,$3,300) value',[run.sessionId,site,'offline-owner'])).value;
          await db.query('SELECT save_harness_session($1,$2,$3,$4)',[run.sessionId,site,'offline-owner',{
            ...leased,status:'paused',reason:'assistant_execution_requires_reconciliation',turns:3,allocatedTokens:100,activeMs:20,
            messages:[{role:'assistant',content:'Historical tool',toolCalls:[{id:'historical',name:'read',arguments:'{}'}]},
              {role:'tool',toolCallId:'historical',content:'Historical result'}],...extra}]);
          await db.query('SELECT release_harness_session($1,$2,$3)',[run.sessionId,site,'offline-owner']);
          await finish(run,'paused','assistant_execution_requires_reconciliation');
          await db.query('UPDATE requirements SET external_user_action_revision=6 WHERE id=$1',[id]);
          const action=await queueReopen({id,run},{budget:10,status:'in-progress'});
          const version=(await one('SELECT version FROM harness_sessions WHERE id=$1',[run.sessionId])).version;
          const sql=repairSource.replaceAll('aed8167c-a4fc-43ed-824d-832c9163cd1b',id)
            .replaceAll('96d3d132-7ad7-4f36-8a41-440f44dc7d50',run.sessionId)
            .replaceAll('9be0a6a2-5567-41bf-ad06-cb4014f0faf2',site)
            .replace('expected_session_version CONSTANT bigint := 587','expected_session_version CONSTANT bigint := '+version);
          return {id,run,action,sql};
        };
        const repairEvidence=async()=> (await one("SELECT jsonb_build_object("+
          "'sessions',(SELECT jsonb_agg(to_jsonb(s)) FROM harness_sessions s),"+
          "'requirements',(SELECT jsonb_agg(to_jsonb(r)) FROM requirements r),"+
          "'mappings',(SELECT jsonb_agg(to_jsonb(h)) FROM harness_requirement_runs h),"+
          "'commands',(SELECT jsonb_agg(to_jsonb(c)) FROM requirement_commands c),"+
          "'statuses',(SELECT jsonb_agg(to_jsonb(st)) FROM requirement_status st)) value")).value;
        const rejectedRepair=async(f,pattern=/Incident repair refused/) => {
          const before=await repairEvidence();
          await assert.rejects(()=>db.exec(f.sql),pattern);await db.exec('ROLLBACK');
          assert.deepEqual(await repairEvidence(),before,'refusal is atomic');
        };
        for(const obstruction of ['version','generation','reason','assistantExecutionVersion','assistantAuditCursor','auditCursor',
          'pending','uncertain','unmatched','reservation','session-lease','cron-lease','cleanup','user-pause','paused-owner',
          'paused-origin','paused-plan','untrusted','running-action','old-action','revision','missing-command','late-error']) {
          const extra={};
          if(['assistantExecutionVersion','assistantAuditCursor','auditCursor'].includes(obstruction)) extra[obstruction]=0;
          if(obstruction==='pending') extra.pending={call:{id:'pending',name:'read',arguments:'{}'},fingerprint:'offline',effect:'read'};
          if(obstruction==='uncertain') extra.uncertainOperations=['offline'];
          if(obstruction==='unmatched') extra.messages=[{role:'assistant',content:'',toolCalls:[{id:'unmatched',name:'read',arguments:'{}'}]}];
          const f=await repairFixture(extra);
          if(obstruction==='version') f.sql=f.sql.replace(/expected_session_version CONSTANT bigint := [0-9]+/,'expected_session_version CONSTANT bigint := 587');
          if(obstruction==='generation') await db.exec('UPDATE harness_requirement_runs SET generation=3');
          if(obstruction==='reason') await db.exec("UPDATE harness_requirement_runs SET pause_reason='user_pause'");
          if(obstruction==='reservation') await db.query("INSERT INTO harness_model_credit_reservations VALUES($1,$2,$3,'pending',NULL)",[f.id,site,f.run.sessionId]);
          if(obstruction==='session-lease') await db.exec("UPDATE harness_sessions SET lease_owner='offline-live',lease_expires_at=now()+interval '1 hour'");
          if(obstruction==='cron-lease') await db.exec("UPDATE requirements SET cron_lock_expires_at=now()+interval '1 hour'");
          if(obstruction==='cleanup') await db.exec("UPDATE harness_sessions SET sandbox_cleanup_token=gen_random_uuid(),sandbox_cleanup_resource='offline-vm',sandbox_cleanup_started_at=clock_timestamp()");
          if(obstruction==='user-pause') await db.exec("UPDATE requirements SET metadata=metadata||'{\"user_paused\":true}'");
          if(obstruction==='paused-owner') await db.exec("UPDATE remote_instances SET status='paused'");
          if(obstruction==='paused-origin') {
            const origin=randomUUID();
            await db.query("INSERT INTO remote_instances(id,site_id,user_id,created_by,name,instance_type,status) VALUES($1,$2,$3,$3,'offline-origin','ubuntu','paused')",[origin,site,user]);
            await db.query("UPDATE requirements SET metadata=metadata||jsonb_build_object('assistant_origin_instance_id',$1::text)",[origin]);
          }
          if(obstruction==='paused-plan') await db.query("INSERT INTO instance_plans(site_id,instance_id,status) VALUES($1,$2,'paused')",[site,f.run.instanceId]);
          if(obstruction==='untrusted') await db.query('UPDATE instance_logs SET trusted_user_action=false WHERE id=$1',[f.action]);
          if(obstruction==='running-action') await db.query("UPDATE instance_logs SET details='{\"status\":\"running\"}' WHERE id=$1",[f.action]);
          if(obstruction==='old-action') await db.query("UPDATE instance_logs SET created_at='2000-01-01' WHERE id=$1",[f.action]);
          if(obstruction==='revision') await db.exec('UPDATE requirements SET external_user_action_revision=8');
          if(obstruction==='missing-command') await db.exec('DELETE FROM requirement_commands');
          if(obstruction==='late-error') await db.exec("CREATE FUNCTION reject_operator_resume() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot->>'status'='queued' THEN RAISE EXCEPTION 'offline resume unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_operator_resume AFTER UPDATE ON harness_sessions FOR EACH ROW EXECUTE FUNCTION reject_operator_resume();");
          await rejectedRepair(f,obstruction==='late-error'?/offline resume unavailable/:/Incident repair refused/);
          if(obstruction==='late-error') await db.exec('DROP TRIGGER reject_operator_resume ON harness_sessions; DROP FUNCTION reject_operator_resume()');
        }
        const f=await repairFixture();
        assert.equal(await claim(),null,'queued command alone cannot clear reconciliation pause');
        const before=await repairEvidence();await db.exec(f.sql);const after=await repairEvidence();
        for(const key of ['requirements','mappings','commands','statuses']) assert.deepEqual(after[key],before[key],'repair does not mutate '+key);
        const old=before.sessions[0].snapshot,current=after.sessions[0].snapshot;
        assert.equal(current.status,'queued');assert.equal(current.version,old.version+1);
        assert.deepEqual({...current,status:old.status,version:old.version,updatedAt:old.updatedAt},old,'control preserves all historical evidence and counters');
        await rejectedRepair(f);
        const resumed=await claim();assert.equal(resumed.run.sessionId,f.run.sessionId);
        assert.equal(resumed.run.executionGeneration,3,'existing drainer increments generation exactly once');
        assert.equal((await one('SELECT budget::float8 budget FROM requirements WHERE id=$1',[f.id])).budget,10);
        assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE applied_at IS NULL')).n,0);
        const admitted=(await one('SELECT evaluate_requirement_cycle_budget($1,$2,$3,$4) value',[f.id,resumed.run.runId,3,f.run.sessionId])).value;
        assert.equal(admitted.state,'available','normal budget admission remains in control');
        await db.query('UPDATE requirements SET budget=0 WHERE id=$1',[f.id]);
        assert.equal((await one('SELECT evaluate_requirement_cycle_budget($1,$2,$3,$4) value',
          [f.id,resumed.run.runId,3,f.run.sessionId])).value.state,'exhausted','operator resume does not bypass monetary budget');
      }
      // Fresh budget check can block before ANY session/workspace exists.
      for(const manual of [false,true]) {
        await reset();await db.exec('DELETE FROM harness_model_credit_reservations; UPDATE billing SET credits_available=20');
        const id=await req(),run=(await claim()).run;
        await db.exec('UPDATE requirements SET budget=0');
        await db.query('SELECT evaluate_requirement_cycle_budget($1,$2,$3,$4)',[id,run.runId,run.executionGeneration,run.sessionId]);
        if(manual) await db.exec("UPDATE requirements SET status='blocked'");
        await queueReopen({id,run},{budget:10});
        const resumed=await claim();
        if(manual) {
          assert.equal(resumed,null,'ordinary command drain cannot bypass invalidated pre-session pause');
          assert.equal((await diagnose(id)).reason,'economic_provenance_unavailable');
        } else assert.equal(resumed.run.sessionId,run.sessionId,'pre-session command recovery retains mapping');
      }
      // An older unfinished revision cannot be leapfrogged by a newer budget fix.
      econ=await economicFixture({},'turn_budget_exhausted');
      await db.exec('UPDATE billing SET credits_available=20');
      const olderAction=await queueReopen(econ,{budget:10},'running');
      const newestAction=await queueReopen(econ,{budget:12});
      assert.equal(await claim(),null);
      assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE applied_at IS NULL')).n,2);
      await db.query("UPDATE instance_logs SET details='{\"status\":\"completed\"}' WHERE id=$1",[olderAction]);
      await retryEconomic();
      assert.equal((await claim()).run.executionGeneration,econ.run.executionGeneration+1);
      assert.equal((await one('SELECT budget::float8 AS budget FROM requirements')).budget,12);
      const duplicate=await one('SELECT submit_requirement_command($1,$2,$3,$4,$5,$6) value',
        [econ.id,site,user,econ.run.instanceId,newestAction,{budget:999}]);
      assert.equal(duplicate.value.state,'duplicate');
      assert.equal((await one('SELECT budget::float8 AS budget FROM requirements')).budget,12,'replay cannot overwrite applied recovery');
      // Unpaused ordinary commands still use their ready-prefix contract.
      await reset();await db.exec('DELETE FROM harness_model_credit_reservations');
      const ordinaryId=await req(),ordinaryRun=(await claim()).run;
      await session(ordinaryRun,'completed','implemented');await finish(ordinaryRun,'completed');
      await queueReopen({id:ordinaryId,run:ordinaryRun},{budget:null});
      assert.equal((await claim()).run.requirementId,ordinaryId,'ordinary terminal command remains eligible');
      await reset();await db.exec('DELETE FROM harness_model_credit_reservations; UPDATE billing SET credits_available=20');
      const noSessionId=await req(),noSessionRun=(await claim()).run;
      await db.exec('UPDATE requirements SET budget=0');
      assert.equal((await one('SELECT evaluate_requirement_cycle_budget($1,$2,$3,$4) value',[noSessionId,noSessionRun.runId,noSessionRun.executionGeneration,noSessionRun.sessionId])).value.state,'exhausted');
      assert.equal((await one('SELECT count(*)::int n FROM harness_sessions')).n,0);
      assert.equal((await one('SELECT count(*)::int n FROM requirement_economic_pauses')).n,1);
      await db.exec('UPDATE requirements SET budget=1');
      assert.equal((await claim()).run.sessionId,noSessionRun.sessionId,'pre-workspace budget pause resumes same mapping');
      // Shared observation keeps actual settled tool/model/VM attribution, refunds
      // and unresolved reservations separate (never a new debit or reservation).
      await db.query("INSERT INTO harness_model_credit_reservations VALUES($1,$2,$3,'settled',2),($1,$2,$3,'pending',NULL)",[noSessionId,site,noSessionRun.sessionId]);
      await db.query("INSERT INTO credit_transactions VALUES($1,-3,'tool',$2),($1,1,'refund',$2),($1,-100,'agent_model_reservation',$2)",[site,{requirement_id:noSessionId}]);
      await db.query("INSERT INTO sandbox_billing_resources VALUES('offline-vm',$1,'requirement',$2)",[site,noSessionId]);
      await db.exec("INSERT INTO sandbox_billing_sessions VALUES('offline-vm',1)");
      const observed=(await one('SELECT requirement_budget_observation($1) value',[noSessionId])).value;
      assert.equal(observed.spent_usd,5);assert.equal(observed.pending_model_reservations,1);
      for(const role of ['anon','authenticated','service_role']) {
        assert.equal((await one("SELECT has_table_privilege($1,'requirement_economic_pauses','SELECT') ok",[role])).ok,false);
        assert.equal((await one("SELECT has_function_privilege($1,'recheck_requirement_economic_pauses(uuid[])','EXECUTE') ok",[role])).ok,false);
        assert.equal((await one("SELECT has_function_privilege($1,'apply_recovered_requirement_commands(uuid,jsonb)','EXECUTE') ok",[role])).ok,false);
        assert.equal((await one("SELECT has_function_privilege($1,'requirement_pause_command_guard(uuid,jsonb)','EXECUTE') ok",[role])).ok,false);
        assert.equal((await one("SELECT has_function_privilege($1,'inspect_requirement_commands(uuid[],uuid)','EXECUTE') ok",[role])).ok,role==='service_role');
      }
      assert.deepEqual((await one('SELECT inspect_requirement_commands($1::uuid[],$2) value',[[noSessionId,randomUUID()],randomUUID()])).value,{},'other tenant and missing rows are omitted');
      assert.equal((await diagnose(noSessionId)).state,'none');
      await assert.rejects(()=>db.query('SELECT inspect_requirement_commands($1::uuid[],$2)',[Array(501).fill(noSessionId),site]),/Invalid requirement diagnostic scope/);
      }
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline requirement cron SQL test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 65_000);