import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const tagBindings = [
  ['details', 'requirement_id', 'instance_logs_deletion_details_requirement_idx'],
  ['details', 'requirementId', 'instance_logs_deletion_details_requirement_camel_idx'],
  ['tool_args', 'requirement_id', 'instance_logs_deletion_tool_requirement_idx'],
  ['tool_args', 'requirementId', 'instance_logs_deletion_tool_requirement_camel_idx'],
];
export const indexMigrations = [
  '20261019230000_index_deletion_log_details_requirement.sql',
  '20261019230001_index_deletion_log_details_requirement_camel.sql',
  '20261019230002_index_deletion_log_tool_requirement.sql',
  '20261019230003_index_deletion_log_tool_requirement_camel.sql',
];
export const preflightMigration = '20261019230004_indexed_instance_deletion_preflight.sql';
const source = name => readFileSync(resolve('supabase/migrations', name), 'utf8');
const correction = source(preflightMigration);
export const preflightQuery = correction.match(/new_query text := \$new\$([\s\S]*?)\$new\$/)[1];
const oldQuery = correction.match(/old_query text := \$old\$([\s\S]*?)\$old\$/)[1];
const parameterize = query => query.replaceAll('ids::text[]', '$2::text[]')
  .replaceAll('cardinality(ids)', 'cardinality($2::text[])').replaceAll('i.id', '$1::uuid');
const planText = async (db, query, instance, ids) => JSON.stringify((await db.query(
  `EXPLAIN (FORMAT JSON) SELECT EXISTS (${parameterize(query)})`, [instance, ids],
)).rows);

export async function installIndexedPreflight(db) {
  const before = (await db.query("SELECT pg_get_functiondef('get_robot_instance_deletion_scope(uuid)'::regprocedure) v, proacl::text acl FROM pg_proc WHERE oid='get_robot_instance_deletion_scope(uuid)'::regprocedure")).rows[0];
  assert.ok(before.v.includes(oldQuery));
  await assert.rejects(db.exec(correction), /Missing, invalid or incompatible deletion index/);
  await db.exec('ROLLBACK');
  for (const name of indexMigrations) {
    const sql = source(name);
    assert.ok(sql.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS'));
    await db.exec(sql);
    await db.exec(sql);
  }
  await db.exec(correction);
  await db.exec(correction);
  const after = (await db.query("SELECT pg_get_functiondef('get_robot_instance_deletion_scope(uuid)'::regprocedure) v, proacl::text acl FROM pg_proc WHERE oid='get_robot_instance_deletion_scope(uuid)'::regprocedure")).rows[0];
  assert.equal(after.v, before.v.replace(oldQuery, preflightQuery), 'only the reviewed query changes');
  assert.equal(after.acl, before.acl, 'function ACLs must not change');

  await db.exec(`BEGIN; DROP INDEX ${tagBindings[0][2]}; CREATE INDEX ${tagBindings[0][2]} ON instance_logs(instance_id)`);
  await assert.rejects(db.exec(correction), /Missing, invalid or incompatible deletion index/);
  await db.exec('ROLLBACK');
  await db.exec(`BEGIN; DROP INDEX ${tagBindings[0][2]}; CREATE INDEX ${tagBindings[0][2]}
    ON instance_logs ((lower(details->>'requirement_id')) COLLATE "C")
    WHERE details->>'requirement_id' IS NOT NULL`);
  await assert.rejects(db.exec(correction), /Missing, invalid or incompatible deletion index/);
  await db.exec('ROLLBACK');
  const incompatible = after.v.replace(preflightQuery, 'SELECT 1 FROM public.instance_logs WHERE false');
  await db.exec(`BEGIN; ${incompatible}`);
  await assert.rejects(db.exec(correction), /Unexpected deletion preflight definition/);
  await db.exec('ROLLBACK');
  console.log('PASS indexed preflight preserves deployed guards and ACLs; missing/wrong indexes fail closed');
}

export async function checkIndexedPreflight({ db, one, check, scope, remove, rejected, id,
  site, otherSite, instance, otherInstance, req, otherReq }) {
  await check('all log tag spellings and types reject shared requirements without cleanup', async () => {
    assert.notEqual(req, req.toUpperCase(), 'fixture must exercise UUID case normalization');
    await db.query('UPDATE remote_instances SET site_id=$1 WHERE id=$2', [site, otherInstance]);
    for (const [column, key] of tagBindings) {
      for (const logType of ['system', 'assistant_step', 'user_action']) {
        await db.exec('SAVEPOINT tag_variant');
        await db.query(`INSERT INTO instance_logs(id,site_id,instance_id,log_type,message,${column}) VALUES($1,$2,$3,$4,'shared tag',$5)`,
          [id(91), site, otherInstance, logType, { [key]: req.toUpperCase() }]);
        await rejected(scope, 'PT409');
        await rejected(remove, 'PT409');
        await db.exec('ROLLBACK TO SAVEPOINT tag_variant; RELEASE SAVEPOINT tag_variant');
      }
      await db.query(`INSERT INTO instance_logs(id,site_id,instance_id,log_type,message,${column}) VALUES($1,$2,$3,'system','own tag',$4)`,
        [id(92 + tagBindings.findIndex(b => b[0] === column && b[1] === key)), site, instance, { [key]: req.toUpperCase() }]);
    }
    assert.deepEqual((await scope()).requirement_ids, [req]);
    assert.deepEqual(await remove(), { instance_id: instance, deleted_requirement_ids: [req] });
  });
  await check('legacy cross-tenant tags still block deletion with the binding guard enabled', async () => {
    for (const [column, key] of tagBindings) {
      await db.exec('SAVEPOINT legacy_tag');
      // Isolated fixture only: model data predating the write guard, then restore it.
      await db.exec('ALTER TABLE instance_logs DISABLE TRIGGER instance_log_requirement_binding_guard');
      await db.query(`INSERT INTO instance_logs(id,site_id,instance_id,log_type,message,${column})
        VALUES($1,$2,$3,'system','legacy cross-tenant tag',$4)`,
      [id(91), otherSite, otherInstance, { [key]: req.toUpperCase() }]);
      await db.exec('ALTER TABLE instance_logs ENABLE TRIGGER instance_log_requirement_binding_guard');
      assert.equal((await one("SELECT tgenabled FROM pg_trigger WHERE tgname='instance_log_requirement_binding_guard'")).tgenabled, 'O');
      await rejected(scope, 'PT409');
      await rejected(remove, 'PT409');
      await db.exec('ROLLBACK TO SAVEPOINT legacy_tag; RELEASE SAVEPOINT legacy_tag');
    }
  });
  await check('nonempty scope uses all four indexes with unrelated tagged history', async () => {
    // Nonempty irrelevant tags defeat optimizations limited to null/empty fixtures.
    await db.query(`INSERT INTO instance_logs(site_id,instance_id,log_type,message,details,tool_args)
      SELECT $1,$2,'system','unrelated tagged history',
        jsonb_build_object('requirement_id',$3::text,'requirementId',$3::text),
        jsonb_build_object('requirement_id',$3::text,'requirementId',$3::text)
      FROM generate_series(1,20000)`, [otherSite, otherInstance, otherReq]);
    await db.exec('ANALYZE instance_logs');
    const plan = await planText(db, preflightQuery, instance, [req]);
    for (const [, , index] of tagBindings) assert.ok(plan.includes(index), `missing index scan: ${index}`);
    assert.ok(!plan.includes('"Node Type":"Seq Scan"'), 'tag search must not scan unrelated logs');
    const emptyPlan = await planText(db, preflightQuery, instance, []);
    assert.ok(!emptyPlan.includes('"Relation Name":"instance_logs"'), 'empty scope must not scan logs');
    assert.deepEqual((await scope()).requirement_ids, [req]);
    assert.deepEqual(await remove(), { instance_id: instance, deleted_requirement_ids: [req] });
    assert.equal((await one('SELECT count(*)::int n FROM instance_logs WHERE instance_id=$1', [otherInstance])).n, 20000);
  });
}