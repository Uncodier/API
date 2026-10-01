import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// In-memory PostgreSQL only: no credentials, network, or production writes.
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const inspect = async () => (await db.query(
  'select public.inspect_requirement_assistant_handoff($1,$2) result', [id(1), id(2)],
)).rows[0].result;
const activate = async () => (await db.query(
  "select public.activate_requirement_cron_run($1,'cron-test',8,7200) result", [id(1)],
)).rows[0].result;
const owner = async () => (await db.query(
  "select public.assert_requirement_cron_execution_owner($1,'cron-test',0) result", [id(1)],
)).rows[0].result;
const action = async (n, status, trusted = true) => db.query(
  `insert into instance_logs(id,site_id,instance_id,log_type,trusted_user_action,details,created_at)
   values($1,$2,$3,'user_action',$4,jsonb_build_object('status',$5::text),now()+($6::int*interval '1 second'))`,
  [id(n), id(3), id(2), trusted, status, n]);

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE requirements(id uuid PRIMARY KEY, site_id uuid, status text, cron text,
      created_at timestamptz, updated_at timestamptz, metadata jsonb,
      backlog jsonb, cron_lock_run_id text, cron_lock_expires_at timestamptz);
    CREATE TABLE remote_instances(id uuid PRIMARY KEY, site_id uuid, status text, is_archived boolean);
    CREATE TABLE instance_plans(id uuid PRIMARY KEY, instance_id uuid, status text,
      metadata jsonb, created_at timestamptz, updated_at timestamptz);
    CREATE TABLE requirement_status(requirement_id uuid, updated_at timestamptz);
    CREATE TABLE instance_logs(id uuid PRIMARY KEY, site_id uuid, instance_id uuid,
      log_type text, trusted_user_action boolean, details jsonb, created_at timestamptz);
  `);
  for (const file of ['20260917204500_atomic_requirement_cron_capacity.sql',
    '20260926070000_harness_execution_ownership.sql',
    '20260926090000_restore_current_month_requirement_cron_scope.sql',
    '20261001010000_requirement_assistant_handoff.sql',
    '20261001010000_requirement_assistant_handoff.sql']) {
    await db.exec(readFileSync(new URL(`../../../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await db.query(`insert into requirements(id,site_id,status,created_at,updated_at,metadata,
    cron_lock_run_id,cron_lock_expires_at) values($1,$2,'backlog',now(),now(),$3,'cron-test',now()+interval '2 hours')`,
  [id(1), id(3), { runner_instance_id: id(2), assistant_origin_instance_id: id(2) }]);
  await db.query("insert into remote_instances values($1,$2,'running',false)", [id(2), id(3)]);
  assert.equal((await inspect()).allowed, false, 'missing checkpoint is not a failure');
  await action(10, 'running');
  assert.equal((await inspect()).reason, 'assistant_action_not_finished');
  assert.equal((await activate()).state, 'stale', 'cron cannot activate during assistant execution');
  await db.exec("update instance_logs set created_at=now()-interval '2 days'");
  assert.equal((await inspect()).allowed, false, 'silence must not permit automatic replacement');
  await action(11, 'completed', false);
  assert.equal((await inspect()).allowed, false, 'untrusted completion cannot authorize handoff');
  for (const [n, status] of [[12, 'paused'], [13, 'stopped'], [14, 'cancelled']]) {
    await action(n, status);
    assert.equal((await inspect()).allowed, false, `${status} must not trigger recovery`);
  }
  await action(15, 'completed');
  assert.equal((await inspect()).allowed, true);
  assert.equal((await activate()).state, 'active', 'continue on same original after completed planning');
  assert.equal((await owner()).current, true);
  await db.query(`insert into requirements(id,site_id,status,created_at,updated_at,metadata,
    cron_lock_run_id,cron_lock_expires_at) values($1,$2,'backlog',now(),now(),$3,'cron-second',now()+interval '2 hours')`,
    [id(4), id(3), { runner_instance_id: id(2), assistant_origin_instance_id: id(2) }]);
  const second = await db.query("select public.activate_requirement_cron_run($1,'cron-second',8,7200) result", [id(4)]);
  assert.equal(second.rows[0].result.state, 'stale', 'two requirements cannot execute on the same instance');
  assert.equal((await db.query('select cron_lock_active from requirements where id=$1', [id(4)])).rows[0].cron_lock_active, false);
  await assert.rejects(action(16, 'running'), e => e.code === '55P03', 'interactive admission must not overlap cron');
  assert.equal((await owner()).current, true, 'rejected admission must not poison active owner');
  await db.exec('update requirements set cron_lock_active=false');
  await action(17, 'running');
  assert.equal((await activate()).state, 'stale', 'user action wins after preflight, before activation');
  await action(18, 'failed');
  assert.equal((await activate()).state, 'active', 'confirmed failed action resumes same instance');
  assert.equal((await db.query('select count(*)::int n from remote_instances')).rows[0].n, 1);
  await db.exec("update remote_instances set status='paused'");
  assert.equal((await inspect()).allowed, false);
  assert.equal((await owner()).current, false);
  const cleanup = await db.query("select public.assert_requirement_cron_execution_owner($1,'cron-test',0,false,true) result", [id(1)]);
  assert.equal(cleanup.rows[0].result.current, true, 'paused owner may still clean up its sandbox');
  await db.exec("update remote_instances set status='running',is_archived=true");
  assert.equal((await inspect()).allowed, false);
  await db.exec('update remote_instances set is_archived=false');
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(inspect(), e => e.code === '42501');
    await assert.rejects(activate(), e => e.code === '42501');
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  assert.equal((await inspect()).allowed, true);
  assert.equal((await owner()).current, true);
  await assert.rejects(db.query("select public.activate_requirement_cron_run_before_assistant_handoff($1,'cron-test',8,7200)", [id(1)]), e => e.code === '42501');
  console.log('PASS PostgreSQL assistant handoff: original identity, admission order, active/failed/paused, permissions');
} finally { await db.close(); }