import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const db = new PGlite(); // Memory only: no live credentials or network.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const req = id(1), owner = id(2), site = id(3), user = id(4), request = id(5);
const file = 'migrations/0001.sql';
const privateSql = `SELECT 1; -- ${randomBytes(24).toString('hex')}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const lifecycle = async () => (await one('SELECT to_jsonb(l) v FROM requirement_migration_lifecycle l WHERE requirement_id=$1', [req])).v;
const requirement = async () => (await one('SELECT to_jsonb(r) v FROM requirements r WHERE id=$1', [req])).v;
const archive = async () => (await one('SELECT to_jsonb(a) v FROM requirement_migration_retirements a WHERE id=$1', [request])).v;
const args = [req, file, 10, 34, owner, request, 'offline-operator', 'Retire legacy execution authority; normal SQL checks remain.'];
const signature = 'retire_requirement_migration_hold(uuid,text,integer,integer,uuid,uuid,text,text)';
const role = async (name, fn) => {
  await db.exec(`SET ROLE ${name}`);
  try { return await fn(); } finally { await db.exec('RESET ROLE').catch(() => {}); }
};
const retire = (patch = {}) => role('service_role', async () => (await one(
  `SELECT retire_requirement_migration_hold(${args.map((_, n) => `$${n + 1}`).join(',')}) v`,
  args.map((arg, n) => Object.hasOwn(patch, n) ? patch[n] : arg),
)).v);
const snapshot = async () => {
  const result = {};
  for (const table of ['requirements', 'remote_instances', 'instance_plans', 'requirement_migration_lifecycle',
    'requirement_migration_diagnostics', 'requirement_migration_retirements', 'instance_logs', 'apps_receipt_sentinel']) {
    result[table] = (await db.query(`SELECT to_jsonb(t) v FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
};
const rejected = async (fn, code) => {
  const before = await snapshot();
  await db.exec('SAVEPOINT rejection');
  await assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; });
  await db.exec('ROLLBACK TO SAVEPOINT rejection; RELEASE SAVEPOINT rejection; RESET ROLE');
  assert.deepEqual(await snapshot(), before, 'failed operations must roll back all writes');
};
async function seed() {
  await db.query('INSERT INTO requirements(id,site_id,user_id,status,metadata,instructions,backlog,backlog_revision) VALUES($1,$2,$3,$4,$5,$6,$7,7)',
    [req, site, user, 'blocked', { runner_instance_id: owner, requirement_execution_generation: 34,
      cron_attempts: 9, no_progress_cycles: 4 }, 'Current specification', { items: [{ id: 'item', status: 'pending', attempts: 3 }] }]);
  await db.query('INSERT INTO remote_instances(id,site_id,user_id,status,is_archived) VALUES($1,$2,$3,$4,false)', [owner, site, user, 'error']);
  await db.query('INSERT INTO requirement_migration_lifecycle(requirement_id,file,version,state,checksum,specification_checksum,original_sql,reason,attempts) VALUES($1,$2,10,$3,$4,$5,$6,$7,5)',
    [req, file, 'platform_review', digest(privateSql), digest('old spec'), privateSql, 'Legacy failed review']);
  await db.query('INSERT INTO instance_plans(id,instance_id,site_id,status,metadata,steps) VALUES($1,$2,$3,$4,$5,$6)',
    [id(6), owner, site, 'blocked', { requirement_id: req }, [{ id: 'step', status: 'blocked', retry_count: 3 }]]);
  await db.query('INSERT INTO requirement_migration_diagnostics(requirement_id,file,token,execution_generation,state,checksum,specification_checksum,result) VALUES($1,$2,$3,34,$4,$5,$6,$7)',
    [req, file, id(7), 'exhausted', digest(privateSql), digest('old spec'), { reason: 'Incomplete diagnosis' }]);
  await db.query('INSERT INTO apps_receipt_sentinel VALUES ($1)', [{ applied_at: '2026-09-01', checksum: digest('applied bytes') }]);
}
async function check(fn) {
  await db.exec('BEGIN');
  try { await seed(); await fn(); } finally { await db.exec('ROLLBACK; RESET ROLE'); }
}
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
    CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,user_id uuid,status text,metadata jsonb,instructions text,
      backlog jsonb,backlog_revision bigint,cron_lock_active boolean DEFAULT false,cron_lock_run_id text,
      cron_lock_expires_at timestamptz,updated_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid,status text,is_archived boolean DEFAULT false,
      updated_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,status text,metadata jsonb,steps jsonb,
      instructions text,retry_count integer,updated_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),instance_id uuid,site_id uuid,log_type text,
      level text,message text,details jsonb,created_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE requirement_status(requirement_id uuid,site_id uuid,instance_id uuid,stage text,message text);
    CREATE TABLE apps_receipt_sentinel(value jsonb);`);
  for (const migration of ['20260930010000_requirement_migration_lifecycle.sql',
    '20261001053000_migration_diagnostic_handoff.sql', '20261001190500_migration_hold_visibility.sql',
    '20261002010000_migration_operator_reconciliation.sql', '20261003010000_migration_execution_handoff.sql']) {
    await db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'));
  }
  await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role;');
  await db.exec(readFileSync('supabase/migrations/20261005010000_retire_legacy_migration_holds.sql', 'utf8'));
  for (const who of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await one('SELECT has_function_privilege($1,$2,$3) v', [who, signature, 'EXECUTE'])).v, who === 'service_role');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      assert.equal((await one('SELECT has_table_privilege($1,$2,$3) v', [who, 'requirement_migration_retirements', privilege])).v, false);
    }
  }
  await check(async () => {
    const before = await snapshot();
    await rejected(() => db.query('UPDATE requirements SET status=$1 WHERE id=$2', ['in-progress', req]), '23514');
    const result = await retire();
    assert.deepEqual(result, { receipt_id: request, state: 'transferred', resumed: false, already_recorded: false });
    const after = await snapshot();
    const prior = before.requirement_migration_lifecycle[0].v;
    const live = await lifecycle();
    const saved = await archive();
    assert.deepEqual(saved.prior_lifecycle, prior);
    assert.deepEqual(saved.prior_diagnostic, before.requirement_migration_diagnostics[0].v);
    assert.deepEqual(saved.prior_requirement_metadata, before.requirements[0].v.metadata);
    assert.equal(live.state, 'transferred');
    assert.equal(live.version, 11);
    assert.equal(live.attempts, 5);
    assert.equal(live.original_sql, privateSql);
    assert.equal(live.checksum, prior.checksum);
    assert.equal(live.specification_checksum, prior.specification_checksum);
    assert.equal((await requirement()).status, 'blocked');
    assert.equal((await requirement()).metadata.execution_hold, undefined);
    assert.equal((await requirement()).metadata.cron_attempts, 9);
    for (const table of ['remote_instances', 'instance_plans', 'requirement_migration_diagnostics', 'apps_receipt_sentinel']) {
      assert.deepEqual(after[table], before[table]);
    }
    assert.equal(after.instance_logs[0].v.details.resumed, false);
    // Private SQL exists only in the archive, never in browser audit messages.
    assert.equal(JSON.stringify(after.instance_logs).includes(privateSql), false);
    assert.equal((await retire()).already_recorded, true);
    await rejected(() => retire({ 7: 'Different reason' }), '23505');
    for (const sql of ['UPDATE requirement_migration_retirements SET reason=reason',
      'DELETE FROM requirement_migration_retirements', 'TRUNCATE requirement_migration_retirements',
      'UPDATE requirement_migration_lifecycle SET state=\'validated\'']) {
      await rejected(() => db.exec(sql), '23514');
    }
    await rejected(() => db.exec('DELETE FROM requirement_migration_lifecycle'), '23503');
    await db.query('UPDATE requirements SET status=$1 WHERE id=$2', ['in-progress', req]);
    assert.equal((await requirement()).status, 'in-progress');
    assert.equal((await lifecycle()).state, 'transferred', 'admission never fabricates validation');
  });
  await check(async () => {
    for (const patch of [{ 2: 9 }, { 3: 33 }, { 4: id(99) }]) await rejected(() => retire(patch), '40001');
    await db.exec('UPDATE requirements SET cron_lock_active=true');
    await rejected(() => retire(), '40001');
    await db.exec('UPDATE requirements SET cron_lock_active=false,cron_lock_expires_at=clock_timestamp()+interval \'1 hour\'');
    await rejected(() => retire(), '40001');
  });
  await check(async () => {
    for (const state of ['running', 'followup_reviewing']) {
      await db.query('UPDATE requirement_migration_diagnostics SET state=$1', [state]);
      await rejected(() => retire(), '23514');
    }
  });
  for (const state of ['reviewing', 'validation_pending', 'validated']) await check(async () => {
    await db.query('UPDATE requirement_migration_lifecycle SET state=$1', [state]);
    await rejected(() => retire(), '23514');
  });
  await check(async () => {
    await db.exec('UPDATE remote_instances SET is_archived=true,status=\'paused\'');
    await retire();
    const state = await one('SELECT is_archived,status FROM remote_instances');
    assert.deepEqual(state, { is_archived: true, status: 'paused' });
    assert.equal((await requirement()).status, 'blocked');
  });
  await check(async () => {
    await db.query('UPDATE requirements SET metadata=metadata || $1::jsonb', [{ execution_hold: { kind: 'other' } }]);
    await rejected(() => retire(), '23514');
  });
  await check(async () => {
    await db.query('UPDATE remote_instances SET user_id=$1', [id(99)]);
    await rejected(() => retire(), '40001');
  });
  await check(async () => {
    await db.exec('GRANT SELECT ON requirement_migration_retirements TO anon,authenticated');
    await retire();
    for (const who of ['anon', 'authenticated']) {
      assert.equal((await role(who, () => one('SELECT count(*)::int n FROM requirement_migration_retirements'))).n, 0);
    }
    await rejected(() => role('service_role', () => db.exec('DELETE FROM requirement_migration_retirements')), '42501');
  });
  console.log('PASS migration retirement PostgreSQL guards');
} finally { await db.close(); }