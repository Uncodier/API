import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// In-memory PostgreSQL only. No URL, environment credentials, or external I/O.
const db = new PGlite();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const migration = 'supabase/migrations/20260926070000_harness_execution_ownership.sql';
const claim = async (max = 8, excluded = []) => (await db.query(
  'SELECT public.claim_requirement_cron_candidates($1,7200,$2::uuid[]) AS result',
  [max, excluded],
)).rows.map((row) => row.result);
const activate = async (req, run, max = 8) => (await db.query(
  'SELECT public.activate_requirement_cron_run($1,$2,$3,7200) AS result',
  [req, run, max],
)).rows[0].result;
const owner = async (req, run, generation, inactive = false, terminal = false) =>
  (await db.query('SELECT public.assert_requirement_cron_execution_owner($1,$2,$3,$4,$5) AS result',
    [req, run, generation, inactive, terminal])).rows[0].result;
const reset = () => db.exec('TRUNCATE requirements, remote_instances, instance_plans, requirement_status');
const insert = (n, status = 'in-progress', cron = null) => db.query(
  `INSERT INTO requirements(id,status,cron,created_at,updated_at,metadata,backlog)
   VALUES($1,$2,$3,now()-interval '2 months',now()-interval '1 month',
     '{"requirement_execution_generation":4,"other_key":"keep"}',
     '{"items":[{"id":"wip","status":"in_progress"}]}')`, [id(n), status, cron]);

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE requirements(id uuid PRIMARY KEY, status text, cron text,
      created_at timestamptz, updated_at timestamptz, metadata jsonb,
      backlog jsonb, cron_lock_run_id text, cron_lock_expires_at timestamptz);
    CREATE TABLE remote_instances(id uuid PRIMARY KEY, status text);
    CREATE TABLE instance_plans(id uuid PRIMARY KEY, instance_id uuid, status text,
      metadata jsonb, created_at timestamptz, updated_at timestamptz);
    CREATE TABLE requirement_status(requirement_id uuid, updated_at timestamptz);
  `);
  for (const file of [
    'supabase/migrations/20260917204500_atomic_requirement_cron_capacity.sql',
    'supabase/migrations/20260917204600_current_month_requirement_cron_scope.sql',
  ]) await db.exec(readFileSync(file, 'utf8'));
  await insert(1);
  assert.equal((await claim()).length, 0, 'fixture must reproduce previous-month exclusion');
  await db.exec(readFileSync(migration, 'utf8'));
  await db.exec(readFileSync(migration, 'utf8')); // forward migration reapplication is safe
  let [a] = await claim();
  assert.equal(a.requirement.id, id(1), 'old runnable requirement excluded');
  assert.equal(a.requirement.metadata.requirement_execution_generation, 4,
    'ordinary cycles must retain generation for no-progress accounting');
  assert.equal(a.requirement.cron_lock_run_id, a.run_id, 'claim returns updated row');
  assert.equal((await owner(id(1), a.run_id, 4)).reason, 'lease_inactive');
  assert.equal((await owner(id(1), a.run_id, 4, true)).current, true);
  assert.equal((await activate(id(1), a.run_id)).state, 'active');
  assert.equal((await owner(id(1), a.run_id, 4)).current, true);
  assert.equal((await owner(id(1), 'old-run', 4)).reason, 'run_owner_changed');
  assert.equal((await owner(id(1), a.run_id, 3)).reason, 'execution_generation_changed');
  assert.equal((await owner(id(1), null, 4)).reason, 'missing_execution_identity');
  assert.equal((await claim()).length, 0, 'live lease was stolen');

  await db.query(`UPDATE requirements SET cron_lock_expires_at=now()+interval '30 minutes' WHERE id=$1`, [id(1)]);
  let [b] = await claim();
  assert.notEqual(b.run_id, a.run_id);
  assert.equal(b.requirement.metadata.requirement_execution_generation, 5, 'reclaim did not fence old CAS');
  assert.equal(b.requirement.metadata.other_key, 'keep');
  assert.equal(b.requirement.backlog.items[0].status, 'in_progress', 'reclaim reset backlog WIP');
  assert.equal((await owner(id(1), a.run_id, 4)).current, false);
  assert.equal((await activate(id(1), a.run_id)).state, 'stale', 'old owner could reactivate');
  assert.equal((await activate(id(1), b.run_id)).state, 'active');
  // The actual existing CAS shape cannot write with the pre-reclaim generation.
  assert.equal((await db.query(`UPDATE requirements SET status='done' WHERE id=$1
    AND (metadata->>'requirement_execution_generation')::integer=$2 RETURNING id`,
  [id(1), 4])).rows.length, 0);
  await db.query(`UPDATE requirements SET cron_lock_expires_at=now()-interval '1 second', updated_at=now() WHERE id=$1`, [id(1)]);
  assert.equal((await owner(id(1), b.run_id, 5)).reason, 'lease_expired');
  [a] = await claim();
  assert.equal(a.requirement.metadata.requirement_execution_generation, 6, 'expired recent owner not fenced');
  assert.equal((await activate(id(1), a.run_id)).state, 'active');
  // Voluntary release and a clean new cycle do not discard accumulated budgets.
  await db.exec('UPDATE requirements SET cron_lock_run_id=NULL,cron_lock_expires_at=NULL,cron_lock_active=false');
  [a] = await claim();
  assert.equal(a.requirement.metadata.requirement_execution_generation, 6);

  await reset();
  await insert(2, 'backlog'); await insert(3, 'in-progress'); await insert(4, 'done');
  [a] = await claim(1);
  [b] = await claim(1, [a.requirement.id]);
  assert.equal(a.requirement.id, id(2)); assert.equal(b.requirement.id, id(3));
  assert.equal((await claim(1, [id(2), id(3)])).length, 0, 'nonrecurring terminal work claimed');
  const activations = await Promise.all([
    activate(id(2), a.run_id, 1), activate(id(3), b.run_id, 1),
  ]);
  assert.equal(activations.filter((r) => r.state === 'active').length, 1, 'global capacity exceeded');
  assert.equal(activations.filter((r) => r.state === 'capacity_full').length, 1);
  assert.equal((await claim(1))[0].state, 'capacity_full');

  await reset(); await insert(4, 'done', '* * * * *');
  assert.equal((await claim())[0].requirement.id, id(4), 'old recurring work excluded');

  await reset(); await insert(5); await insert(6);
  await db.query(`INSERT INTO remote_instances VALUES($1,'paused');
  `, [id(50)]);
  await db.query(`UPDATE requirements SET metadata=metadata||jsonb_build_object('runner_instance_id',$1::text)
    WHERE id=$2`, [id(50), id(5)]);
  await db.query(`INSERT INTO instance_plans VALUES($1,$2,'paused','{}',now(),now())`, [id(60), id(61)]);
  await db.query(`UPDATE requirements SET metadata=metadata||jsonb_build_object('runner_instance_id',$1::text)
    WHERE id=$2`, [id(61), id(6)]);
  assert.equal((await claim()).length, 0, 'paused instance/plan claimed');
  await db.query(`UPDATE requirements SET cron_lock_run_id='paused-owner',
    cron_lock_expires_at=now()+interval '2 hours',cron_lock_active=true WHERE id=$1`, [id(5)]);
  assert.equal((await owner(id(5), 'paused-owner', 4)).reason, 'execution_not_runnable');
  assert.equal((await owner(id(5), 'paused-owner', 4, false, true)).current, true,
    'owned cleanup must work after pausing');
  await claim();
  assert.equal((await owner(id(5), 'paused-owner', 4, false, true)).current, false,
    'cleanup bypassed reclaimed ownership');
  const row = (await db.query('SELECT metadata FROM requirements WHERE id=$1', [id(5)])).rows[0];
  assert.equal(row.metadata.requirement_execution_generation, 5);
  await claim();
  assert.deepEqual((await db.query('SELECT metadata FROM requirements WHERE id=$1', [id(5)])).rows[0], row,
    'already revoked owner repeatedly increments generation');

  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    for (const sql of [
      'SELECT public.claim_requirement_cron_candidates(8)',
      `SELECT public.assert_requirement_cron_execution_owner('${id(5)}','run',5)`,
    ]) {
      await assert.rejects(db.query(sql), (e) => e.code === '42501', `${role} can execute service RPC`);
    }
    await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE service_role');
  assert.equal((await owner(id(5), 'paused-owner', 4)).current, false);
  await claim();
  console.log('PASS real PostgreSQL scheduler/ownership: scope, capacity, reclaim fencing, CAS, WIP, permissions');
} finally {
  await db.close();
}