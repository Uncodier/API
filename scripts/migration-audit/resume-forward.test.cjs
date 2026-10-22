const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { functionDefinitions } = require('./sql.cjs');

const migrationDirectory = path.resolve(__dirname, '../../supabase/migrations');
const source = fs.readFileSync(path.join(migrationDirectory,
  '20261022032532_complete_unused_reconciliation_resume.sql'), 'utf8');
const upstream = fs.readFileSync(path.join(migrationDirectory,
  '20261002020000_migration_reconciliation_fresh_resume.sql'), 'utf8');

test('new correction preserves all three reviewed function bodies without an evidence backfill', () => {
  expect(functionDefinitions(source).map(f => f.body)).toEqual(functionDefinitions(upstream).map(f => f.body));
  expect(source).toContain('EXISTS (SELECT 1 FROM public.requirement_migration_reconciliation_resumes)');
  expect(source).toContain('md5(p.prosrc)<>expected.body_md5');
  expect(source).toContain('The schema correction must not fabricate or resume receipts');
});

test('isolated PostgreSQL converges an empty draft, rejects repeat/drift and never invents receipts', async () => {
  const db = new PGlite();
  const load = name => db.exec(fs.readFileSync(path.join(migrationDirectory, name), 'utf8'));
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
      CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,status text,metadata jsonb,instructions text,
        backlog jsonb,backlog_revision bigint,cron_lock_active boolean DEFAULT false,cron_lock_expires_at timestamptz,
        cron_lock_run_id text,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,status text,is_archived boolean DEFAULT false,updated_at timestamptz DEFAULT now());
      CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,status text,metadata jsonb,steps jsonb,
        instructions text,retry_count integer,completed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid NOT NULL,instance_id uuid NOT NULL,
        log_type text,level text,message text NOT NULL,details jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE requirement_status(requirement_id uuid,site_id uuid,instance_id uuid,stage text,message text);
      CREATE TABLE requirement_user_action_receipts(requirement_id uuid,action_id uuid,action_created_at timestamptz,
        revision bigint,PRIMARY KEY(requirement_id,action_id));`);
    for (const file of ['20260923230000_durable_review_quarantine.sql',
      '20260930010000_requirement_migration_lifecycle.sql', '20261001053000_migration_diagnostic_handoff.sql',
      '20261001190500_migration_hold_visibility.sql', '20261002010000_migration_operator_reconciliation.sql']) await load(file);
    await db.exec(`ALTER TABLE requirement_migration_reconciliation_resumes DROP COLUMN evidence;
      DROP FUNCTION resume_reconciled_requirement_migration(uuid,uuid,jsonb);
      CREATE FUNCTION resume_reconciled_requirement_migration(uuid,uuid) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET timezone='UTC'
        AS $$ BEGIN RAISE EXCEPTION 'The draft must never be invoked'; END $$;
      REVOKE ALL ON FUNCTION resume_reconciled_requirement_migration(uuid,uuid) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION resume_reconciled_requirement_migration(uuid,uuid) TO service_role;`);
    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    let fixture = source;
    // Calibrate only the synthetic baseline's exact bodies and ACL owner name.
    // The production source retains its inspected baseline fingerprints.
    for (const [, signature, hash] of source.matchAll(/\('public\.([^']+)','([a-f0-9]{32})',ARRAY/g)) {
      const row = await one('SELECT md5(prosrc) AS hash,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure', [signature]);
      fixture = fixture.replace(hash, row.hash).replaceAll(`'postgres'`, `'${row.owner}'`)
        .replaceAll('{postgres=X/postgres}', `{${row.owner}=X/${row.owner}}`)
        .replaceAll('{postgres=X/postgres,service_role=X/postgres}', `{${row.owner}=X/${row.owner},service_role=X/${row.owner}}`);
    }
    await db.exec(fixture);
    expect((await one('SELECT count(*)::integer AS n FROM requirement_migration_reconciliation_resumes')).n).toBe(0);
    expect((await one("SELECT to_regprocedure('resume_reconciled_requirement_migration(uuid,uuid)') IS NULL AS absent")).absent).toBe(true);
    for (const actor of ['anon', 'authenticated', 'service_role']) {
      expect((await one('SELECT has_function_privilege($1,$2,$3) AS allowed',
        [actor, 'resume_reconciled_requirement_migration(uuid,uuid,jsonb)', 'EXECUTE'])).allowed).toBe(actor === 'service_role');
    }
    await expect(db.exec(fixture)).rejects.toThrow(/audited unused draft/);
    await db.exec('ROLLBACK');
  } finally { await db.close(); }
}, 30000);