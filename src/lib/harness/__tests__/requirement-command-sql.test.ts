import { spawnSync } from 'node:child_process';

it('queues trusted cross-instance requirement commands and drains only quiescent ordered batches offline', () => {
  // Real forward SQL in ephemeral PGlite only; no credentials, .env, network,
  // production migration or multi-connection lock-contention claims.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const site = randomUUID(), otherSite = randomUUID(), user = randomUUID(), member = randomUUID(), stranger = randomUUID();
    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const row = id => one('SELECT * FROM requirements WHERE id=$1', [id]);
    const submit = async (id, actionId, patch, scope = {}) => (await one(
      'SELECT public.submit_requirement_command($1,$2,$3,$4,$5,$6) value',
      [id, scope.site ?? site, scope.user ?? user, scope.instance ?? source, actionId, patch])).value;
    const apply = () => db.exec('SELECT public.apply_pending_requirement_commands()');
    const authorized = async (id, completedAt) => (await one('SELECT public.has_requirement_scope_authorization($1,$2::timestamptz) value',[id,completedAt])).value;
    const claim = async () => (await one("SELECT public.claim_agent_requirement_run('{}',10,300) value")).value;
    const finish = async (run, status) => (await one(
      'SELECT public.finish_agent_requirement_cycle($1,$2,$3,$4,$5,$6,$7) value',
      [run.requirementId, run.runId, run.executionGeneration, run.sessionId, status, status === 'completed' ? 'implemented' : null, 'Offline cycle'])).value;
    const instance = async (tenant = site, actor = user) => {
      const id = randomUUID();
      await db.query("INSERT INTO remote_instances(id,site_id,user_id,created_by,name,instance_type,status) VALUES($1,$2,$3,$3,'Offline instance','browser','running')", [id,tenant,actor]);
      return id;
    };
    let source;
    const action = async (status = 'running', extra = {}) => {
      const id = randomUUID();
      await db.query('INSERT INTO instance_logs(id,site_id,user_id,instance_id,log_type,trusted_user_action,message,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id,extra.site ?? site,extra.user ?? user,extra.instance ?? source,extra.type ?? 'user_action',extra.trusted ?? true,
          'One original user message can update several requirements', {status,original:'Unmodified message metadata'}]);
      return id;
    };
    const req = async (status = 'in-progress', metadata = {}, owner = undefined) => {
      const id = randomUUID(), runner = owner === undefined ? await instance() : owner;
      await db.query('INSERT INTO requirements(id,site_id,user_id,status,metadata,backlog) VALUES($1,$2,$3,$4,$5,$6)',
        [id,site,user,status,{requirement_execution_generation:4, budget_spent:71, active_sandbox_id:'offline-workspace',
          ...(runner ? {runner_instance_id:runner,assistant_origin_instance_id:runner} : {}),...metadata},
          {items:[{id:'existing',status:'needs_review',attempts:12,review_quarantine:{active:true,external_action_revision:0}}]}]);
      if (runner) await action('completed',{instance:runner});
      return {id,runner};
    };
    const reset = () => db.exec('DELETE FROM requirement_migration_lifecycle; DELETE FROM requirement_status; DELETE FROM requirements; DELETE FROM harness_sessions; DELETE FROM instance_plans;');
    const initial = id => ({id,version:0,status:'queued',request:{objective:'Offline task',repository:{url:'https://example.test/repository'},limits:{maxTurns:10,maxOutputTokens:1024,maxTotalTokens:10000,maxActiveMs:30000}},messages:[],turns:0,allocatedTokens:0,activeMs:0,uncertainOperations:[],createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()});
    const session = async (run, status, reason) => {
      await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)', [run.sessionId,site,user,initial(run.sessionId)]);
      const snapshot = (await one('SELECT public.claim_harness_session($1,$2,$3,300) value',[run.sessionId,site,'offline-owner'])).value;
      await db.query('SELECT public.save_harness_session($1,$2,$3,$4)', [run.sessionId,site,'offline-owner',
        {...snapshot,status,reason,turns:3,allocatedTokens:100,activeMs:20,messages:[{role:'user',content:'Existing transcript'}]}]);
      await db.query('SELECT public.release_harness_session($1,$2,$3)', [run.sessionId,site,'offline-owner']);
    };
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE sites(id uuid PRIMARY KEY);');
      // Deliberately permissive defaults exercise explicit service-only revokes.
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;');
      await db.exec(
        "CREATE TYPE requirement_type AS ENUM ('task','project');" +
        "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,user_id uuid NOT NULL,title text NOT NULL DEFAULT 'Offline',description text,instructions text,priority text NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),status text NOT NULL CHECK(status IN ('backlog','in-progress','blocked','on-review','done','cancelled','canceled')),completion_status text NOT NULL DEFAULT 'pending' CHECK(completion_status IN ('pending','completed','rejected')),type requirement_type DEFAULT 'task',budget numeric DEFAULT 50 CHECK(budget>=0),cron text,cycle text,created_at timestamptz DEFAULT '2026-09-15',updated_at timestamptz DEFAULT '2026-09-15',metadata jsonb,backlog jsonb DEFAULT '{}',backlog_revision bigint DEFAULT 0,cron_lock_run_id text,cron_lock_expires_at timestamptz,cron_lock_active boolean DEFAULT false);" +
        "CREATE TABLE remote_instances(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL,user_id uuid NOT NULL,created_by uuid NOT NULL,name text NOT NULL,instance_type text CHECK(instance_type IN ('browser','ubuntu','windows')),status text CHECK(status IN ('pending','starting','running','paused','stopping','stopped','error')),is_archived boolean DEFAULT false,created_at timestamptz DEFAULT now());" +
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),instance_id uuid REFERENCES remote_instances(id),site_id uuid,status text CHECK(status IN ('pending','in_progress','active','paused','completed','failed','cancelled','blocked')),metadata jsonb,steps jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());" +
        "CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid,user_id uuid,instance_id uuid,log_type text,trusted_user_action boolean,message text,details jsonb,created_at timestamptz DEFAULT now());" +
        "CREATE TABLE requirement_status(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),requirement_id uuid REFERENCES requirements(id),site_id uuid,instance_id uuid,stage text,cycle text,message text,repo_url text,metadata jsonb,updated_at timestamptz DEFAULT now());" +
        "CREATE TABLE offline_site_access(site_id uuid,user_id uuid,effective boolean,PRIMARY KEY(site_id,user_id));" +
        "CREATE FUNCTION public.site_user_has_effective_access(p_site_id uuid,p_user_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT effective FROM public.offline_site_access WHERE site_id=p_site_id AND user_id=p_user_id';"
      );
      for (const file of ['20260923225900_review_quarantine_receipts.sql','20260923230000_durable_review_quarantine.sql',
        '20260923230100_stamp_review_quarantine.sql','20260930010000_requirement_migration_lifecycle.sql',
        '20261003010000_migration_execution_handoff.sql','20261014010000_portable_harness_sessions.sql',
        '20261014020000_portable_harness_host_state.sql','20261014030000_agent_driven_requirement_cron.sql',
        '20261020200000_requirement_cross_instance_commands.sql']) {
        await db.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
      }
      await db.query('INSERT INTO sites VALUES($1),($2)', [site,otherSite]);
      await db.query('INSERT INTO auth.users VALUES($1),($2),($3)', [user,member,stranger]);
      await db.query('INSERT INTO offline_site_access VALUES($1,$2,true),($1,$3,true),($1,$4,false)', [site,user,member,stranger]);
      source = await instance();
      for (const role of ['anon','authenticated','service_role']) {
        for (const fn of ['submit_requirement_command(uuid,uuid,uuid,uuid,uuid,jsonb)',
          'has_requirement_scope_authorization(uuid,timestamp with time zone)',
          'apply_pending_requirement_commands()','claim_agent_requirement_run(uuid[],integer,integer,uuid[])']) {
          assert.equal((await one('SELECT has_function_privilege($1,$2,$3) value',[role,fn,'EXECUTE'])).value, role === 'service_role');
        }
        assert.equal((await one('SELECT has_function_privilege($1,$2,$3) value',[role,'claim_agent_requirement_run_before_commands(uuid[],integer,integer,uuid[])','EXECUTE'])).value,false);
        assert.equal((await one('SELECT has_table_privilege($1,$2,$3) value',[role,'requirement_commands','SELECT'])).value,role === 'service_role');
        for (const privilege of ['INSERT','UPDATE','DELETE']) assert.equal((await one('SELECT has_table_privilege($1,$2,$3) value',[role,'requirement_commands',privilege])).value,false);
      }
      assert.equal((await one("SELECT relrowsecurity value FROM pg_class WHERE oid='requirement_commands'::regclass")).value,true);
      assert.equal(await authorized(null,'2026-09-15'),false);
      assert.equal(await authorized(randomUUID(),null),false);
      assert.equal(await authorized(randomUUID(),'infinity'),false);
      assert.equal(await authorized(randomUUID(),'-infinity'),false);
      const scoped = await req(), valid = await action();
      const foreignSource = await instance(otherSite), siblingSource = await instance();
      const rejectedActions = [randomUUID(), await action('running',{trusted:false}), await action('running',{type:'agent_action'}),
        await action('running',{user:member}), await action('running',{site:otherSite,instance:foreignSource}),
        await action('running',{instance:siblingSource}), await action('paused'),await action('cancelled'),await action('failed')];
      for (const id of rejectedActions) await assert.rejects(() => submit(scoped.id,id,{title:'Forbidden'}), /authorization denied/);
      await assert.rejects(() => submit(scoped.id,valid,{title:'Forbidden'},{site:otherSite}), /authorization denied/);
      await assert.rejects(() => submit(randomUUID(),valid,{title:'Forbidden'}), /authorization denied/);
      await assert.rejects(() => submit(scoped.id,valid,{title:'Forbidden'},{user:stranger}), /authorization denied/);
      await db.query('UPDATE offline_site_access SET effective=false WHERE user_id=$1',[user]);
      await assert.rejects(() => submit(scoped.id,valid,{title:'Forbidden'}), /authorization denied/);
      await db.query('UPDATE offline_site_access SET effective=true WHERE user_id=$1',[user]);
      await db.query('UPDATE remote_instances SET is_archived=true WHERE id=$1',[source]);
      await assert.rejects(() => submit(scoped.id,valid,{title:'Forbidden'}), /authorization denied/);
      await db.query('UPDATE remote_instances SET is_archived=false WHERE id=$1',[source]);
      for (const patch of [{},null,[],{metadata:{}},{runner_instance_id:source},{title:5},{title:null},{description:[]},
        {title:''},{instructions:''},{type:''},{instructions:null},{type:null},
        {priority:'urgent'},{status:'done'},{status:'on-review'},{status:'cancelled'},{status:'canceled'},
        {completion_status:'completed'},{completion_status:null},{budget:'10'},{budget:-1},{type:'invented'},
        {title:'x'.repeat(301)},{description:'x'.repeat(24001)},{instructions:'x'.repeat(48001)},
        {cron:'x'.repeat(201)},{cycle:'x'.repeat(201)},{type:'x'.repeat(101)}]) {
        await assert.rejects(() => submit(scoped.id,valid,patch), /Invalid requirement command|invalid input value for enum/);
      }
      assert.equal((await row(scoped.id)).external_user_action_revision,0);
      assert.equal((await one('SELECT count(*)::int n FROM requirement_commands')).n,0);

      // An effective site member can command a requirement owned by another user.
      const memberAction = await action('completed',{user:member,instance:siblingSource});
      assert.equal((await submit(scoped.id,memberAction,{description:'Member-authorized'},{user:member,instance:siblingSource})).state,'queued');
      await reset();

      const active = await req(), firstRun = (await claim()).run;
      const before = await row(active.id), message = await action();
      await db.query("UPDATE instance_logs SET created_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[message]);
      const planId = randomUUID();
      await db.query("INSERT INTO instance_plans(id,site_id,instance_id,status,metadata,steps) VALUES($1,$2,$3,'active',$4,$5)",
        [planId,site,active.runner,{requirement_id:active.id,counter:88},[{id:'step',status:'failed',attempts:22}]]);
      const originalLog = await one('SELECT * FROM instance_logs WHERE id=$1',[message]);
      const instanceCount = (await one('SELECT count(*)::int n FROM remote_instances')).n;
      await db.exec('SET ROLE service_role');
      const queued = await submit(active.id,message,{title:'Queued title',instructions:'Fresh specification',budget:90,status:'backlog'});
      await db.exec('RESET ROLE');
      assert.equal(queued.state,'queued'); assert.equal(queued.authorization_action_id,message);
      assert.equal(queued.runner_instance_id,active.runner); assert.notEqual(active.runner,source);
      const queuedRow = await row(active.id);
      assert.deepEqual(queuedRow,{...before,external_user_action_revision:1,last_external_user_action_id:message});
      assert.deepEqual(queued.requirement,(await one('SELECT to_jsonb(q) value FROM requirements q WHERE id=$1',[active.id])).value);
      assert.equal((await submit(active.id,message,{title:'Do not overwrite'})).state,'duplicate');
      await apply(); assert.deepEqual(await row(active.id),queuedRow,'healthy claim remains unchanged');
      await db.query("UPDATE instance_logs SET details=jsonb_set(details,'{status}','\"completed\"') WHERE id=$1",[message]);
      await apply(); assert.deepEqual(await row(active.id),queuedRow,'completed action cannot revoke active claim');
      assert.equal(await claim(),null,'scheduler neither replaces nor duplicates the active owner');
      await db.query('UPDATE requirements SET cron_lock_active=false WHERE id=$1',[active.id]);
      await apply(); assert.equal((await row(active.id)).title,'Offline','inactive but unexpired lease remains fenced');
      await db.query('UPDATE requirements SET cron_lock_active=true WHERE id=$1',[active.id]);
      // The queued message can precede an old cycle's final backlog item stamp.
      // Its later applied_at (not its original message timestamp) admits fresh
      // work after this already-running cycle finishes, without rewriting items.
      await db.query("UPDATE requirements SET backlog=jsonb_set(backlog,'{items}',(backlog->'items')||jsonb_build_array(jsonb_build_object('id','old-cycle-complete','status','done','updated_at',clock_timestamp()))) WHERE id=$1",[active.id]);
      const oldCycleCompletedAt = (await one("SELECT backlog->'items'->1->>'updated_at' value FROM requirements WHERE id=$1",[active.id])).value;
      assert.equal(await authorized(active.id,oldCycleCompletedAt),false,'queued receipt never authorizes the old generation');
      await session(firstRun,'completed','implemented');
      const savedBefore = await one('SELECT * FROM harness_sessions WHERE id=$1',[firstRun.sessionId]);
      assert.equal(await finish(firstRun,'completed'),true);
      const readyBefore = await row(active.id);
      const planBefore = await one('SELECT * FROM instance_plans WHERE id=$1',[planId]);
      const resumed = await claim();
      assert.equal(resumed.state,'claimed'); assert.equal(resumed.requirement.title,'Queued title');
      assert.equal(resumed.requirement.instructions,'Fresh specification'); assert.equal(resumed.requirement.budget,90);
      assert.equal(resumed.requirement.status,'in-progress'); assert.equal(resumed.requirement.completion_status,'pending');
      assert.equal(resumed.run.executionGeneration,5); assert.equal(resumed.run.instanceId,active.runner);
      assert.equal(resumed.run.sessionId,firstRun.sessionId,'higher generation reuses terminal session rather than resetting its budget');
      const savedAfter = await one('SELECT * FROM harness_sessions WHERE id=$1',[firstRun.sessionId]);
      assert.equal(savedAfter.snapshot.status,'queued');
      for (const key of ['request','messages','turns','allocatedTokens','activeMs','uncertainOperations'])
        assert.deepEqual(savedAfter.snapshot[key],savedBefore.snapshot[key],key+' survives command generation');
      assert.deepEqual(resumed.requirement.backlog,readyBefore.backlog);
      assert.equal(resumed.requirement.backlog_revision,readyBefore.backlog_revision);
      for (const key of ['runner_instance_id','assistant_origin_instance_id','active_sandbox_id','budget_spent'])
        assert.equal(resumed.requirement.metadata[key],before.metadata[key]);
      assert.deepEqual(await one('SELECT * FROM instance_plans WHERE id=$1',[planId]),planBefore);
      assert.equal((await one('SELECT count(*)::int n FROM remote_instances')).n,instanceCount);
      assert.deepEqual((await one('SELECT patch FROM requirement_commands WHERE requirement_id=$1',[active.id])).patch,
        {title:'Queued title',instructions:'Fresh specification',budget:90,status:'backlog'});
      assert.ok((await one('SELECT applied_at FROM requirement_commands WHERE requirement_id=$1',[active.id])).applied_at);
      assert.equal((await one("SELECT c.applied_at > (r.backlog->'items'->1->>'updated_at')::timestamptz AND (r.backlog->'items'->1->>'updated_at')::timestamptz > receipt.action_created_at value FROM requirement_commands c JOIN requirements r ON r.id=c.requirement_id JOIN requirement_user_action_receipts receipt USING(requirement_id,action_id) WHERE r.id=$1",[active.id])).value,true,'safe-boundary application is later than old-cycle completion and original user input');
      await db.exec('SET ROLE service_role'); assert.equal(await authorized(active.id,oldCycleCompletedAt),true,'applied boundary authorizes fresh work even when original action predates completion'); await db.exec('RESET ROLE');
      const appliedBeforeReplay = await row(active.id);
      assert.equal((await submit(active.id,message,{title:'Late replacement'})).state,'duplicate');
      await apply(); assert.deepEqual(await row(active.id),appliedBeforeReplay,'duplicate has no revision/generation/effect');
      const completedLog = await one('SELECT * FROM instance_logs WHERE id=$1',[message]);
      assert.deepEqual(completedLog,{...originalLog,details:{...originalLog.details,status:'completed'}},'commands never stamp a single requirement into shared action details');

      await reset();
      const running = await req(), runningMessage = await action();
      await submit(running.id,runningMessage,{title:'Wait for host'});
      const runningBefore = await row(running.id);
      assert.equal(await authorized(running.id,'2026-09-15'),false,'running queued command receipt is not scope authorization');
      await apply(); assert.deepEqual(await row(running.id),runningBefore,'running host action waits at idle');
      for (const status of ['paused','cancelled']) {
        await db.query("UPDATE instance_logs SET details=jsonb_set(details,'{status}',to_jsonb($2::text)) WHERE id=$1",[runningMessage,status]);
        await apply(); assert.deepEqual(await row(running.id),runningBefore,status+' action does not drain');
        assert.equal(await authorized(running.id,'2026-09-15'),false,status+' command remains unauthorized until application');
      }
      await db.query("UPDATE instance_logs SET details=jsonb_set(details,'{status}','\"failed\"') WHERE id=$1",[runningMessage]);
      await db.exec('SET ROLE service_role'); await apply(); await db.exec('RESET ROLE');
      assert.equal((await row(running.id)).title,'Wait for host');
      assert.equal(await authorized(running.id,'2026-09-15'),true);
      assert.equal((await row(running.id)).metadata.requirement_execution_generation,5,'failed host action safely drains');

      await reset();
      const ordered = await req('done'), shared = await action('completed'), another = await req('backlog',{},null);
      const newest = await action('completed');
      await submit(ordered.id,shared,{title:'First title',description:'First description',priority:'high',type:'project',budget:12.5,cron:'0 * * * *',cycle:'hourly'});
      await submit(ordered.id,newest,{title:'Final title',instructions:'Final instructions',description:null,cron:null,completion_status:'pending'});
      assert.equal((await submit(another.id,shared,{title:'Same user message, independent requirement'})).runner_instance_id,null);
      await apply();
      const final = await row(ordered.id);
      assert.equal(final.title,'Final title'); assert.equal(final.description,null); assert.equal(final.instructions,'Final instructions');
      assert.equal(final.priority,'high'); assert.equal(final.type,'project'); assert.equal(Number(final.budget),12.5);
      assert.equal(final.cron,null); assert.equal(final.cycle,'hourly'); assert.equal(final.status,'in-progress');
      assert.equal(final.external_user_action_revision,2); assert.equal(final.last_external_user_action_id,newest);
      assert.equal(final.metadata.requirement_execution_generation,5,'two ordered patches increment generation once per requirement batch');
      assert.equal((await row(another.id)).title,'Same user message, independent requirement');
      assert.equal((await row(another.id)).external_user_action_revision,1);
      assert.equal((await row(another.id)).metadata.runner_instance_id,undefined,'drain never binds a new runner');
      assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE action_id=$1 AND applied_at IS NOT NULL',[shared])).n,2);
      assert.equal((await one('SELECT count(*)::int n FROM requirement_user_action_receipts WHERE action_id=$1',[shared])).n,2);
      const finalBefore = await row(ordered.id);
      await apply(); assert.deepEqual(await row(ordered.id),finalBefore,'repeated drain is a no-op');

      await reset();
      const prefix = await req(), older = await action(), later = await action('completed');
      await submit(prefix.id,older,{title:'Older'}); await submit(prefix.id,later,{title:'Newer'});
      await apply(); assert.equal((await row(prefix.id)).title,'Offline','newer completed revision cannot leapfrog older running action');
      await db.query("UPDATE instance_logs SET details=jsonb_set(details,'{status}','\"completed\"') WHERE id=$1",[older]);
      await apply(); assert.equal((await row(prefix.id)).title,'Newer');
      assert.equal((await row(prefix.id)).metadata.requirement_execution_generation,5);

      await reset();
      // A pre-existing recovery receipt is reused without consuming it twice.
      const recovered = await req(), receiptAction = await action('completed');
      await db.query('INSERT INTO requirement_user_action_receipts(requirement_id,action_id,action_created_at,revision) SELECT $1,id,created_at,1 FROM instance_logs WHERE id=$2',[recovered.id,receiptAction]);
      await db.query('UPDATE requirements SET external_user_action_revision=1,last_external_user_action_id=$2 WHERE id=$1',[recovered.id,receiptAction]);
      const receiptBefore = await one('SELECT * FROM requirement_user_action_receipts WHERE requirement_id=$1',[recovered.id]);
      assert.equal(await authorized(recovered.id,'2026-09-15'),true,'legacy recovery-only receipt preserves authorization');
      assert.equal(await authorized(recovered.id,'9999-01-01'),false,'old recovery receipt cannot authorize a later completion');
      assert.equal((await submit(recovered.id,receiptAction,{title:'Receipt reused'})).state,'queued');
      assert.equal(await authorized(recovered.id,'2026-09-15'),false,'once linked to a queued command, recovery receipt awaits application');
      assert.equal((await row(recovered.id)).external_user_action_revision,1);
      assert.deepEqual(await one('SELECT * FROM requirement_user_action_receipts WHERE requirement_id=$1',[recovered.id]),receiptBefore);
      await apply(); assert.equal((await row(recovered.id)).title,'Receipt reused');
      assert.equal(await authorized(recovered.id,'2026-09-15'),true);
      const newerReceipt = await action('completed');
      await db.query('INSERT INTO requirement_user_action_receipts(requirement_id,action_id,action_created_at,revision) SELECT $1,id,created_at,2 FROM instance_logs WHERE id=$2',[recovered.id,newerReceipt]);
      await db.query('UPDATE requirements SET external_user_action_revision=2,last_external_user_action_id=$2 WHERE id=$1',[recovered.id,newerReceipt]);
      assert.equal((await submit(recovered.id,receiptAction,{title:'Old replay'})).state,'duplicate');
      assert.equal((await row(recovered.id)).external_user_action_revision,2);
      assert.equal((await row(recovered.id)).last_external_user_action_id,newerReceipt,'old receipt replay never replaces latest authorization ID');

      await reset();
      // Recovery rev1 has no command. A first-time late command for that receipt
      // must not rewind rev2, whether rev2 is still queued or already applied.
      const staleReceiptRequirement = await req(), staleReceiptAction = await action('completed');
      await db.query('INSERT INTO requirement_user_action_receipts(requirement_id,action_id,action_created_at,revision) SELECT $1,id,created_at,1 FROM instance_logs WHERE id=$2',[staleReceiptRequirement.id,staleReceiptAction]);
      await db.query('UPDATE requirements SET external_user_action_revision=1,last_external_user_action_id=$2 WHERE id=$1',[staleReceiptRequirement.id,staleReceiptAction]);
      const frontierAction = await action('completed');
      assert.equal((await submit(staleReceiptRequirement.id,frontierAction,{title:'Newest scope',instructions:'Rev2 instructions'})).state,'queued');
      assert.equal((await one('SELECT revision FROM requirement_commands WHERE requirement_id=$1',[staleReceiptRequirement.id])).revision,2);
      for (const frontier of ['queued','applied']) {
        if (frontier === 'applied') await apply();
        const requirementBeforeStale = await row(staleReceiptRequirement.id);
        const commandsBeforeStale = (await db.query('SELECT * FROM requirement_commands WHERE requirement_id=$1 ORDER BY revision',[staleReceiptRequirement.id])).rows;
        const receiptsBeforeStale = (await db.query('SELECT * FROM requirement_user_action_receipts WHERE requirement_id=$1 ORDER BY revision',[staleReceiptRequirement.id])).rows;
        await assert.rejects(() => submit(staleReceiptRequirement.id,staleReceiptAction,{title:'Stale scope',instructions:'Rev1 instructions'}), /Stale requirement command receipt revision/);
        assert.deepEqual(await row(staleReceiptRequirement.id),requirementBeforeStale,'stale first submission cannot mutate generation or newer scope');
        assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE requirement_id=$1 AND action_id=$2',[staleReceiptRequirement.id,staleReceiptAction])).n,0);
        assert.deepEqual((await db.query('SELECT * FROM requirement_user_action_receipts WHERE requirement_id=$1 ORDER BY revision',[staleReceiptRequirement.id])).rows,receiptsBeforeStale);
        assert.deepEqual((await db.query('SELECT * FROM requirement_commands WHERE requirement_id=$1 ORDER BY revision',[staleReceiptRequirement.id])).rows,commandsBeforeStale);
        if (frontier === 'applied') { await apply(); assert.deepEqual(await row(staleReceiptRequirement.id),requirementBeforeStale); }
      }
      const newestScope = await row(staleReceiptRequirement.id);
      assert.equal(newestScope.external_user_action_revision,2); assert.equal(newestScope.last_external_user_action_id,frontierAction);
      assert.equal(newestScope.metadata.requirement_execution_generation,5);
      assert.equal(newestScope.instructions,'Rev2 instructions');
      assert.equal((await submit(staleReceiptRequirement.id,frontierAction,{title:'Ignored duplicate'})).state,'duplicate');
      assert.deepEqual(await row(staleReceiptRequirement.id),newestScope,'frontier duplicate still preserves applied scope');

      await reset();
      for (const metadata of [{execution_hold:{}},{execution_hold:{kind:'user_pause'}},{user_paused:true},{customer_paused:true},{cron_paused:true}]) {
        const held = await req('blocked',metadata), heldAction = await action('completed');
        await submit(held.id,heldAction,{title:'Still pending'}); const heldBefore = await row(held.id);
        await apply(); assert.deepEqual(await row(held.id),heldBefore,'explicit pause is never cleared by command');
        assert.equal((await one('SELECT applied_at FROM requirement_commands WHERE requirement_id=$1',[held.id])).applied_at,null);
      }
      for (const status of ['cancelled','canceled']) {
        const cancelled = await req(status), cancelledAction = await action('completed');
        await submit(cancelled.id,cancelledAction,{title:'Do not resurrect'}); const cancelledBefore = await row(cancelled.id);
        await apply(); assert.deepEqual(await row(cancelled.id),cancelledBefore);
      }

      await reset();
      const pausedOwner = await req(), pausedOwnerAction = await action('completed');
      await submit(pausedOwner.id,pausedOwnerAction,{title:'Paused owner stays paused'});
      for (const status of ['paused','stopped','stopping']) {
        await db.query('UPDATE remote_instances SET status=$2 WHERE id=$1',[pausedOwner.runner,status]);
        const pausedOwnerBefore = await row(pausedOwner.id); await apply();
        assert.deepEqual(await row(pausedOwner.id),pausedOwnerBefore,status+' owner is not resumed by queue');
      }
      await db.query("UPDATE remote_instances SET status='running' WHERE id=$1",[pausedOwner.runner]);
      const pausedPlan = randomUUID();
      await db.query("INSERT INTO instance_plans(id,site_id,instance_id,status,metadata,steps) VALUES($1,$2,$3,'paused',$4,'[]')",
        [pausedPlan,site,pausedOwner.runner,{requirement_id:pausedOwner.id}]);
      const pausedPlanBefore = await row(pausedOwner.id); await apply(); assert.deepEqual(await row(pausedOwner.id),pausedPlanBefore);
      await db.query("UPDATE instance_plans SET status='active' WHERE id=$1",[pausedPlan]);
      await apply(); assert.equal((await row(pausedOwner.id)).title,'Paused owner stays paused');

      await reset();
      const cancelledSession = await req(), cancelledRun = (await claim()).run;
      await session(cancelledRun,'cancelled','User cancelled'); assert.equal(await finish(cancelledRun,'cancelled'),true);
      const cancelledSessionAction = await action('completed'); await submit(cancelledSession.id,cancelledSessionAction,{title:'Never resurrect cancelled session'});
      const cancelledSessionBefore = await row(cancelledSession.id); await apply(); assert.deepEqual(await row(cancelledSession.id),cancelledSessionBefore);
      assert.equal((await one('SELECT applied_at FROM requirement_commands WHERE requirement_id=$1',[cancelledSession.id])).applied_at,null);

      await reset();
      const pausedSession = await req(), pausedRun = (await claim()).run;
      await session(pausedRun,'paused','User paused'); assert.equal(await finish(pausedRun,'paused'),true);
      const pausedSessionAction = await action('completed'); await submit(pausedSession.id,pausedSessionAction,{title:'Never resume an explicit session pause'});
      const pausedSessionBefore = await row(pausedSession.id); await apply(); assert.deepEqual(await row(pausedSession.id),pausedSessionBefore);
      assert.equal(await claim(),null,'command cannot advance generation and implicitly resume a paused harness');
      assert.equal((await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[pausedRun.sessionId])).snapshot.status,'paused');
      assert.equal((await one('SELECT applied_at FROM requirement_commands WHERE requirement_id=$1',[pausedSession.id])).applied_at,null);

      await reset();
      const expired = await req(), expiredAction = await action('completed');
      await db.query("UPDATE requirements SET cron_lock_run_id='expired-offline-claim',cron_lock_active=true,cron_lock_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.id]);
      await submit(expired.id,expiredAction,{title:'Expired lease command'}); await apply();
      const expiredAfter = await row(expired.id);
      assert.equal(expiredAfter.title,'Expired lease command'); assert.equal(expiredAfter.cron_lock_run_id,null);
      assert.equal(expiredAfter.cron_lock_expires_at,null); assert.equal(expiredAfter.cron_lock_active,false);

      await reset();
      const waiting = await req(), waitingRun = (await claim()).run;
      await session(waitingRun,'waiting','Offline external dependency'); assert.equal(await finish(waitingRun,'waiting'),true);
      const waitingSaved = await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[waitingRun.sessionId]);
      assert.equal(await claim(),null,'ordinary scheduler preserves a user-facing wait');
      const waitingAction = await action('completed'); await submit(waiting.id,waitingAction,{instructions:'Resolved dependency'});
      const waitingResume = await claim(); assert.equal(waitingResume.run.executionGeneration,5);
      assert.equal(waitingResume.requirement.instructions,'Resolved dependency'); assert.equal(waitingResume.run.instanceId,waiting.runner);
      const waitingAfter = await one('SELECT snapshot FROM harness_sessions WHERE id=$1',[waitingRun.sessionId]);
      assert.equal(waitingAfter.snapshot.status,'queued'); assert.equal(waitingAfter.snapshot.allocatedTokens,waitingSaved.snapshot.allocatedTokens);
      assert.equal(waitingAfter.snapshot.turns,waitingSaved.snapshot.turns); assert.deepEqual(waitingAfter.snapshot.messages,waitingSaved.snapshot.messages);

      await reset();
      const leased = await req(), leasedRun = (await claim()).run;
      await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[leasedRun.sessionId,site,user,initial(leasedRun.sessionId)]);
      await db.query('SELECT public.claim_harness_session($1,$2,$3,300)',[leasedRun.sessionId,site,'offline-owner']);
      await db.query('UPDATE requirements SET cron_lock_run_id=null,cron_lock_active=false,cron_lock_expires_at=null WHERE id=$1',[leased.id]);
      const leaseAction = await action('completed'); await submit(leased.id,leaseAction,{title:'Session lease waits'});
      const leasedBefore = await row(leased.id); await apply(); assert.deepEqual(await row(leased.id),leasedBefore,'healthy harness lease also remains unchanged');
      await db.query('SELECT public.release_harness_session($1,$2,$3)',[leasedRun.sessionId,site,'offline-owner']);
      await apply(); assert.equal((await row(leased.id)).title,'Session lease waits');

      await reset();
      const boundedAction = await action('completed');
      for (let n=0;n<101;n++) { const bounded = await req(); await submit(bounded.id,boundedAction,{title:'Bounded drain'}); }
      await apply(); assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE applied_at IS NOT NULL')).n,100);
      await apply(); assert.equal((await one('SELECT count(*)::int n FROM requirement_commands WHERE applied_at IS NOT NULL')).n,101);
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline requirement command SQL test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 65_000);