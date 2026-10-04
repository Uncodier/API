import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const db = new PGlite(); // In-memory only. No .env, external processes or network.
const here = dirname(fileURLToPath(import.meta.url));
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const site = id(1), otherSite = id(2), instance = id(3), otherInstance = id(4);
const req = id(5), otherReq = id(6), user = id(7), plan = id(8), log = id(9);
const file = 'migrations/0001.sql', checksum = 'a'.repeat(64);
const tables = ['requirements', 'remote_instances', 'instance_plans', 'instance_logs', 'requirement_status',
  'requirement_migration_lifecycle', 'requirement_migration_diagnostics', 'requirement_migration_reconciliations',
  'requirement_migration_reconciliation_resumes', 'requirement_migration_execution_handoffs',
  'requirement_harness_decisions', 'requirement_user_action_receipts', 'requirement_cron_cycle_outcomes',
  'campaign_requirements', 'requirement_segments', 'catalog_item_requirements', 'campaigns', 'segments',
  'catalog_items', 'instance_context', 'unrelated_instance_refs', 'api_keys', 'assets', 'agent_assets', 'content_assets',
  'workflow_triggers', 'workflow_runs', 'instance_nodes'];
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const load = name => db.exec(readFileSync(resolve('supabase/migrations', name), 'utf8'));
const role = async (name, fn) => {
  await db.exec(`SET ROLE ${name}`);
  try { return await fn(); } finally { await db.exec('RESET ROLE').catch(() => {}); }
};
const scope = () => role('authenticated', async () => (await one('SELECT get_robot_instance_deletion_scope($1) v', [instance])).v);
const remove = (ids = [req], provider = null, providerId = null, status = 'pending') => role('authenticated', async () =>
  (await one('SELECT delete_robot_instance_with_requirements($1,$2,$3,$4,$5) v', [instance, ids, provider, providerId, status])).v);
const snapshot = async () => {
  const result = {};
  for (const table of tables) result[table] = (await db.query(`SELECT to_jsonb(t) v FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
};
const rejected = async (fn, code) => {
  const before = await snapshot();
  await db.exec('SAVEPOINT rejection');
  await assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; });
  await db.exec('ROLLBACK TO SAVEPOINT rejection; RELEASE SAVEPOINT rejection; RESET ROLE');
  assert.deepEqual(await snapshot(), before, 'failure must roll back every affected row');
};
const seed = async () => {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.query('INSERT INTO sites VALUES($1,$3),($2,$4)', [site, otherSite, user, id(99)]);
  await db.query('INSERT INTO test_capabilities VALUES($1,true),($2,true)', [site, otherSite]);
  await db.query("INSERT INTO remote_instances(id,site_id,status) VALUES($1,$3,'pending'),($2,$4,'stopped')", [instance, otherInstance, site, otherSite]);
  await db.query("INSERT INTO requirements(id,site_id,status,metadata,instructions) VALUES($1,$3,'blocked',$5,'one'),($2,$4,'done',$6,'other')",
    [req, otherReq, site, otherSite, { runner_instance_id: instance, assistant_origin_instance_id: instance }, { runner_instance_id: otherInstance }]);
  await db.query("INSERT INTO instance_plans(id,instance_id,site_id,status,metadata) VALUES($1,$2,$3,'blocked',$4)", [plan, instance, site, { requirement_id: req }]);
  await db.query("INSERT INTO instance_logs(id,site_id,instance_id,log_type,message) VALUES($1,$2,$3,'system','history')", [log, site, instance]);
  await db.query("INSERT INTO requirement_status(requirement_id,site_id,instance_id,stage) VALUES($1,$2,$3,'blocked')", [req, site, instance]);
  await db.query('INSERT INTO requirement_user_action_receipts(requirement_id,action_id) VALUES($1,$2)', [req, log]);
  await db.query("INSERT INTO requirement_cron_cycle_outcomes VALUES($1,'cycle',$2)", [req, instance]);
  for (const table of ['segments', 'catalog_items']) await db.query(`INSERT INTO ${table} VALUES($1)`, [id(10)]);
  await db.query('INSERT INTO campaigns VALUES($1,$2)', [id(10), site]);
  await db.query('INSERT INTO assets VALUES($1,$2,$3)', [id(15), site, instance]);
  await db.query('INSERT INTO campaign_requirements VALUES($1,$2)', [id(10), req]);
  await db.query('INSERT INTO requirement_segments VALUES($1,$2)', [req, id(10)]);
  await db.query('INSERT INTO catalog_item_requirements VALUES($1,$2,$3,$4,$5)', [id(11), site, id(10), req, instance]);
  await db.query("INSERT INTO instance_context VALUES($1,'owned context')", [instance]);
};
const lifecycle = async () => db.query(`INSERT INTO requirement_migration_lifecycle
  (requirement_id,file,version,state,checksum,specification_checksum,reason,attempts)
  VALUES($1,$2,1,'correction_required',$3,$3,'needs repair',1)`, [req, file, checksum]);
const history = async () => {
  await lifecycle();
  await db.query(`INSERT INTO requirement_migration_diagnostics(requirement_id,file,execution_generation,state,checksum,specification_checksum)
    VALUES($1,$2,0,'exhausted',$3,$3)`, [req, file, checksum]);
  await db.query(`INSERT INTO requirement_harness_decisions(requirement_id,instance_id,site_id,request_id,decision,reason,payload,contract_snapshot,status)
    VALUES($1,$2,$3,$4,'escalate_support','needs help','{}','{}','recorded')`, [req, instance, site, id(12)]);
  await db.query(`INSERT INTO requirement_migration_reconciliations(id,requirement_id,file,site_id,instance_id,plan_id,step_id,operator_id,
    reason,execution_generation,backlog_revision,prior_lifecycle,specification_checksum,specification,evidence,request,lifecycle)
    VALUES($1,$2,$3,$4,$5,$6,'db','test','repair',0,0,'{}',$7,'spec','{}','{}','{}')`, [id(13), req, file, site, instance, plan, checksum]);
  await db.query("INSERT INTO requirement_migration_reconciliation_resumes(receipt_id,requirement_id,execution_generation,evidence) VALUES($1,$2,1,'{}')", [id(13), req]);
  const prior = (await one('SELECT to_jsonb(l) v FROM requirement_migration_lifecycle l WHERE requirement_id=$1', [req])).v;
  await db.query(`INSERT INTO requirement_migration_execution_handoffs(id,requirement_id,file,site_id,instance_id,operator_id,reason,
    prior_lifecycle,evidence,execution_generation,transferred_version) VALUES($1,$2,$3,$4,$5,'test','transfer',$6,'{}',0,2)`,
  [id(14), req, file, site, instance, prior]);
  await db.query(`UPDATE requirement_migration_lifecycle SET state='transferred',version=2,
    updated_at=(SELECT created_at FROM requirement_migration_execution_handoffs WHERE id=$2) WHERE requirement_id=$1`, [req, id(14)]);
};
const check = async (title, fn) => {
  await db.exec('BEGIN');
  try { await seed(); await fn(); console.log(`PASS ${title}`); } finally { await db.exec('ROLLBACK; RESET ROLE'); }
};

try {
  await db.exec(readFileSync(resolve(here, 'deletion-fixture.sql'), 'utf8'));
  for (const migration of ['20260930010000_requirement_migration_lifecycle.sql', '20261001053000_migration_diagnostic_handoff.sql',
    '20261001220000_harness_diagnostic_decisions.sql', '20261002010000_migration_operator_reconciliation.sql',
    '20261003010000_migration_execution_handoff.sql']) await load(migration);
  const legacy = (await one("SELECT pg_get_functiondef('check_delete_permission()'::regprocedure) v")).v;
  await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role');
  await load('20261003180000_robot_instance_requirement_deletion.sql');
  await load('20261003180001_robot_instance_requirement_deletion_rpc.sql');
  assert.equal((await one("SELECT pg_get_functiondef('check_delete_permission()'::regprocedure) v")).v, legacy);

  await check('authenticated-only RPCs despite hostile default ACLs', async () => {
    for (const name of ['get_robot_instance_deletion_scope(uuid)', 'delete_robot_instance_with_requirements(uuid,uuid[],text,text,text)']) {
      for (const who of ['anon', 'service_role']) assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') v', [who, name])).v, false);
      assert.equal((await one('SELECT has_function_privilege(\'authenticated\',$1,\'EXECUTE\') v', [name])).v, true);
      const config = (await one('SELECT proconfig FROM pg_proc WHERE oid=$1::regprocedure', [name])).proconfig;
      assert.ok(config.includes('search_path=""'));
    }
    for (const who of ['anon', 'service_role']) await rejected(() => role(who, () => db.query('SELECT get_robot_instance_deletion_scope($1)', [instance])), '42501');
    await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");
    await rejected(scope, 'PT401');
    await rejected(remove, 'PT401');
  });
  await check('owner deletes empty receipt tables without weakening their statement guards', async () => {
    assert.deepEqual(await scope(), { instance_id: instance, site_id: site, requirement_ids: [req], provider: null, provider_instance_id: null, status: 'pending' });
    for (const table of ['requirement_migration_reconciliations', 'requirement_migration_reconciliation_resumes', 'requirement_migration_execution_handoffs']) {
      await rejected(() => db.exec(`UPDATE ${table} SET requirement_id=requirement_id WHERE false`), '23514');
      await rejected(() => db.exec(`TRUNCATE ${table} CASCADE`), '23514');
    }
    assert.deepEqual(await remove(), { instance_id: instance, deleted_requirement_ids: [req] });
    assert.equal((await one('SELECT count(*)::int n FROM requirements WHERE id=$1', [req])).n, 0);
    await rejected(scope, 'PT404');
  });
  await check('full transferred history cascades; products campaigns and other instance survive', async () => {
    await history();
    const before = await snapshot();
    await remove();
    for (const table of tables.filter(t => !['requirements', 'remote_instances', 'campaigns', 'segments', 'catalog_items'].includes(t)))
      assert.equal((await one(`SELECT count(*)::int n FROM ${table}`)).n, 0, table);
    for (const table of ['campaigns', 'segments', 'catalog_items']) assert.deepEqual((await snapshot())[table], before[table]);
    assert.deepEqual((await one('SELECT to_jsonb(r) v FROM requirements r')).v, before.requirements.find(r => r.v.id === otherReq).v);
    assert.deepEqual((await one('SELECT to_jsonb(r) v FROM remote_instances r')).v, before.remote_instances.find(r => r.v.id === otherInstance).v);
  });
  await check('direct history mutations and transferred lifecycle deletion remain denied', async () => {
    await history();
    for (const table of ['requirement_migration_reconciliations', 'requirement_migration_reconciliation_resumes', 'requirement_migration_execution_handoffs']) {
      for (const statement of [`DELETE FROM ${table}`, `UPDATE ${table} SET requirement_id=requirement_id`, `TRUNCATE ${table} CASCADE`])
        await rejected(() => db.exec(statement), '23514');
      await rejected(() => role('service_role', () => db.exec(`DELETE FROM ${table}`)), '42501');
    }
    await rejected(() => db.exec('DELETE FROM requirement_migration_lifecycle'), '23514');
    await rejected(() => db.exec("UPDATE requirement_migration_lifecycle SET reason='changed'"), '23514');
  });
  await check('unrelated FK failure rolls back all requirement history and logs', async () => {
    await history();
    await db.query('INSERT INTO unrelated_instance_refs VALUES($1,$2)', [id(20), instance]);
    await rejected(remove, '23503');
  });
  await check('site_ownership owner and active admin supported', async () => {
    await db.query('UPDATE sites SET user_id=$1 WHERE id=$2', [id(99), site]);
    await db.query('INSERT INTO site_ownership VALUES($1,$2)', [site, user]);
    assert.equal((await scope()).site_id, site);
    await db.exec('SAVEPOINT owner'); await remove(); await db.exec('ROLLBACK TO SAVEPOINT owner');
    await db.exec('DELETE FROM site_ownership');
    await db.query("INSERT INTO site_members VALUES($1,$2,'admin','active')", [site, user]);
    await remove();
  });
  await check('members cross-site users missing capability and missing identity fail closed', async () => {
    await db.query('UPDATE sites SET user_id=$1 WHERE id=$2', [id(99), site]);
    await db.query("INSERT INTO site_members VALUES($1,$2,'member','active')", [site, user]);
    await rejected(scope, 'PT403'); await rejected(remove, 'PT403');
    await rejected(() => db.exec(`DELETE FROM requirements WHERE id='${req}'`), 'PT403');
    await db.exec("UPDATE site_members SET role='admin',status='inactive'"); await rejected(scope, 'PT403');
    await db.exec("UPDATE site_members SET status='active'; UPDATE test_capabilities SET allowed=NULL"); await rejected(scope, 'PT403');
    await db.exec('UPDATE test_capabilities SET allowed=false'); await rejected(remove, 'PT403');
    await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");
    await rejected(() => db.exec(`DELETE FROM requirements WHERE id='${req}'`), 'PT403');
  });
  await check('exact expected set and provider snapshot are mandatory', async () => {
    for (const ids of [null, [], [req, req], [req, null], [otherReq], [req, otherReq]]) await rejected(() => remove(ids), 'PT409');
    await rejected(() => remove([req], 'scrapybara'), 'PT409');
    await rejected(() => remove([req], null, 'changed'), 'PT409');
    await rejected(() => remove([req], null, null, 'stopped'), 'PT409');
    await scope();
    await db.query("INSERT INTO requirements(id,site_id,status,metadata) VALUES($1,$2,'blocked',$3)", [id(21), site, { runner_instance_id: instance }]);
    await rejected(remove, 'PT409');
  });
  await check('origin-only canonical ownership and zero requirements supported', async () => {
    await db.query('UPDATE requirements SET metadata=$2 WHERE id=$1', [req, { assistant_origin_instance_id: instance.toUpperCase() }]);
    await remove();
    await db.query("INSERT INTO remote_instances(id,site_id,status) VALUES($1,$2,'uninstantiated')", [instance, site]);
    assert.deepEqual((await scope()).requirement_ids, []);
    await remove([], null, null, 'uninstantiated');
  });

  await check('canonical-only discovery rejects legacy-only and shared associations', async () => {
    await db.exec('SAVEPOINT variant');
    for (const metadata of [{}, { runner_instance_id: instance, assistant_origin_instance_id: otherInstance },
      { runner_instance_id: otherInstance, assistant_origin_instance_id: instance }]) {
      // Seed legacy inconsistent rows before the binding change guard is evaluated.
      await db.query('UPDATE remote_instances SET site_id=$1 WHERE id=$2', [site, otherInstance]);
      await db.query('UPDATE requirements SET metadata=$2 WHERE id=$1', [req, metadata]);
      await rejected(scope, 'PT409'); await rejected(remove, 'PT409');
      await db.exec('ROLLBACK TO SAVEPOINT variant');
    }
    await db.query('UPDATE remote_instances SET site_id=$1 WHERE id=$2', [site, otherInstance]);
    await db.query('UPDATE requirement_status SET instance_id=$1 WHERE requirement_id=$2', [otherInstance, req]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await rejected(() => db.query('UPDATE requirement_status SET site_id=$1 WHERE requirement_id=$2', [otherSite, req]), '23514');
    await db.query('UPDATE catalog_item_requirements SET site_id=$1 WHERE requirement_id=$2', [otherSite, req]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query('UPDATE remote_instances SET site_id=$1,metadata=$2 WHERE id=$3', [site, { requirement_id: req }, otherInstance]);
    await rejected(scope, 'PT409');
  });
  await check('scope rejects shared plan/log descendant edges and foreign receipt roots', async () => {
    await db.exec('SAVEPOINT variant');
    await db.query("INSERT INTO instance_plans(id,instance_id,site_id,status,parent_plan_id) VALUES($1,$2,$3,'blocked',$4)", [id(22), otherInstance, otherSite, plan]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query("INSERT INTO instance_logs(site_id,instance_id,log_type,message,parent_log_id) VALUES($1,$2,'system','foreign',$3)", [otherSite, otherInstance, log]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query('INSERT INTO requirement_user_action_receipts(requirement_id,action_id) VALUES($1,$2)', [otherReq, log]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query('UPDATE instance_logs SET site_id=$1 WHERE id=$2', [otherSite, log]);
    await rejected(scope, 'PT409');
  });
  await check('active persisted execution signals reject deletion before mutations', async () => {
    const updates = [
      "UPDATE requirements SET cron_lock_active=true WHERE id=$1",
      "UPDATE requirements SET cron_lock_run_id='old-owner' WHERE id=$1",
      "UPDATE requirements SET cron_lock_expires_at=now()-interval '1 day' WHERE id=$1",
      "UPDATE requirements SET metadata=metadata||'{\"active_sandbox_id\":\"sandbox\"}' WHERE id=$1",
      "UPDATE requirement_status SET active_sandbox_id='sandbox',stage='in-progress' WHERE requirement_id=$1",
    ];
    for (const statement of updates) {
      await db.exec('SAVEPOINT active'); await db.query(statement, [req]);
      await rejected(scope, 'PT409'); await rejected(remove, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT active');
    }
    for (const statement of ["UPDATE instance_plans SET status='in_progress'", "UPDATE instance_plans SET steps='[{\"status\":\"running\"}]'",
      "UPDATE instance_plans SET metadata=metadata||'{\"active_sandbox_id\":\"sandbox\"}'",
      "UPDATE instance_logs SET log_type='user_action',details='{\"status\":\"running\"}'",
      `UPDATE remote_instances SET status='starting' WHERE id='${instance}'`,
      `UPDATE remote_instances SET status='running',provider_instance_id='provider-id' WHERE id='${instance}'`,
      `UPDATE remote_instances SET configuration='{\"sandbox_id\":\"sandbox\"}' WHERE id='${instance}'`]) {
      await db.exec('SAVEPOINT active'); await db.exec(statement);
      await rejected(scope, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT active');
    }
    await db.query("UPDATE remote_instances SET status='running' WHERE id=$1", [instance]);
    await db.query("UPDATE requirement_status SET active_sandbox_id='historical-sandbox',stage='blocked' WHERE requirement_id=$1", [req]);
    assert.equal((await scope()).provider_instance_id, null, 'legacy running without persisted execution can be removed');
    await remove([req], null, null, 'running');
  });
  await check('JSON bindings validate UUID existence tenant and use real row locks', async () => {
    for (const binding of ['not-a-uuid', id(88), otherInstance]) {
      await rejected(() => db.query('UPDATE requirements SET metadata=$2 WHERE id=$1', [req, { runner_instance_id: binding }]), '23514');
      await rejected(() => db.query("INSERT INTO requirements(id,site_id,metadata) VALUES($1,$2,$3)", [id(24), site, { assistant_origin_instance_id: binding }]), '23514');
    }
    for (const binding of ['not-a-uuid', id(88), otherReq]) {
      await rejected(() => db.query('UPDATE instance_plans SET metadata=$2 WHERE id=$1', [plan, { requirement_id: binding }]), '23514');
      await rejected(() => db.query('UPDATE remote_instances SET metadata=$2 WHERE id=$1', [instance, { requirement_id: binding }]), '23514');
    }
    await rejected(() => db.query('UPDATE requirements SET site_id=$2 WHERE id=$1', [req, otherSite]), '23514');
    await rejected(() => db.query('UPDATE instance_plans SET instance_id=$2 WHERE id=$1', [plan, otherInstance]), '23514');
    await remove();
    await rejected(() => db.query('INSERT INTO requirements(id,site_id,metadata) VALUES($1,$2,$3)', [id(25), site, { runner_instance_id: instance }]), '23514');
    for (const name of ['guard_requirement_instance_binding()', 'guard_instance_plan_requirement_binding()', 'guard_instance_requirement_metadata_binding()']) {
      const definition = (await one('SELECT pg_get_functiondef($1::regprocedure) v', [name])).v;
      assert.ok(definition.includes('FOR KEY SHARE'));
      for (const who of ['anon', 'authenticated', 'service_role'])
        assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') v', [who, name])).v, false);
    }
  });
  await check('changed provider metadata conflicting identity and trigger-suppressed deletes fail atomically', async () => {
    await db.exec('SAVEPOINT variant');
    await db.query('UPDATE remote_instances SET metadata=$2,configuration=$3 WHERE id=$1', [instance, { provider: 'scrapybara' }, { provider: 'other' }]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query('UPDATE remote_instances SET metadata=$2 WHERE id=$1', [instance, { provider: 'scrapybara' }]);
    await rejected(remove, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.exec("CREATE FUNCTION test_skip_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
    for (const table of ['requirements', 'remote_instances']) {
      await db.exec(`CREATE TRIGGER test_skip BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_skip_delete()`);
      await rejected(remove, 'PT409');
      await db.exec(`DROP TRIGGER test_skip ON ${table}`);
    }
  });
  await check('legacy real system root deletion remains distinct from authenticated RPC authorization', async () => {
    await db.exec("SELECT set_config('request.jwt.claim.sub','',false); GRANT SELECT,DELETE ON requirements TO service_role");
    await rejected(() => db.exec(`DELETE FROM requirements WHERE id='${req}'`), 'PT403');
    await role('service_role', () => db.query('DELETE FROM requirements WHERE id=$1', [req]));
    assert.equal((await one('SELECT count(*)::int n FROM requirements WHERE id=$1', [req])).n, 0);
    await rejected(() => role('service_role', () => db.query('SELECT get_robot_instance_deletion_scope($1)', [instance])), '42501');
  });
  await check('only requirement-issued platform credentials are revoked, atomically', async () => {
    for (const [key, requirement, keySite, issuer] of [[id(31), req, site, 'platform-api.ensure-platform-key'],
      [id(32), req, site, 'user'], [id(33), otherReq, otherSite, 'platform-api.ensure-platform-key']])
      await db.query("INSERT INTO api_keys VALUES($1,$2,'active',$3)", [key, keySite, { requirement_id: requirement, issued_by: issuer }]);
    await db.exec('SAVEPOINT failure');
    await db.query('INSERT INTO unrelated_instance_refs VALUES($1,$2)', [id(34), instance]);
    await rejected(remove, '23503');
    await db.exec('ROLLBACK TO SAVEPOINT failure');
    await remove();
    assert.equal((await one('SELECT status FROM api_keys WHERE id=$1', [id(31)])).status, 'revoked');
    for (const key of [id(32), id(33)]) assert.equal((await one('SELECT status FROM api_keys WHERE id=$1', [key])).status, 'active');
    await rejected(() => db.query("INSERT INTO api_keys VALUES($1,$2,'active',$3)", [id(35), site,
      { requirement_id: req, issued_by: 'platform-api.ensure-platform-key' }]), '23514');
    await rejected(() => db.query("UPDATE api_keys SET status='active' WHERE id=$1", [id(31)]), '23514');
  });
  await check('known log tags are discovery only and late tagged writes are fenced', async () => {
    await db.query('UPDATE remote_instances SET site_id=$1 WHERE id=$2', [site, otherInstance]);
    await db.query('UPDATE requirements SET site_id=$1 WHERE id=$2', [site, otherReq]);
    await db.exec('SAVEPOINT variant');
    await db.query('UPDATE instance_logs SET details=$1 WHERE id=$2', [{ requirementId: otherReq }, log]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query("INSERT INTO instance_logs(site_id,instance_id,log_type,message,tool_args) VALUES($1,$2,'system','tagged',$3)",
      [site, otherInstance, { requirement_id: req }]);
    await rejected(scope, 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query('UPDATE instance_logs SET details=$1 WHERE id=$2', [{ requirement_id: req }, log]);
    await remove();
    await rejected(() => db.query("INSERT INTO instance_logs(site_id,instance_id,log_type,message,details) VALUES($1,$2,'system','late',$3)",
      [site, otherInstance, { requirement_id: req }]), '23514');
  });
  await check('parent site cascade and direct child authorization remain narrow', async () => {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [id(98)]);
    for (const table of ['assets', 'campaign_requirements'])
      await rejected(() => db.exec(`DELETE FROM ${table}`), 'PT403');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user]);
    // Model a real site-root cascade with the same post-parent-delete visibility.
    await db.exec('ALTER TABLE requirements DROP CONSTRAINT requirements_site_id_fkey; ALTER TABLE requirements ADD FOREIGN KEY(site_id) REFERENCES sites ON DELETE CASCADE');
    await db.exec('ALTER TABLE remote_instances DROP CONSTRAINT remote_instances_site_id_fkey; ALTER TABLE remote_instances ADD FOREIGN KEY(site_id) REFERENCES sites ON DELETE CASCADE');
    await db.query('DELETE FROM sites WHERE id=$1', [site]);
    assert.equal((await one('SELECT count(*)::int n FROM requirements WHERE id=$1', [req])).n, 0);
  });
  await check('shared asset edges and cross-instance workflow plan/trigger edges are rejected', async () => {
    await db.query('INSERT INTO workflow_triggers(id,instance_id,site_id,template_plan_id) VALUES($1,$2,$3,$4)', [id(40), instance, site, plan]);
    await db.exec('SAVEPOINT variant');
    for (const table of ['agent_assets', 'content_assets']) {
      await db.query(`INSERT INTO ${table} VALUES($1)`, [id(15)]);
      await rejected(scope, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT variant');
    }
    await db.query("INSERT INTO requirement_status(requirement_id,instance_id,site_id,stage,asset_id) VALUES($1,$2,$3,'done',$4)",
      [otherReq, otherInstance, otherSite, id(15)]);
    await rejected(scope, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query('INSERT INTO workflow_triggers(id,instance_id,site_id,template_plan_id) VALUES($1,$2,$3,$4)', [id(41), otherInstance, otherSite, plan]);
    await rejected(scope, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT variant');
    for (const field of ['run_plan_id', 'template_plan_id', 'trigger_id']) {
      await db.query(`INSERT INTO workflow_runs(id,instance_id,site_id,status,${field}) VALUES($1,$2,$3,'completed',$4)`,
        [id(42), otherInstance, otherSite, field === 'trigger_id' ? id(40) : plan]);
      await rejected(scope, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT variant');
    }
    await db.query("INSERT INTO workflow_runs(id,instance_id,site_id,status,run_plan_id,trigger_id) VALUES($1,$2,$3,'completed',$4,$5)",
      [id(43), instance, site, plan, id(40)]);
    await remove();
    assert.equal((await one('SELECT count(*)::int n FROM workflow_runs')).n, 0);
    assert.equal((await one('SELECT count(*)::int n FROM workflow_triggers')).n, 0);
  });
  await check('running workflow/node and enabled scheduling reject deletion', async () => {
    await db.exec('SAVEPOINT variant');
    await db.query("INSERT INTO instance_nodes VALUES($1,$2,$3,'running')", [id(44), instance, site]);
    await rejected(scope, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query("INSERT INTO workflow_runs(id,instance_id,site_id,run_plan_id,status) VALUES($1,$2,$3,$4,'pending')", [id(45), instance, site, plan]);
    await rejected(scope, 'PT409'); await db.exec('ROLLBACK TO SAVEPOINT variant');
    await db.query('INSERT INTO workflow_triggers(id,instance_id,site_id,enabled) VALUES($1,$2,$3,true)', [id(46), instance, site]);
    await rejected(scope, 'PT409');
  });
  await check('receipt delete cannot mistake an RLS-hidden parent for a deleted parent', async () => {
    await history();
    await db.exec('ALTER TABLE requirements ENABLE ROW LEVEL SECURITY; GRANT SELECT ON requirements TO authenticated');
    await db.exec('GRANT SELECT,DELETE ON requirement_migration_execution_handoffs TO authenticated');
    await db.exec('CREATE POLICY test_receipt_delete ON requirement_migration_execution_handoffs FOR ALL TO authenticated USING(true) WITH CHECK(true)');
    assert.equal((await role('authenticated', () => one('SELECT count(*)::int n FROM requirements'))).n, 0);
    await rejected(() => role('authenticated', () => db.exec('DELETE FROM requirement_migration_execution_handoffs')), '23514');
  });

  console.log('PASS PostgreSQL atomic robot instance deletion');
} finally { await db.close(); }