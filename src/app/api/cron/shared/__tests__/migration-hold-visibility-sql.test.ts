import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('publishes holds atomically, preserves pauses and unrelated work, and does not reopen on release', () => {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const req='00000000-0000-4000-8000-000000000001', instance='00000000-0000-4000-8000-000000000002';
    const site='00000000-0000-4000-8000-000000000003', plan='00000000-0000-4000-8000-000000000004';
    const other='00000000-0000-4000-8000-000000000005';
    const file='migrations/0016.sql';
    const value=(state,reason='Correction budget exhausted')=>({state,reason,checksum:'a'.repeat(64),specification_checksum:'b'.repeat(64),attempts:5});
    const transition=(version,state,reason)=>db.query('SELECT transition_requirement_migration($1,$2,$3,7,$4)',[req,file,version,value(state,reason)]);
    const one=async(sql)=> (await db.query(sql)).rows[0];
    try {
      await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; " +
        "CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,status text,metadata jsonb,updated_at timestamptz); " +
        "CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,status text,updated_at timestamptz); " +
        "CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid,status text,metadata jsonb,steps jsonb,updated_at timestamptz); " +
        "CREATE TABLE requirement_status(requirement_id uuid,site_id uuid,instance_id uuid,stage text,message text);");
      await db.exec(readFileSync('supabase/migrations/20260930010000_requirement_migration_lifecycle.sql','utf8'));
      await db.exec(readFileSync('supabase/migrations/20261001190500_migration_hold_visibility.sql','utf8'));
      await db.query('INSERT INTO requirements VALUES ($1,$2,$3,$4,now())',[req,site,'in-progress',{runner_instance_id:instance,requirement_execution_generation:7}]);
      await db.query('INSERT INTO remote_instances VALUES ($1,$2,$3,now())',[instance,site,'running']);
      await db.query('INSERT INTO instance_plans VALUES ($1,$2,$3,$4,$5,now())',[plan,instance,'in_progress',{requirement_id:req},[{id:'step',status:'in_progress'},{id:'done',status:'completed'}]]);
      await transition(0,'platform_review');
      assert.equal((await one('SELECT status FROM requirements')).status,'blocked');
      assert.equal((await one('SELECT status FROM remote_instances')).status,'pending');
      let p=await one('SELECT * FROM instance_plans');
      assert.equal(p.status,'blocked'); assert.equal(p.steps[0].status,'blocked'); assert.equal(p.steps[1].status,'completed');
      assert.match((await one('SELECT message FROM requirement_status')).message,/0016.sql/);
      assert.match((await one("SELECT metadata->'execution_hold'->>'reason' reason FROM requirements")).reason,/correction\/review budget is exhausted/);
      await transition(1,'platform_review');
      assert.equal((await one('SELECT count(*)::int n FROM requirement_status')).n,1);
      await transition(2,'correction_required');
      assert.equal((await one('SELECT status FROM requirements')).status,'blocked');
      assert.equal((await one("SELECT metadata ? 'execution_hold' present FROM requirements")).present,false);
      // Paused plans/instances must not be changed by a later hold.
      await db.exec("UPDATE instance_plans SET status='paused'; UPDATE remote_instances SET status='paused';");
      await transition(3,'platform_review','Private SQL diagnostic password=do-not-publish');
      assert.ok(!JSON.stringify((await db.query('SELECT * FROM requirement_status')).rows).includes('do-not-publish'));
      assert.ok(!JSON.stringify((await db.query('SELECT metadata FROM requirements')).rows).includes('do-not-publish'));
      assert.equal((await one('SELECT status FROM instance_plans')).status,'paused');
      assert.equal((await one('SELECT status FROM remote_instances')).status,'paused');
      await transition(4,'correction_required');
      await db.query('INSERT INTO instance_plans VALUES ($1,$2,$3,$4,$5,now())',[other,instance,'in_progress',{requirement_id:other},[{id:'unrelated',status:'in_progress'}]]);
      await db.exec("UPDATE remote_instances SET status='running';");
      await transition(5,'platform_review','Other hold');
      assert.equal((await one('SELECT status FROM remote_instances')).status,'running');
      assert.equal((await db.query('SELECT status FROM instance_plans WHERE id=$1',[other])).rows[0].status,'in_progress');
      // Failure to publish is a rollback, not a silent blocked/running split.
      await transition(6,'correction_required');
      await db.exec("CREATE FUNCTION fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publish unavailable'; END $$; CREATE TRIGGER fail BEFORE INSERT ON requirement_status FOR EACH ROW EXECUTE FUNCTION fail_publish();");
      await assert.rejects(()=>transition(7,'platform_review','Cannot publish'), /publish unavailable/);
      assert.equal((await one('SELECT state FROM requirement_migration_lifecycle')).state,'correction_required');
      await db.exec('DROP TRIGGER fail ON requirement_status;');
      await transition(7,'platform_review','First file hold');
      await db.query('SELECT transition_requirement_migration($1,$2,0,7,$3)',[req,'migrations/0020.sql',value('platform_review','Second file hold')]);
      await db.query('SELECT transition_requirement_migration($1,$2,1,7,$3)',[req,'migrations/0020.sql',value('correction_required')]);
      assert.equal((await one("SELECT metadata->'execution_hold'->>'file' file FROM requirements")).file,file);
      await assert.rejects(()=>db.exec("UPDATE requirements SET status='in-progress'"),/platform review/);
      for (const role of ['anon','authenticated','service_role']) {
        const acl=await db.query("SELECT has_function_privilege($1,'public.publish_requirement_migration_hold()','EXECUTE') allowed",[role]);
        assert.equal(acl.rows[0].allowed,false);
      }
      console.log('passed');
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8', timeout: 40_000,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || 'PostgreSQL visibility test failed');
  expect(child.stdout.trim()).toBe('passed');
}, 45_000);