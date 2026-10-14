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
    const session=async(run,status,reason) => {
      await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[run.sessionId,site,user,initial(run.sessionId)]);
      const s=(await one('SELECT claim_harness_session($1,$2,$3,300) value',[run.sessionId,site,'offline-owner'])).value;
      await db.query('SELECT save_harness_session($1,$2,$3,$4)',[run.sessionId,site,'offline-owner',{...s,status,reason,turns:3,allocatedTokens:100,activeMs:20}]);
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
      for(const file of ['20260923230000_durable_review_quarantine.sql','20260923230100_stamp_review_quarantine.sql','20260930010000_requirement_migration_lifecycle.sql','20261003010000_migration_execution_handoff.sql','20261014010000_portable_harness_sessions.sql','20261014020000_portable_harness_host_state.sql','20261014030000_agent_driven_requirement_cron.sql']) await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
      await db.query('INSERT INTO sites VALUES($1)',[site]);await db.query('INSERT INTO auth.users VALUES($1)',[user]);
      for(const role of ['anon','authenticated','service_role']) {
        assert.equal((await one('SELECT has_table_privilege($1,$2,$3) allowed',[role,'harness_requirement_runs','UPDATE'])).allowed,false);
        for(const fn of ['claim_agent_requirement_run(uuid[],integer,integer,uuid[])','assert_agent_requirement_run(uuid,text,integer,uuid,boolean,integer)','finish_agent_requirement_cycle(uuid,text,integer,uuid,text,text,text,text)','patch_agent_requirement_progress(uuid,text,integer,uuid,uuid,text,text,text,text,bigint)'])
          assert.equal((await one('SELECT has_function_privilege($1,$2,$3) allowed',[role,fn,'EXECUTE'])).allowed,role==='service_role');
      }
      assert.equal((await one("SELECT relrowsecurity value FROM pg_class WHERE oid='harness_requirement_runs'::regclass")).value,true);
      assert.equal((await one("SELECT has_function_privilege('service_role','agent_requirement_runner_allowed(uuid,uuid)','EXECUTE') allowed")).allowed,false);
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
      await db.query("UPDATE requirements SET metadata=metadata||'{\"requirement_execution_generation\":1}' WHERE id=$1",[waiting]);const g=await claim();assert.equal(g.run.sessionId,f.run.sessionId);assert.equal(g.run.executionGeneration,1);
      await finish(g.run,'paused','token_budget_exhausted');assert.equal(await claim(),null);await reset();
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
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline requirement cron SQL test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 65_000);