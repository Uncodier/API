// Disposable socket-only PostgreSQL. Never reads .env or a configured database URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexMigrations, preflightMigration, preflightQuery, tagBindings } from './deletion-index-regression.mjs';

const bin = '/opt/homebrew/opt/postgresql@17/bin';
if (!['initdb', 'pg_ctl', 'psql'].every(name => existsSync(join(bin, name)))) {
  throw new Error('Native PostgreSQL 17 binaries are required for this optional local verification');
}
const directory = mkdtempSync('/tmp/deletion-index-pg-');
const env = { PATH: process.env.PATH, LC_ALL: 'C', LANG: 'C' };
const here = dirname(fileURLToPath(import.meta.url));
const run = (name, args, options = {}) => execFileSync(join(bin, name), args,
  { encoding: 'utf8', env, timeout: 120_000, stdio: 'pipe', ...options });
const sql = query => run('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  '-h', directory, '-p', '55447', '-U', 'postgres', '-d', 'postgres'], { input: query }).trim();
const load = name => sql(readFileSync(resolve('supabase/migrations', name), 'utf8'));
const id = n => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const site = id(1), otherSite = id(2), instance = id(3), otherInstance = id(4);
const req = id(5), otherReq = id(6), user = id(7);
const parameterQuery = preflightQuery.replaceAll('ids::text[]', '$2::text[]')
  .replaceAll('cardinality(ids)', 'cardinality($2::text[])').replaceAll('i.id', '$1::uuid');
try {
  run('initdb', ['-D', join(directory, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale']);
  run('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'),
    '-o', `-F -p 55447 -k ${directory} -c listen_addresses='' -c lc_messages=C`, '-w', 'start']);
  sql(readFileSync(join(here, 'deletion-fixture.sql'), 'utf8'));
  for (const name of [
    '20260930010000_requirement_migration_lifecycle.sql',
    '20261001053000_migration_diagnostic_handoff.sql',
    '20261001220000_harness_diagnostic_decisions.sql',
    '20261002010000_migration_operator_reconciliation.sql',
    '20261003010000_migration_execution_handoff.sql',
    '20261003180000_robot_instance_requirement_deletion.sql',
    '20261003180001_robot_instance_requirement_deletion_rpc.sql',
    '20261005220000_bound_empty_instance_deletion_preflight.sql',
  ]) load(name);
  // Reproduce the production instance/parent indexes without adding tag indexes yet.
  sql(`CREATE INDEX ON instance_logs(instance_id);
    CREATE INDEX ON instance_logs(parent_log_id);
    INSERT INTO sites VALUES ('${site}','${user}'),('${otherSite}','${id(8)}');
    INSERT INTO test_capabilities VALUES ('${site}',true),('${otherSite}',true);
    INSERT INTO remote_instances(id,site_id,status) VALUES
      ('${instance}','${site}','paused'),('${otherInstance}','${otherSite}','stopped');
    INSERT INTO requirements(id,site_id,status,metadata) VALUES
      ('${req}','${site}','blocked',jsonb_build_object('runner_instance_id','${instance}')),
      ('${otherReq}','${otherSite}','done',jsonb_build_object('runner_instance_id','${otherInstance}'));
    INSERT INTO instance_logs(site_id,instance_id,log_type,message,details,tool_args)
      SELECT '${otherSite}','${otherInstance}','system','unrelated history',
        jsonb_build_object('requirement_id','${otherReq}','requirementId','${otherReq}',
          'payload',repeat(md5(n::text),16)),
        jsonb_build_object('requirement_id','${otherReq}','requirementId','${otherReq}')
      FROM generate_series(1,563000) n;
    ANALYZE instance_logs;`);
  const before = JSON.parse(sql(`SELECT json_build_object('definition',pg_get_functiondef(oid),'acl',proacl::text)
    FROM pg_proc WHERE oid='get_robot_instance_deletion_scope(uuid)'::regprocedure`));
  const oldQuery = readFileSync(resolve('supabase/migrations', preflightMigration), 'utf8')
    .match(/old_query text := \$old\$([\s\S]*?)\$old\$/)[1];
  const concrete = query => query.replaceAll('ids::text[]', `ARRAY['${req}']::text[]`)
    .replaceAll('cardinality(ids)', '1').replaceAll('i.id', `'${instance}'::uuid`);
  const oldPlan = JSON.parse(sql(`EXPLAIN (ANALYZE, FORMAT JSON)
    SELECT EXISTS (${concrete(oldQuery)})`));
  assert.ok(JSON.stringify(oldPlan).includes('"Node Type":"Seq Scan"'));
  // Each concurrent build is its own psql call, outside any transaction.
  for (const name of indexMigrations) { load(name); load(name); }
  load(preflightMigration); load(preflightMigration);
  const after = JSON.parse(sql(`SELECT json_build_object('definition',pg_get_functiondef(oid),'acl',proacl::text)
    FROM pg_proc WHERE oid='get_robot_instance_deletion_scope(uuid)'::regprocedure`));
  assert.equal(after.definition, before.definition.replace(oldQuery, preflightQuery));
  assert.equal(after.acl, before.acl);
  const newPlan = JSON.parse(sql(`EXPLAIN (ANALYZE, FORMAT JSON)
    SELECT EXISTS (${concrete(preflightQuery)})`));
  for (const [, , index] of tagBindings) assert.ok(JSON.stringify(newPlan).includes(index), index);
  assert.ok(!JSON.stringify(newPlan).includes('"Node Type":"Seq Scan"'));
  for (const mode of ['force_custom_plan', 'force_generic_plan']) {
    const prepare = `SET plan_cache_mode='${mode}'; PREPARE tag_scope(uuid,text[]) AS SELECT EXISTS (${parameterQuery});`;
    const plan = sql(`${prepare} EXPLAIN (FORMAT JSON) EXECUTE tag_scope('${instance}',ARRAY['${req}']);`);
    for (const [, , index] of tagBindings) assert.ok(plan.includes(index), `${mode}: ${index}`);
    const empty = JSON.parse(sql(`${prepare} EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE tag_scope('${instance}','{}');`));
    const visit = node => {
      if (node['Relation Name'] === 'instance_logs') assert.equal(node['Actual Loops'], 0);
      for (const child of node.Plans || []) visit(child);
    };
    visit(empty[0].Plan);
  }
  const actualScope = JSON.parse(sql(`SET statement_timeout='8s';
    SELECT set_config('request.jwt.claim.sub','${user}',false) IS NOT NULL;
    SET ROLE authenticated; SELECT get_robot_instance_deletion_scope('${instance}');`).split('\n').at(-1));
  assert.deepEqual(actualScope.requirement_ids, [req]);
  const countsBefore = sql('SELECT count(*) FROM instance_logs');
  assert.equal(countsBefore, '563000');
  // Simulate an interrupted build only in this disposable catalog; migration must fail closed.
  const correction = readFileSync(resolve('supabase/migrations', preflightMigration), 'utf8');
  assert.throws(() => sql(`BEGIN; UPDATE pg_index SET indisvalid=false
    WHERE indexrelid='${tagBindings[0][2]}'::regclass; ${correction}`), /Missing, invalid or incompatible/);
  assert.equal(sql('SELECT count(*) FROM instance_logs'), countsBefore);
  console.log(JSON.stringify({ rows: 563000, old_query_ms: oldPlan[0]['Execution Time'],
    indexed_query_ms: newPlan[0]['Execution Time'], custom_and_generic_plans: 'indexed',
    real_preflight: 'passed with 8s statement timeout', remote_mutations: false }, null, 2));
  console.log('PASS native PostgreSQL concurrent deletion indexes and 563000-row preflight');
} finally {
  if (existsSync(join(directory, 'data/postmaster.pid'))) {
    run('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  }
  rmSync(directory, { recursive: true, force: true });
}