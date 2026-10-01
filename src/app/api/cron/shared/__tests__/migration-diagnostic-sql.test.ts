import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('enforces one diagnostic, one changed follow-up review, immutable budgets and scoped settlement in PostgreSQL', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const id = '00000000-0000-4000-8000-000000000001';
    const instance = '00000000-0000-4000-8000-000000000002';
    const plan = '00000000-0000-4000-8000-000000000003';
    const file = 'migrations/0001.sql';
    const hash = 'a'.repeat(64), spec = 'b'.repeat(64);
    const value = (state, extra={}) => ({state,checksum:hash,specification_checksum:spec,original_sql:'SELECT 1;',reason:'Needs correction',review:null,attempts:5,...extra});
    const rpc = (name,args) => db.query('SELECT public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') AS value',args).then(r=>r.rows[0].value);
    const transition = (version,state,extra={},path=file) => rpc('transition_requirement_migration',[id,path,version,7,value(state,extra)]);
    const rejected = (fn,code) => assert.rejects(fn,e=>e.code===code);
    try {
      await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; "+
        "CREATE TABLE public.requirements(id uuid PRIMARY KEY,status text,metadata jsonb,updated_at timestamptz,site_id uuid DEFAULT gen_random_uuid()); "+
        "CREATE TABLE public.requirement_status(site_id uuid,instance_id uuid,requirement_id uuid,stage text,message text); "+
        "CREATE TABLE public.remote_instances(id uuid PRIMARY KEY,site_id uuid,status text,is_archived boolean DEFAULT false,updated_at timestamptz); "+
        "CREATE TABLE public.instance_plans(id uuid PRIMARY KEY,instance_id uuid,status text,steps jsonb,metadata jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz); "+
        "CREATE FUNCTION public.assert_requirement_cron_execution_owner(uuid,text,integer,boolean,boolean) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('current',$2='run') $$;");
      await db.exec(readFileSync('supabase/migrations/20260930010000_requirement_migration_lifecycle.sql','utf8'));
      await db.exec(readFileSync('supabase/migrations/20261001053000_migration_diagnostic_handoff.sql','utf8'));
      await db.exec(readFileSync('supabase/migrations/20261001190500_migration_hold_visibility.sql','utf8'));
      await db.query('INSERT INTO requirements(id,status,metadata,updated_at) VALUES ($1,$2,$3,now())',[id,'in-progress',{requirement_execution_generation:7,runner_instance_id:instance}]);
      await db.query('INSERT INTO remote_instances(id,status) VALUES ($1,$2)',[instance,'running']);
      await db.query('UPDATE remote_instances SET site_id=(SELECT site_id FROM requirements WHERE id=$1) WHERE id=$2',[id,instance]);
      await db.query('INSERT INTO instance_plans(id,instance_id,status,steps,metadata) VALUES ($1,$2,$3,$4,$5)',[plan,instance,'in_progress',[{id:'step',status:'in_progress'}],{requirement_id:id}]);
      await transition(0,'correction_required');
      await rejected(()=>rpc('claim_migration_diagnostic',[id,file,1,7,'other-run']),'40001');
      await db.exec('SET ROLE authenticated');
      await rejected(()=>rpc('claim_migration_diagnostic',[id,file,1,7,'run']),'42501');
      await rejected(()=>db.query('SELECT * FROM requirement_migration_diagnostics'),'42501');
      await db.exec('RESET ROLE; SET ROLE service_role');
      const claim = await rpc('claim_migration_diagnostic',[id,file,1,7,'run']);
      assert.equal(claim.state,'running');
      assert.equal(await rpc('claim_migration_diagnostic',[id,file,1,7,'run']),null);
      await rejected(()=>db.query("UPDATE requirement_migration_diagnostics SET state='followup_ready'"),'42501');
      await db.exec('RESET ROLE');
      const result={decision:'repair_candidate',reason:'New hypothesis',hypothesis:'Use membership',instruction:'Repair membership',verification:'Test unrelated users',evidence:[{id:'migration'}],next_action:'Correct and validate'};
      await rejected(()=>rpc('complete_migration_diagnostic',[id,file,instance,7,'run',result]),'40001');
      const completed=await rpc('complete_migration_diagnostic',[id,file,claim.token,7,'run',result]);
      assert.equal(completed.state,'followup_ready');
      assert.deepEqual(await rpc('complete_migration_diagnostic',[id,file,claim.token,7,'run',result]),completed);
      await rejected(()=>rpc('complete_migration_diagnostic',[id,file,claim.token,7,'run',{...result,reason:'Different'}]),'40001');
      await rejected(()=>rpc('begin_migration_diagnostic_review',[id,file,1,7,value('reviewing',{checksum:'c'.repeat(64)})]),'40001');
      await rpc('assign_migration_diagnostic_followup',[id,file,claim.token,7,'run']);
      await rpc('assign_migration_diagnostic_followup',[id,file,claim.token,7,'run']);
      await rejected(()=>transition(1,'reviewing'),'23514');
      await rejected(()=>rpc('begin_migration_diagnostic_review',[id,file,1,7,value('reviewing')]),'23514');
      await rejected(()=>rpc('begin_migration_diagnostic_review',[id,file,1,7,value('reviewing',{checksum:'c'.repeat(64),specification_checksum:'d'.repeat(64)})]),'23514');
      // Failed final update rolls back consumption of the single review allowance.
      await db.exec("CREATE FUNCTION fixture_fail_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='followup_reviewing' THEN RAISE EXCEPTION 'failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_fail_review BEFORE UPDATE ON requirement_migration_diagnostics FOR EACH ROW EXECUTE FUNCTION fixture_fail_review();");
      await rejected(()=>rpc('begin_migration_diagnostic_review',[id,file,1,7,value('reviewing',{checksum:'c'.repeat(64)})]),'P0001');
      assert.equal((await db.query('SELECT state FROM requirement_migration_lifecycle')).rows[0].state,'correction_required');
      await db.exec('DROP TRIGGER fixture_fail_review ON requirement_migration_diagnostics; DROP FUNCTION fixture_fail_review();');
      const review=await rpc('begin_migration_diagnostic_review',[id,file,1,7,value('reviewing',{checksum:'c'.repeat(64),review:{decision:'approved'}})]);
      assert.equal(review.state,'reviewing'); assert.equal(review.attempts,5); assert.equal(review.review,null);
      await rejected(()=>rpc('begin_migration_diagnostic_review',[id,file,2,7,value('reviewing',{checksum:'d'.repeat(64)})]),'23514');
      await rejected(()=>db.query("UPDATE requirements SET status='done' WHERE id=$1",[id]),'23514');
      await transition(2,'validation_pending',{checksum:'c'.repeat(64)});
      await rejected(()=>db.query("UPDATE requirements SET status='done' WHERE id=$1",[id]),'23514');
      await transition(3,'validated',{checksum:'c'.repeat(64)});
      await db.query("UPDATE requirements SET status='done' WHERE id=$1",[id]);
      // Another file can be unresolved; it cannot erase the first file's receipt.
      const second='migrations/0002.sql';
      await db.query("UPDATE requirements SET status='in-progress' WHERE id=$1",[id]);
      await transition(0,'correction_required',{},second);
      const secondClaim=await rpc('claim_migration_diagnostic',[id,second,1,7,'run']);
      await rpc('complete_migration_diagnostic',[id,second,secondClaim.token,7,'run',{decision:'unresolved',reason:'Evidence insufficient',evidence:[],next_action:'Inspect evidence'}]);
      await rpc('hold_migration_diagnostic',[id,second,1,7,'run',plan,'step','Unresolved automatically; not proof of impossibility.']);
      assert.equal((await db.query('SELECT status FROM requirements')).rows[0].status,'blocked');
      assert.equal((await db.query('SELECT status FROM remote_instances')).rows[0].status,'pending');
      assert.equal((await db.query('SELECT status FROM instance_plans')).rows[0].status,'blocked');
      assert.equal((await db.query('SELECT stage FROM requirement_status')).rows[0].stage,'blocked');
      assert.equal((await db.query('SELECT state FROM requirement_migration_lifecycle WHERE file=$1',[file])).rows[0].state,'validated');
      await rejected(()=>db.query("UPDATE requirements SET status='in-progress' WHERE id=$1",[id]),'23514');
      // A generic resume cannot reset diagnostics. Even explicit technical release
      // and a new generation do not recreate its diagnostic allowance.
      await transition(2,'correction_required',{},second);
      await db.query("UPDATE requirements SET status='in-progress',metadata=jsonb_set(metadata,'{requirement_execution_generation}','8') WHERE id=$1",[id]);
      await rejected(()=>rpc('claim_migration_diagnostic',[id,second,3,7,'run']),'40001');
      assert.equal(await rpc('claim_migration_diagnostic',[id,second,3,8,'run']),null);
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8', timeout: 40_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr?.slice(-5000) || child.error?.message || 'PGlite diagnostic test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 45_000);