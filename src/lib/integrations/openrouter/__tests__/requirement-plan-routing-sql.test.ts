import { spawnSync } from 'node:child_process';

it('SQL creator commits an immutable authoritative pin atomically, including legacy rollback admission', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db=new PGlite();
    const site=randomUUID(), user=randomUUID(), req=randomUUID(), instance=randomUUID(), session=randomUUID(), run=randomUUID(), connection=randomUUID();
    const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
    const invoke=async(routing,revision=0,plan=null)=> (await one(
      'SELECT patch_agent_requirement_plan($1,$2,$3,$4,$5,$6,$7,$8'+(routing===undefined?'':',$9')+') value',
      [req,run,7,session,plan,'Work plan','[]',revision,...(routing===undefined?[]:[JSON.stringify(routing)])])).value;
    try {
      await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
      await db.exec(
        'CREATE TABLE sites(id uuid PRIMARY KEY);'+
        'CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,user_id uuid,status text,metadata jsonb,backlog jsonb,backlog_revision bigint);'+
        'CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,status text);'+
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid NOT NULL,site_id uuid NOT NULL,user_id uuid NOT NULL,title text NOT NULL,plan_type text NOT NULL,status text NOT NULL,steps jsonb DEFAULT '[]',metadata jsonb DEFAULT '{}',steps_total int,steps_completed int,updated_at timestamptz DEFAULT now());"+
        'CREATE TABLE openrouter_customer_connections(id uuid PRIMARY KEY,site_id uuid,selected bool,status text,credential_version int);'+
        'CREATE TABLE openrouter_customer_policies(connection_id uuid,policy_version int,credential_version int);'+
        "CREATE FUNCTION assert_agent_requirement_run(p_req uuid,p_run text,p_gen int,p_session uuid) RETURNS bool LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM public.requirements r JOIN public.remote_instances i ON i.id::text=r.metadata->>'runner_instance_id' AND i.site_id=r.site_id WHERE r.id=p_req AND r.metadata->>'run_id'=p_run AND r.metadata->>'generation'=p_gen::text AND r.metadata->>'session_id'=p_session::text AND r.status='in-progress' AND i.status<>'paused')$$;"
      );
      await db.query('INSERT INTO sites VALUES($1)',[site]);
      await db.query('INSERT INTO requirements VALUES($1,$2,$3,$4,$5,$6,0)',[req,site,user,'in-progress',{runner_instance_id:instance,run_id:run,generation:7,session_id:session},{items:[]}]);
      await db.query('INSERT INTO remote_instances VALUES($1,$2,$3)',[instance,site,'running']);
      await db.query('INSERT INTO openrouter_customer_connections VALUES($1,$2,true,$3,2)',[connection,site,'connected']);
      await db.query('INSERT INTO openrouter_customer_policies VALUES($1,1,2)',[connection]);
      await db.exec(readFileSync('supabase/migrations/20261014040000_agent_requirement_progress.sql','utf8'));
      await db.exec(readFileSync('../market-fit/supabase/migrations/20261112022000_openrouter_plan_routing.sql','utf8'));
      await db.exec(readFileSync('supabase/migrations/20261112071000_requirement_plan_private_routing.sql','utf8'));
      const signature='patch_agent_requirement_plan(uuid,text,integer,uuid,uuid,text,jsonb,bigint,jsonb)';
      for(const role of ['anon','authenticated']) assert.equal((await one('SELECT has_function_privilege($1,$2,$3) ok',[role,signature,'execute'])).ok,false);
      assert.equal((await one('SELECT has_function_privilege($1,$2,$3) ok',['service_role',signature,'execute'])).ok,true);
      assert.equal((await one("SELECT has_function_privilege('service_role','patch_agent_requirement_plan_unrouted(uuid,text,integer,uuid,uuid,text,jsonb,bigint)','execute') ok")).ok,false);
      const customer={payer:'customer',siteId:site,connectionId:connection,policyVersion:1,credentialVersion:2};
      await assert.rejects(()=>invoke({...customer,siteId:randomUUID()}),/Invalid routing/);
      assert.equal((await one('SELECT count(*) n FROM instance_plans')).n,0);
      assert.equal((await one('SELECT backlog_revision n FROM requirements')).n,0);
      await assert.rejects(()=>invoke({...customer,credentialVersion:3}),/unavailable/);
      assert.equal((await one('SELECT count(*) n FROM instance_plans')).n,0);
      const result=await invoke(customer);
      assert.equal(result.state,'created');
      assert.deepEqual((await one('SELECT routing FROM openrouter_plan_routing')).routing,customer);
      assert.equal((await one('SELECT status FROM instance_plans')).status,'pending');
      // A legacy binary updating an already-customer plan cannot overwrite its payer.
      assert.equal((await invoke(undefined,1,result.plan_id)).state,'updated');
      assert.deepEqual((await one('SELECT routing FROM openrouter_plan_routing')).routing,customer);
      await db.exec("UPDATE instance_plans SET status='completed'");
      const legacy=await invoke(undefined,2);
      assert.equal(legacy.state,'created');
      assert.deepEqual((await one('SELECT routing FROM openrouter_plan_routing WHERE plan_id=$1',[legacy.plan_id])).routing,{payer:'platform',siteId:site});
      await db.query('DELETE FROM openrouter_plan_routing WHERE plan_id=$1',[legacy.plan_id]);
      await assert.rejects(()=>invoke(customer,3,legacy.plan_id),/routing unavailable/);
      assert.equal((await one('SELECT backlog_revision n FROM requirements')).n,3);
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, 40_000);