import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261104101000_procurement_workflow_confidentiality.sql'), 'utf8');

it('executes confidentiality policies and denies ordinary readers of derived workflow data', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
      $$;
      CREATE TABLE sites(id uuid PRIMARY KEY);
      CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid);
      CREATE TABLE workflow_runs(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,payload jsonb);
      CREATE TABLE workflow_triggers(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,kind text,config jsonb);
      CREATE TABLE instance_plans(id uuid,instance_id uuid,site_id uuid,metadata jsonb);
      CREATE TABLE instance_nodes(id uuid,instance_id uuid,site_id uuid);
      CREATE TABLE instance_logs(id uuid,instance_id uuid,site_id uuid);
      CREATE TABLE instance_context_state(instance_id uuid,site_id uuid);
      CREATE TABLE instance_context_memories(instance_id uuid,site_id uuid);
      CREATE FUNCTION procurement_tender_access(uuid,text) RETURNS boolean LANGUAGE sql AS $$
        SELECT auth.uid()='11111111-1111-4111-8111-111111111111'::uuid
      $$;
      CREATE FUNCTION site_user_has_effective_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
      GRANT USAGE ON SCHEMA public,auth TO authenticated;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
      ALTER TABLE remote_instances ENABLE ROW LEVEL SECURITY;
      CREATE POLICY members ON remote_instances FOR SELECT TO authenticated USING(true);
      ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY members ON workflow_runs FOR SELECT TO authenticated USING(true);
      ALTER TABLE instance_plans ENABLE ROW LEVEL SECURITY;
      CREATE POLICY members ON instance_plans FOR SELECT TO authenticated USING(true);
      CREATE FUNCTION cloud_file_check_scope(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_requirement_id uuid)
      RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF p_site_id IS NULL OR public.site_user_has_effective_access(p_site_id,p_user_id) IS DISTINCT FROM true THEN
          RAISE EXCEPTION 'Cloud scope denied';
        END IF;
      END $$;
    `);
    await db.exec(sql);
    const site = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const instance = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const manager = '11111111-1111-4111-8111-111111111111';
    const member = '22222222-2222-4222-8222-222222222222';
    await db.query('INSERT INTO sites VALUES($1)', [site]);
    await db.query('INSERT INTO remote_instances VALUES($1,$2,$3)', [instance, site, manager]);
    await db.query('SELECT procurement_workflow_protect_instance($1,$2)', [site, instance]);
    await db.query('INSERT INTO instance_plans VALUES($1,$2,$3,$4)', [
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', instance, site, JSON.stringify({ trigger_payload: { table: 'procurement_tenders' } }),
    ]);
    await db.query('INSERT INTO workflow_runs VALUES($1,$2,$3,$4)', [
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', instance, site, JSON.stringify({ table: 'procurement_tenders', row: { description: 'Private budget' } }),
    ]);
    await expect(db.query('SELECT cloud_file_check_scope($1,$2,$3,NULL)', [site, member, instance]))
      .rejects.toThrow('Cloud scope denied');
    await db.query('SELECT cloud_file_check_scope($1,$2,$3,NULL)', [site, manager, instance]);
    await db.exec('SET ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: member, role: 'authenticated' })]);
    for (const table of ['remote_instances', 'workflow_runs', 'instance_plans']) {
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    }
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: manager, role: 'authenticated' })]);
    expect((await db.query('SELECT * FROM workflow_runs')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM instance_plans')).rows).toHaveLength(1);
    expect((await db.query<{ uid: string }>('SELECT auth.uid() AS uid')).rows[0].uid).toBe(manager);
    await db.exec('RESET ROLE; DELETE FROM workflow_runs; DELETE FROM workflow_triggers; SET ROLE authenticated;');
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: member, role: 'authenticated' })]);
    expect((await db.query('SELECT * FROM instance_plans')).rows).toHaveLength(0);
  } finally { await db.close(); }
}, 20000);