import { spawnSync } from 'node:child_process';

it('retires only an owned missing workspace with CAS and preserves real bootstrap cleanup fencing offline', () => {
  // Real migrations, disposable single-connection PGlite; no production/provider
  // calls. Serial interleavings validate fencing, not multi-connection scheduling.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import { randomUUID, randomBytes } from 'node:crypto';
    import assert from 'node:assert/strict';
    const db=new PGlite(), site=randomUUID(), otherSite=randomUUID(), user=randomUUID(), otherUser=randomUUID();
    const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
    const rpc=async(name,args) => (await one('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') value',args)).value;
    const admin=async(fn) => { await db.exec('RESET ROLE');try { return await fn(); } finally { await db.exec('SET ROLE service_role'); } };
    const migration=name=>readFileSync('supabase/migrations/'+name+'.sql','utf8');
    const get=async f=>(await one('SELECT to_jsonb(s) value FROM harness_sessions s WHERE id=$1',[f.id])).value;
    const retire=(f,overrides={})=>rpc('retire_missing_harness_workspace',[
      overrides.id===undefined?f.id:overrides.id,overrides.site===undefined?site:overrides.site,
      overrides.owner===undefined?f.owner:overrides.owner,overrides.version===undefined?f.s.version:overrides.version,
      overrides.resource===undefined?f.resource:overrides.resource]);
    const save=(f,s)=>rpc('save_harness_session',[f.id,site,f.owner,s]);
    const begin=(f,resource='h-'+f.id,owner=f.owner,token=randomUUID())=>rpc('begin_harness_sandbox_cleanup',[f.id,site,owner,resource,token,true]);
    const evidence=()=>admin(async()=>{
      const result={};
      for(const table of ['harness_sessions','requirements','harness_requirement_runs','harness_host_state','harness_artifacts',
        'harness_artifact_reservations','requirement_status','instance_plans','sandbox_billing_resources','harness_workspace_retirement_permits'])
        result[table]=(await db.query('SELECT to_jsonb(t) value FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows;
      return result;
    });
    const fixture=async(resource,requestRequirementId)=>{
      const f={id:randomUUID(),req:randomUUID(),owner:randomUUID(),run:randomUUID(),resource:resource??'legacy-'+randomUUID()};
      const s={id:f.id,version:0,status:'queued',request:{requirementId:requestRequirementId===undefined?f.req:requestRequirementId,objective:'Offline recovery',repository:{url:'https://example.test/repository'},
        limits:{maxTurns:10,maxOutputTokens:1024,maxTotalTokens:100000,maxActiveMs:30000}},messages:[],turns:0,allocatedTokens:0,activeMs:0,
        uncertainOperations:[],createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),workspace:{provider:'vercel',id:f.resource,root:'/vercel/sandbox'}};
      await admin(async()=>{
        await db.query("INSERT INTO requirements(id,site_id,user_id,status,metadata,cron_lock_run_id,cron_lock_active,cron_lock_expires_at,backlog) VALUES($1,$2,$3,'in-progress',$4,$5,true,clock_timestamp()+interval '5 minutes',$6)",
          [f.req,site,user,{requirement_execution_generation:7},f.run,{items:[{id:'keep',status:'done'}]}]);
        await db.query('INSERT INTO harness_requirement_runs(requirement_id,site_id,session_id,generation,workspace_id) VALUES($1,$2,$3,7,$4)',[f.req,site,f.id,f.resource]);
        await db.query('INSERT INTO sandbox_billing_resources(sandbox_name,site_id,owner_kind,owner_id) VALUES($1,$2,$3,$4)',[f.resource,site,'requirement',f.req]);
        await db.query('INSERT INTO requirement_status(requirement_id,site_id,active_sandbox_id) VALUES($1,$2,$3)',[f.req,site,f.resource]);
      });
      await db.query('INSERT INTO harness_sessions(id,site_id,user_id,snapshot) VALUES($1,$2,$3,$4)',[f.id,site,user,s]);
      const claimed=await rpc('claim_harness_session',[f.id,site,f.owner,300]);
      f.s=await save(f,{...claimed,turns:3,allocatedTokens:42,activeMs:17,messages:[{role:'user',content:'Keep transcript'}],
        uncertainOperations:['keep-operation'],pending:{call:{id:'call',name:'read',arguments:'{}'},fingerprint:'offline',effect:'read'},
        hostContext:{keep:true}});
      await admin(async()=>{
        // Synthetic opaque storage fixture; no real credentials or external I/O.
        const ciphertext=['v1',randomBytes(12).toString('base64'),randomBytes(16).toString('base64'),randomBytes(24).toString('base64')].join('.');
        await db.query('INSERT INTO harness_host_state VALUES($1,$2,1,$3)',[f.id,site,ciphertext]);
        await db.query('INSERT INTO harness_artifacts(session_id,site_id,id,operation_id,content) VALUES($1,$2,$3,$4,$5)',[f.id,site,randomBytes(32).toString('hex'),'keep','Redacted artifact']);
      });
      return f;
    };
    try {
      await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE sites(id uuid PRIMARY KEY);');
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;');
      await db.exec(
        "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,user_id uuid NOT NULL,title text,status text,cron text,created_at timestamptz,updated_at timestamptz,metadata jsonb,backlog jsonb,backlog_revision bigint DEFAULT 0,cron_lock_run_id text,cron_lock_expires_at timestamptz,cron_lock_active boolean DEFAULT false);"+
        "CREATE TABLE remote_instances(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid,user_id uuid,created_by uuid,name text,instance_type text,status text,is_archived boolean DEFAULT false,created_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),instance_id uuid,site_id uuid,status text,metadata jsonb,steps jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());"+
        "CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid,instance_id uuid,log_type text,trusted_user_action boolean,details jsonb,created_at timestamptz DEFAULT now());"+
        "CREATE TABLE requirement_status(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),requirement_id uuid,site_id uuid,instance_id uuid,stage text,cycle text,message text,repo_url text,metadata jsonb,active_sandbox_id text,updated_at timestamptz DEFAULT now());"+
        "CREATE TABLE sandbox_billing_resources(sandbox_name text PRIMARY KEY,site_id uuid,owner_kind text,owner_id uuid,deletion_requested_at timestamptz,retired_at timestamptz);"
      );
      for(const name of ['20261014010000_portable_harness_sessions','20261014020000_portable_harness_host_state',
        '20261014030000_agent_driven_requirement_cron','20261022000001_sandbox_lifecycle_evidence']) await db.exec(migration(name));
      await db.query('INSERT INTO sites VALUES($1),($2)',[site,otherSite]);await db.query('INSERT INTO auth.users VALUES($1),($2)',[user,otherUser]);
      const originalSave=(await one("SELECT prosrc FROM pg_proc WHERE oid='save_harness_session(uuid,uuid,text,jsonb)'::regprocedure")).prosrc;
      await db.exec(migration('20261104111000_missing_requirement_workspace_recovery'));
      assert.equal((await one("SELECT prosrc FROM pg_proc WHERE oid='save_harness_session(uuid,uuid,text,jsonb)'::regprocedure")).prosrc,originalSave);
      const signature='retire_missing_harness_workspace(uuid,uuid,text,bigint,text)';
      for(const role of ['anon','authenticated','service_role']) {
        assert.equal((await one('SELECT has_function_privilege($1,$2,\'execute\') allowed',[role,signature])).allowed,role==='service_role');
        for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
          assert.equal((await one('SELECT has_table_privilege($1,$2,$3) allowed',[role,'harness_workspace_retirement_permits',privilege])).allowed,false);
        assert.equal((await one("SELECT has_function_privilege($1,'guard_harness_session()','execute') allowed",[role])).allowed,false);
      }
      assert.equal((await one("SELECT prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] safe FROM pg_proc WHERE oid=$1::regprocedure",[signature])).safe,true);
      assert.equal((await one("SELECT relrowsecurity FROM pg_class WHERE oid='harness_workspace_retirement_permits'::regclass")).relrowsecurity,true);
      await db.exec('SET ROLE service_role');
      const f=await fixture();
      const foreign=await fixture();
      const foreignBefore=await get(foreign);
      for(const requestRequirementId of [null,randomUUID()]) {
        const unbound=await fixture(undefined,requestRequirementId), before=await evidence();
        assert.equal(await retire(unbound),null,'requires a current requirement bound in the immutable request');
        assert.deepEqual(await evidence(),before);
      }
      for(const role of ['anon','authenticated']) {
        await db.exec('SET ROLE '+role);await assert.rejects(()=>retire(f),/permission denied/);
      }
      await db.exec('SET ROLE service_role');
      await assert.rejects(()=>db.query('INSERT INTO harness_workspace_retirement_permits VALUES($1,$2,$3,txid_current())',[f.id,f.s.version,f.resource]),/permission denied/);
      // Even a caller-set GUC cannot grant an ordinary save the exception.
      await db.query("SELECT set_config('harness.workspace_retirement','true',false)");
      const {workspace,...withoutWorkspace}=f.s;
      for(const candidate of [withoutWorkspace,{...f.s,workspace:null},{...f.s,workspace:{...workspace,id:'replacement'}}])
        await assert.rejects(()=>save(f,candidate),/immutable|Invalid harness snapshot/);
      for(const overrides of [{id:randomUUID()},{id:null},{site:otherSite},{site:null},{owner:randomUUID()},{owner:null},{owner:''},
        {version:f.s.version-1},{version:f.s.version+1},{version:null},{version:-1},{version:9007199254740991},
        {resource:'different'},{resource:null},{resource:''}]) {
        const before=await evidence();assert.equal(await retire(f,overrides),null);assert.deepEqual(await evidence(),before);
      }
      // Guard failures must leave all state (including foreign leases) byte-for-byte intact.
      const failures=[
        ["UPDATE harness_sessions SET lease_owner=$2 WHERE id=$1",randomUUID()],
        ["UPDATE harness_sessions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1"],
        ["UPDATE harness_sessions SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1"],
        ...['queued','waiting','paused','failed','completed','cancelled'].map(status=>[
          "UPDATE harness_sessions SET version=version+1,snapshot=snapshot||jsonb_build_object('version',version+1,'status',$2::text) WHERE id=$1",status]),
        ["UPDATE harness_sessions SET sandbox_cleanup_token=$2,sandbox_cleanup_resource='other',sandbox_cleanup_started_at=clock_timestamp() WHERE id=$1",randomUUID()],
        ["UPDATE requirements SET cron_lock_active=false WHERE id=$1",undefined,'req'],
        ["UPDATE requirements SET cron_lock_run_id=NULL WHERE id=$1",undefined,'req'],
        ["UPDATE requirements SET cron_lock_expires_at=NULL WHERE id=$1",undefined,'req'],
        ["UPDATE requirements SET cron_lock_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",undefined,'req'],
        ["UPDATE requirements SET site_id=$2 WHERE id=$1",otherSite,'req'],
        ["UPDATE requirements SET user_id=$2 WHERE id=$1",otherUser,'req'],
        ...['blocked','done','cancelled'].map(status=>["UPDATE requirements SET status=$2 WHERE id=$1",status,'req']),
        ...[{requirement_execution_generation:8},{requirement_execution_generation:'invalid'},{},
          ...['execution_hold','user_paused','customer_paused','cron_paused'].map(key=>({requirement_execution_generation:7,[key]:true}))]
          .map(metadata=>["UPDATE requirements SET metadata=$2 WHERE id=$1",metadata,'req']),
        ["UPDATE harness_requirement_runs SET generation=8 WHERE requirement_id=$1",undefined,'req'],
        ["UPDATE harness_requirement_runs SET session_id=$2 WHERE requirement_id=$1",randomUUID(),'req'],
        ["UPDATE harness_requirement_runs SET site_id=$2 WHERE requirement_id=$1",otherSite,'req'],
        ["DELETE FROM harness_requirement_runs WHERE requirement_id=$1",undefined,'req'],
      ];
      for(const [sql,arg,key] of failures) {
        await db.exec('BEGIN');
        try {
          await admin(()=>db.query(sql,[key==='req'?f.req:f.id,...(arg===undefined?[]:[arg])]));
          const before=await evidence(), current=await get(f);
          assert.equal(await retire(f,{version:current.version}),null,sql);assert.deepEqual(await evidence(),before,sql);
        } finally { await db.exec('ROLLBACK'); }
      }
      const before=await evidence(), row=await get(f);
      assert.equal(await begin(f),false,'legacy reference prevents bootstrap cleanup before retirement');
      const retired=await retire(f);
      assert.deepEqual(retired,{...withoutWorkspace,version:f.s.version+1,updatedAt:retired.updatedAt});
      assert.ok(Date.parse(retired.updatedAt)>=Date.parse(f.s.updatedAt));
      assert.notEqual(retired.updatedAt,f.s.updatedAt);
      assert.deepEqual(await get(f),{...row,version:row.version+1,snapshot:retired});
      const after=await evidence();delete before.harness_sessions;delete after.harness_sessions;assert.deepEqual(after,before);
      assert.deepEqual(await get(foreign),foreignBefore,'retirement cannot change another session or its lease');
      assert.equal(await retire(f),null,'stale repeated retirement is rejected');
      assert.equal(await retire(f,{version:retired.version}),null,'missing workspace is not a new authorization');
      const stable=await evidence();
      assert.equal(await begin(f,'h-'+f.id,randomUUID()),false,'foreign owner cannot fence cleanup');
      assert.equal(await begin(f,f.resource),false,'legacy resource cannot be bootstrap-deleted');
      assert.deepEqual(await evidence(),stable);
      const token=randomUUID();assert.equal(await begin(f,'h-'+f.id,f.owner,token),true);
      const fenced=await get(f);assert.equal(fenced.sandbox_cleanup_token,token);
      assert.equal(fenced.sandbox_cleanup_resource,'h-'+f.id);assert.deepEqual(fenced.snapshot,retired);
      assert.equal(fenced.lease_owner,row.lease_owner);assert.equal(fenced.lease_expires_at,row.lease_expires_at);
      assert.equal(await rpc('finish_harness_sandbox_cleanup',[f.id,site,randomUUID()]),false);
      assert.equal(await rpc('finish_harness_sandbox_cleanup',[f.id,site,token]),true);
      const replacement=await save(f,{...retired,workspace:{...workspace,id:'h-'+f.id}});
      assert.equal(replacement.workspace.id,'h-'+f.id);
      const {workspace:newWorkspace,...cleared}=replacement;
      await assert.rejects(()=>save(f,cleared),/immutable/,'permit was consumed, not retained');
      // The copied trigger retains the existing explicit-generation reopen path,
      // while generic controls still cannot reopen completed work.
      const completed=await save(f,{...replacement,status:'completed'});
      await rpc('release_harness_session',[f.id,site,f.owner]);
      assert.equal(await rpc('control_harness_session',[f.id,site,'resume',null]),null);
      await admin(async()=>{
        await db.query("UPDATE requirements SET metadata=jsonb_build_object('requirement_execution_generation',8) WHERE id=$1",[f.req]);
        await db.query("UPDATE harness_sessions SET version=version+1,snapshot=snapshot||jsonb_build_object('version',version+1,'status','queued') WHERE id=$1",[f.id]);
      });
      const reopened=await get(f);
      assert.deepEqual(reopened.snapshot,{...completed,status:'queued',version:completed.version+1});
      assert.deepEqual(await get(foreign),foreignBefore);
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'Offline workspace recovery SQL test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 65_000);