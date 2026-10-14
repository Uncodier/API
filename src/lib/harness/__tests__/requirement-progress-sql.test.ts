import { spawnSync } from 'node:child_process';

it('optional plan SQL creates owned plans and patches steps atomically without gates or resuming pauses', () => {
  // Ephemeral PGlite only; the run assertion is a fixture here. The real
  // assertion/lease SQL is exercised separately by requirement-cron-sql.test.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db=new PGlite();
    const site=randomUUID(),user=randomUUID(),req=randomUUID(),instance=randomUUID(),session=randomUUID(),run=randomUUID();
    const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
    const invoke=async(steps=[],plan=null,rev=0,overrides={}) => (await one('SELECT patch_agent_requirement_plan($1,$2,$3,$4,$5,$6,$7,$8) value',
      [req,overrides.run??run,7,session,plan,overrides.title??'Optional work plan',JSON.stringify(steps),rev])).value;
    const snapshot=async()=>JSON.stringify({r:await one('SELECT backlog,backlog_revision,metadata FROM requirements'),p:(await db.query('SELECT * FROM instance_plans ORDER BY id')).rows});
    try {
      await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
      await db.exec(
        "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,user_id uuid,status text,metadata jsonb,backlog jsonb,backlog_revision bigint);"+
        "CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,status text);"+
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid NOT NULL,site_id uuid NOT NULL,user_id uuid NOT NULL,title text NOT NULL,plan_type text NOT NULL CHECK(plan_type IN ('task','objective','verification','milestone')),status text NOT NULL CHECK(status IN ('pending','in_progress','active','paused','completed','failed','blocked','cancelled')),steps jsonb DEFAULT '[]',metadata jsonb DEFAULT '{}',steps_total int,steps_completed int,updated_at timestamptz DEFAULT now());"+
        "CREATE UNIQUE INDEX instance_plans_one_active_per_instance_idx ON instance_plans(instance_id) WHERE status IN ('pending','in_progress','active','paused') AND NULLIF(metadata->>'requirement_id','') IS NOT NULL;"+
        "CREATE FUNCTION assert_agent_requirement_run(p_req uuid,p_run text,p_gen int,p_session uuid) RETURNS bool LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM public.requirements r JOIN public.remote_instances i ON i.id::text=r.metadata->>'runner_instance_id' AND i.site_id=r.site_id WHERE r.id=p_req AND r.metadata->>'run_id'=p_run AND r.metadata->>'generation'=p_gen::text AND r.metadata->>'session_id'=p_session::text AND r.status='in-progress' AND i.status<>'paused' AND NOT EXISTS(SELECT 1 FROM public.instance_plans p WHERE p.instance_id=i.id AND p.status='paused'))$$;"
      );
      const backlog={items:[{id:'item-1',acceptance:['Keep data intact'],constraints:['No cross-tenant access'],attempts:99,status:'done',review_quarantine:{active:true}}]};
      const metadata={runner_instance_id:instance,run_id:run,generation:7,session_id:session,legacy_circuit:{open:true}};
      await db.query('INSERT INTO requirements VALUES($1,$2,$3,$4,$5,$6,0)',[req,site,user,'in-progress',metadata,backlog]);
      await db.query('INSERT INTO remote_instances VALUES($1,$2,$3)',[instance,site,'running']);
      await db.exec(readFileSync('supabase/migrations/20261014040000_agent_requirement_progress.sql','utf8'));
      assert.equal((await one("SELECT has_function_privilege('anon','patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint)','execute') allowed")).allowed,false);
      assert.equal((await one("SELECT has_function_privilege('authenticated','patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint)','execute') allowed")).allowed,false);
      assert.equal((await one("SELECT has_function_privilege('service_role','patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint)','execute') allowed")).allowed,true);
      const seeded=await invoke([{id:'first',title:'Implement',metadata:{backlog_item_id:'item-1'}}]);
      assert.equal(seeded.state,'created'); assert.equal(seeded.backlog_revision,1);
      let p=await one('SELECT * FROM instance_plans');
      assert.equal(p.id,seeded.plan_id);assert.equal(p.site_id,site);assert.equal(p.instance_id,instance);assert.equal(p.user_id,user);
      assert.equal(p.metadata.requirement_id,req);assert.equal(p.status,'pending');assert.equal(p.steps[0].status,'pending');
      assert.deepEqual((await one('SELECT backlog FROM requirements')).backlog,backlog);
      await db.query("UPDATE instance_plans SET steps=$1",[[{...p.steps[0],status:'completed',acceptance:['original'],attempts:80,metadata:{backlog_item_id:'item-1',preserved:'yes'}}]]);
      const second=await invoke([{id:'first',title:'Clearer title',description:'More detail'},{id:'second',title:'Next'}],null,1);
      assert.equal(second.state,'updated');assert.equal(second.plan_id,p.id);
      p=await one('SELECT * FROM instance_plans');assert.equal(p.steps.length,2);assert.equal(p.steps[0].status,'completed');assert.equal(p.steps[0].attempts,80);
      assert.deepEqual(p.steps[0].acceptance,['original']);assert.equal(p.steps[0].metadata.preserved,'yes');assert.equal(p.steps[1].status,'pending');
      const before=await snapshot();
      assert.equal((await invoke([],p.id,0)).state,'revision_conflict');assert.equal(await snapshot(),before);
      assert.equal((await invoke([],p.id,2,{run:randomUUID()})).state,'stale');assert.equal(await snapshot(),before);
      assert.equal((await invoke([{id:'third',title:'Valid'},{id:'foreign',title:'Foreign',metadata:{backlog_item_id:'foreign'}}],p.id,2)).state,'not_found');assert.equal(await snapshot(),before);
      await assert.rejects(()=>invoke([{id:'dup',title:'one'},{id:'dup',title:'two'}],p.id,2),/Duplicate/);assert.equal(await snapshot(),before);
      await assert.rejects(()=>invoke([{title:'no',metadata:{credential:randomUUID()}}],p.id,2),/Invalid plan step/);assert.equal(await snapshot(),before);
      await assert.rejects(()=>invoke([{id:'bad,id',title:'no'}],p.id,2),/identifier/);assert.equal(await snapshot(),before);
      await db.exec("UPDATE instance_plans SET status='paused'");let frozen=await snapshot();assert.equal((await invoke([],null,2)).state,'stale');assert.equal(await snapshot(),frozen);
      await db.exec("UPDATE instance_plans SET status='pending';UPDATE remote_instances SET status='paused'");frozen=await snapshot();assert.equal((await invoke([],p.id,2)).state,'stale');assert.equal(await snapshot(),frozen);
      await db.exec("UPDATE remote_instances SET status='running'");
      await db.query("UPDATE instance_plans SET steps=$1",[[{id:'first',status:'paused',title:'Manual pause'}]]);frozen=await snapshot();
      assert.equal((await invoke([{id:'first',title:'No resume'}],p.id,2)).state,'stale');assert.equal(await snapshot(),frozen);
      await db.query('UPDATE instance_plans SET site_id=$1',[randomUUID()]);frozen=await snapshot();assert.equal((await invoke([],p.id,2)).state,'stale');assert.equal(await snapshot(),frozen);
      await db.query('UPDATE instance_plans SET site_id=$1,metadata=$2',[site,{requirement_id:randomUUID()}]);frozen=await snapshot();assert.equal((await invoke([],p.id,2)).state,'stale');assert.equal((await invoke([],null,2)).state,'stale');assert.equal(await snapshot(),frozen);
      await db.query('UPDATE instance_plans SET metadata=$1,steps=$2',[{},[{id:'legacy',title:'Other work',backlog_item_id:'foreign'}]]);frozen=await snapshot();assert.equal((await invoke([],p.id,2)).state,'stale');assert.equal(await snapshot(),frozen);
      await db.query('UPDATE instance_plans SET steps=$1',[[{id:'legacy',title:'Matching work',backlog_item_id:'item-1',status:'failed'}]]);
      assert.equal((await invoke([{id:'legacy',title:'Updated description only'}],p.id,2)).state,'updated');
      assert.equal((await one('SELECT steps FROM instance_plans')).steps[0].status,'failed');
      assert.deepEqual((await one('SELECT backlog FROM requirements')).backlog,backlog);
      assert.deepEqual((await one('SELECT metadata FROM requirements')).metadata,metadata);
      // Install the existing forward binding trigger as well: plan creation must
      // satisfy it rather than bypassing it or introducing a product gate.
      await db.exec('DELETE FROM instance_plans');
      const binding=readFileSync('supabase/migrations/20261003180000_robot_instance_requirement_deletion.sql','utf8');
      await db.exec(binding.slice(binding.indexOf('CREATE FUNCTION public.guard_instance_plan_requirement_binding()'),binding.indexOf('CREATE FUNCTION public.guard_requirement_status_instance_binding()')));
      assert.equal((await invoke([{title:'Guarded creation'}],null,3)).state,'created');
      assert.equal((await one('SELECT metadata FROM instance_plans')).metadata.requirement_id,req);
      console.log('passed');
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Offline plan SQL test failed');
  expect(result.stdout.trim()).toBe('passed');
}, 65_000);