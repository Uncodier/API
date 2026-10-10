import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

// Real in-memory PostgreSQL. No .env, credentials, network or remote migrations.
// Promise.all below exercises queued simultaneous submissions, not independent
// PostgreSQL connections: multi-connection lock blocking is not proven by PGlite.
const db = new PGlite();
const migration = name => readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const replacementMigration = migration('20261010010000_replace_archived_requirement_runner.sql');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const replace = async (f, overrides = {}) => (await one(
  'select public.replace_archived_requirement_runner($1,$2,$3,$4) result',
  [f.req, overrides.run ?? f.run, overrides.instance ?? f.old, overrides.generation ?? 7],
)).result;
const inspect = async (f, instance = f.old) => (await one(
  'select public.inspect_requirement_assistant_handoff($1,$2) result', [f.req, instance],
)).result;
const activate = async f => (await one(
  'select public.activate_requirement_cron_run($1,$2,100,7200) result', [f.req, f.run],
)).result;
const owner = async (f, generation, inactive = false, terminal = false) => (await one(
  'select public.assert_requirement_cron_execution_owner($1,$2,$3,$4,$5) result',
  [f.req, f.run, generation, inactive, terminal],
)).result;
const requirement = async f => (await one('select to_jsonb(r) value from requirements r where id=$1', [f.req])).value;
const snapshot = async () => (await one(`select jsonb_build_object(
  'requirements',(select jsonb_agg(to_jsonb(r) order by id) from requirements r),
  'instances',(select jsonb_agg(to_jsonb(r) order by id) from remote_instances r),
  'plans',(select jsonb_agg(to_jsonb(r) order by id) from instance_plans r),
  'receipts',(select jsonb_agg(to_jsonb(r) order by requirement_id,run_id) from requirement_archived_runner_reassignments r)
) value`)).value;
const fresh = async (options = {}) => {
  const f = { req: randomUUID(), old: randomUUID(), site: randomUUID(), user: randomUUID(), run: `cron-${randomUUID()}` };
  const metadata = options.metadata ?? {
    runner_instance_id: f.old, assistant_origin_instance_id: f.old, requirement_execution_generation: 7,
    security_hold: { blocked: true, reason: 'needs independent review' },
    migration_review_hold: { version: 4, execution_generation: 7 },
    requirement_execution_budget: { spent: 37, limit: 40 },
    requirement_git: { branch: 'offline-test', head: 'unchanged' },
    repair_run: { infrastructure_generation: 7, attempt_count: 4 },
    archived_runner_reassignment: { instance_id: randomUUID(), run_id: 'untrusted-model-value' },
  };
  await db.query(`insert into remote_instances(id,name,instance_type,status,is_archived,site_id,user_id,created_by)
    values($1,$2,'browser',$3,$4,$5,$6,$6)`,
  [f.old, options.name ?? `assistant-${f.old}`, options.status ?? 'stopped', options.archived ?? true, f.site, f.user]);
  await db.query(`insert into requirements(id,site_id,user_id,status,created_at,updated_at,metadata,backlog,
    backlog_revision,cron_lock_run_id,cron_lock_expires_at,cron_lock_active)
    values($1,$2,$3,'backlog',now(),now(),$4,$5,13,$6,now()+interval '2 hours',false)`,
  [f.req, f.site, f.user, metadata, [{ id: randomUUID(), status: 'pending', acceptance: ['preserved'] }], f.run]);
  return f;
};
const plan = async (f, status, options = {}) => {
  const id = randomUUID();
  await db.query(`insert into instance_plans(id,instance_id,site_id,status,metadata,steps,instructions,
    retry_count,max_retries,success_criteria,validation_rules,artifacts,completed_at,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,'Keep original instructions',4,5,$7,$8,$9,$10,
      now()+($11::int*interval '1 second'),now())`, [id, options.instance ?? f.old, options.site ?? f.site, status,
    { requirement_id: options.requirement ?? f.req, acceptance_verification: { state: 'pending' },
      repair_run: { attempt: 4, generation: 7 }, security_hold: { reason: 'review' } },
    [{ id: randomUUID(), status: 'paused', retry_count: 3, acceptance_criteria: ['keep'],
      metadata: { repair_run: { attempt: 3 }, cron_execution_generation: 7 }, error: 'retain diagnostics' }],
    ['criterion'], ['rule'], [{ id: randomUUID() }], ['completed', 'failed', 'cancelled'].includes(status) ? new Date() : null,
    options.order ?? 0]);
  return id;
};
let checks = 0;
const guarded = async (label, setup, expectedReason, overrides = {}) => {
  const f = await fresh();
  await setup(f);
  const before = await snapshot();
  const result = await replace(f, overrides);
  assert.equal(result.state, 'guarded', label);
  assert.equal(result.reason, expectedReason, label);
  assert.deepEqual(await snapshot(), before, `${label}: no partial writes`);
  checks++;
  return f;
};

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
    CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid,user_id uuid,status text,cron text,
      created_at timestamptz,updated_at timestamptz,metadata jsonb,backlog jsonb,backlog_revision bigint,
      cron_lock_run_id text,cron_lock_expires_at timestamptz);
    CREATE TABLE remote_instances(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,
      instance_type text NOT NULL CHECK(instance_type IN ('browser','ubuntu','windows')),
      status text NOT NULL CHECK(status IN ('pending','starting','running','paused','stopping','stopped','error')),
      is_archived boolean DEFAULT false,site_id uuid NOT NULL,user_id uuid NOT NULL,created_by uuid NOT NULL,
      metadata jsonb DEFAULT '{}',configuration jsonb DEFAULT '{}',provider_instance_id text,cdp_url text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE instance_plans(id uuid PRIMARY KEY,instance_id uuid REFERENCES remote_instances(id),site_id uuid,
      status text CHECK(status IN ('pending','in_progress','active','paused','completed','failed','cancelled','blocked')),
      metadata jsonb,steps jsonb,instructions text,retry_count integer,max_retries integer,success_criteria jsonb,
      validation_rules jsonb,artifacts jsonb,completed_at timestamptz,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE requirement_status(id uuid DEFAULT gen_random_uuid(),requirement_id uuid,site_id uuid,
      instance_id uuid,stage text,message text,updated_at timestamptz DEFAULT now());
    CREATE TABLE instance_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid,instance_id uuid,
      log_type text,trusted_user_action boolean,details jsonb,created_at timestamptz DEFAULT now());
    CREATE TABLE requirement_migration_lifecycle(requirement_id uuid,file text,state text,version integer,evidence jsonb);
    CREATE TABLE requirement_cron_cycle_outcomes(requirement_id uuid,execution_generation integer,outcome text);
  `);
  for (const file of ['20260917204500_atomic_requirement_cron_capacity.sql',
    '20260926070000_harness_execution_ownership.sql', '20261001010000_requirement_assistant_handoff.sql',
    '20261001020000_fixed_september_requirement_cron_scope.sql']) await db.exec(migration(file));
  await db.exec(replacementMigration);
  await db.exec(replacementMigration);
  checks++;

  const f = await fresh();
  const transferable = [];
  for (const status of ['pending', 'in_progress', 'active', 'paused']) transferable.push(await plan(f, status, { order: status === 'paused' ? 10 : 0 }));
  for (const status of ['completed', 'failed', 'cancelled', 'blocked']) await plan(f, status);
  await plan(f, 'pending', { requirement: randomUUID() });
  await plan(f, 'pending', { site: randomUUID() });
  const token = randomBytes(20).toString('hex'); // synthetic history input only
  await db.query('update remote_instances set is_archived=false where id=$1', [f.old]);
  await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
    values($1,$2,'user_action',true,$3)`, [f.site, f.old, { status: 'paused', synthetic: token }]);
  await db.query('update remote_instances set is_archived=true where id=$1', [f.old]);
  await db.query(`insert into requirement_status(requirement_id,site_id,instance_id,stage,message)
    values($1,$2,$3,'paused','Original history')`, [f.req, f.site, f.old]);
  await db.query(`insert into requirement_migration_lifecycle values($1,'migrations/offline.sql','blocked',4,$2)`,
    [f.req, { security_hold: true, synthetic: token }]);
  await db.query(`insert into requirement_cron_cycle_outcomes values($1,7,'infrastructure_retry')`, [f.req]);
  const beforeReq = await requirement(f);
  const beforePlans = (await db.query('select to_jsonb(p) value from instance_plans p where instance_id=$1 order by id', [f.old])).rows.map(r => r.value);
  const oldBefore = (await one('select to_jsonb(r) value from remote_instances r where id=$1', [f.old])).value;
  const historyBefore = (await one(`select jsonb_build_object(
    'logs',(select jsonb_agg(to_jsonb(l)) from instance_logs l),
    'status',(select jsonb_agg(to_jsonb(s)) from requirement_status s),
    'holds',(select jsonb_agg(to_jsonb(h)) from requirement_migration_lifecycle h),
    'outcomes',(select jsonb_agg(to_jsonb(o)) from requirement_cron_cycle_outcomes o)) value`)).value;
  assert.equal((await inspect(f)).reason, 'original_instance_archived');
  await db.exec('set role service_role');
  const result = await replace(f);
  await db.exec('reset role');
  assert.equal(result.state, 'replaced');
  assert.notEqual(result.instance_id, f.old);
  assert.equal(result.execution_generation, 8);
  const expectedReq = structuredClone(beforeReq);
  expectedReq.metadata.runner_instance_id = result.instance_id;
  expectedReq.metadata.requirement_execution_generation = 8;
  assert.deepEqual(await requirement(f), expectedReq, 'only ownership/generation may change, full security/budgets/git/backlog/origin retained');
  assert.deepEqual(result.metadata, expectedReq.metadata);
  assert.deepEqual((await one('select to_jsonb(r) value from remote_instances r where id=$1', [f.old])).value, oldBefore);
  const newInstance = await one('select * from remote_instances where id=$1', [result.instance_id]);
  assert.equal(newInstance.name, `req-runner-${f.req}`);
  assert.equal(newInstance.instance_type, 'browser');
  assert.equal(newInstance.status, 'pending');
  assert.equal(newInstance.site_id, f.site);
  assert.equal(newInstance.user_id, f.user);
  assert.equal(newInstance.created_by, f.user);
  assert.equal(newInstance.is_archived, false);
  assert.equal(newInstance.provider_instance_id, null);
  const expectedPlans = beforePlans.map(p => ({ ...p, instance_id: transferable.includes(p.id) ? result.instance_id : f.old }));
  assert.deepEqual((await db.query('select to_jsonb(p) value from instance_plans p where id=any($1::uuid[]) order by id',
    [beforePlans.map(p => p.id)])).rows.map(r => r.value), expectedPlans, 'all steps, IDs, status, pause, retries, acceptance and repair metadata preserved');
  assert.deepEqual((await one(`select jsonb_build_object(
    'logs',(select jsonb_agg(to_jsonb(l)) from instance_logs l),
    'status',(select jsonb_agg(to_jsonb(s)) from requirement_status s),
    'holds',(select jsonb_agg(to_jsonb(h)) from requirement_migration_lifecycle h),
    'outcomes',(select jsonb_agg(to_jsonb(o)) from requirement_cron_cycle_outcomes o)) value`)).value, historyBefore);
  const receipt = await one('select * from requirement_archived_runner_reassignments where requirement_id=$1', [f.req]);
  assert.equal(receipt.previous_instance_id, f.old);
  assert.equal(receipt.instance_id, result.instance_id);
  assert.equal(receipt.previous_execution_generation, 7);
  assert.equal(receipt.execution_generation, 8);
  assert.equal(receipt.run_id, f.run);
  await assert.rejects(db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
    values($1,$2,'user_action',true,'{"status":"running"}')`, [f.site, f.old]),
  e => e.code === '55P03' && e.message === 'original_instance_archived', 'old archived ID cannot reopen interactive work');
  const snapshotAfter = await snapshot();
  const retries = await Promise.all(Array.from({ length: 6 }, () => replace(f)));
  assert(retries.every(r => r.state === 'duplicate' && r.instance_id === result.instance_id));
  assert.deepEqual(await snapshot(), snapshotAfter, 'simultaneous queued retries create nothing');
  assert.equal((await owner(f, 7, true, true)).reason, 'execution_generation_changed', 'old workers fenced even for cleanup');
  assert.equal((await inspect(f)).reason, 'runner_instance_owner_changed');
  assert.equal((await inspect(f, result.instance_id)).allowed, true, 'receipt permits new no-action handoff despite historical origin');
  assert.equal((await activate(f)).state, 'stale', 'latest transferred paused plan cannot activate');
  assert.equal((await owner(f, 8, true)).reason, 'execution_not_runnable');
  checks += 8;

  for (const status of ['pending', 'running', 'paused', 'stopped', 'error']) {
    await guarded(`nonarchived ${status}`, f => db.query('update remote_instances set is_archived=false,status=$2 where id=$1', [f.old, status]), 'original_instance_not_archived');
  }
  await guarded('archive must be explicitly true', f => db.query('update remote_instances set is_archived=null where id=$1', [f.old]), 'original_instance_not_archived');
  for (const status of ['running', 'in_progress', 'pending', null]) {
    await guarded(`archived unfinished action ${status}`, async f => {
      await db.query('update remote_instances set is_archived=false where id=$1', [f.old]);
      await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
        values($1,$2,'user_action',true,$3)`, [f.site, f.old, status === null ? {} : { status }]);
      await db.query('update remote_instances set is_archived=true where id=$1', [f.old]);
    }, 'original_assistant_action_not_finished');
  }
  for (const status of ['completed', 'failed', 'paused', 'stopped', 'cancelled']) {
    const stopped = await fresh();
    await db.query('update remote_instances set is_archived=false where id=$1', [stopped.old]);
    await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
      values($1,$2,'user_action',true,$3)`, [stopped.site, stopped.old, { status }]);
    await db.query('update remote_instances set is_archived=true where id=$1', [stopped.old]);
    assert.equal((await replace(stopped)).state, 'replaced', `explicitly archived quiescent ${status} allowed without resuming action`);
    checks++;
  }
  await guarded('paused but recovery tool still in flight', async f => {
    await db.query('update remote_instances set is_archived=false where id=$1', [f.old]);
    await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
      values($1,$2,'user_action',true,$3)`, [f.site, f.old, { status: 'paused', assistant_recovery: { inFlight: true } }]);
    await db.query('update remote_instances set is_archived=true where id=$1', [f.old]);
  }, 'original_assistant_action_not_finished');
  for (const status of ['completed', 'failed']) {
    const terminal = await fresh();
    await db.query('update remote_instances set is_archived=false where id=$1', [terminal.old]);
    await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
      values($1,$2,'user_action',true,$3)`, [terminal.site, terminal.old,
      { status, assistant_recovery: { inFlight: true, respawnCount: 0 } }]);
    await db.query('update remote_instances set is_archived=true where id=$1', [terminal.old]);
    assert.equal((await inspect(terminal)).reason, 'original_instance_archived');
    assert.equal((await replace(terminal)).state, 'replaced',
      `${status} is an authoritative terminal result even when the old turn checkpoint was not cleared`);
    checks++;
  }
  const preparing = await fresh();
  await db.query('update remote_instances set is_archived=false where id=$1', [preparing.old]);
  await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
    values($1,$2,'user_action',true,'{"status":"running"}')`, [preparing.site, preparing.old]);
  await db.query('update remote_instances set is_archived=true where id=$1', [preparing.old]);
  assert.equal((await inspect(preparing)).reason, 'original_assistant_action_not_finished',
    'preparation must not mutate backlog or resume budgets while the archived assistant is still executing');
  checks++;
  const active = await guarded('unexpired active executor', f => db.query('update requirements set cron_lock_active=true where id=$1', [f.req]), 'execution_active');
  await db.query('update requirements set cron_lock_active=false where id=$1', [active.req]);
  await assert.rejects(db.query('update requirements set cron_lock_active=null where id=$1', [active.req]),
    e => e.code === '23502', 'production schema rejects unknown active state');
  await guarded('expired lease', f => db.query("update requirements set cron_lock_expires_at=now()-interval '1 second' where id=$1", [f.req]), 'lease_expired');
  await guarded('missing lease', f => db.query('update requirements set cron_lock_expires_at=null where id=$1', [f.req]), 'lease_expired');
  await guarded('wrong claim', async () => {}, 'run_owner_changed', { run: `cron-${randomUUID()}` });
  await guarded('stale generation', async () => {}, 'execution_generation_changed', { generation: 6 });
  await guarded('malformed generation', f => db.query("update requirements set metadata=jsonb_set(metadata,'{requirement_execution_generation}','\"invalid\"') where id=$1", [f.req]), 'invalid_execution_generation');
  await guarded('generation overflow', f => db.query("update requirements set metadata=jsonb_set(metadata,'{requirement_execution_generation}','2147483648') where id=$1", [f.req]), 'invalid_execution_generation');
  await guarded('null generation', f => db.query("update requirements set metadata=jsonb_set(metadata,'{requirement_execution_generation}','null') where id=$1", [f.req]), 'invalid_execution_generation');
  await guarded('site mismatch', f => db.query('update remote_instances set site_id=$2 where id=$1', [f.old, randomUUID()]), 'assistant_origin_unavailable');
  await guarded('site mismatch without origin', async f => {
    await db.query("update requirements set metadata=metadata-'assistant_origin_instance_id' where id=$1", [f.req]);
    await db.query('update remote_instances set site_id=$2 where id=$1', [f.old, randomUUID()]);
  }, 'instance_site_mismatch');
  await guarded('cross-site historical origin', async f => {
    const origin = await fresh();
    await db.query("update requirements set metadata=jsonb_set(metadata,'{assistant_origin_instance_id}',to_jsonb($2::text)) where id=$1", [f.req, origin.old]);
  }, 'assistant_origin_unavailable');
  await guarded('owner mismatch', f => db.query("update requirements set metadata=jsonb_set(metadata,'{runner_instance_id}',to_jsonb($2::text)) where id=$1", [f.req, randomUUID()]), 'runner_instance_owner_changed');
  await guarded('missing archived owner', f => db.query('delete from remote_instances where id=$1', [f.old]), 'assistant_origin_unavailable');
  await guarded('missing archived owner without origin', async f => {
    await db.query("update requirements set metadata=metadata-'assistant_origin_instance_id' where id=$1", [f.req]);
    await db.query('delete from remote_instances where id=$1', [f.old]);
  }, 'original_instance_unavailable');
  for (const status of ['blocked', 'paused', 'on-review', 'done', 'cancelled']) {
    await guarded(`requirement ${status}`, f => db.query('update requirements set status=$2 where id=$1', [f.req, status]), 'execution_not_runnable');
  }
  await guarded('scalar metadata', f => db.query("update requirements set metadata='[]' where id=$1", [f.req]), 'invalid_requirement_metadata');
  await guarded('missing user', f => db.query('update requirements set user_id=null where id=$1', [f.req]), 'requirement_identity_missing');
  await guarded('live canonical competitor', async f => {
    await db.query(`insert into remote_instances(name,instance_type,status,is_archived,site_id,user_id,created_by)
      values($1,'browser','pending',false,$2,$3,$3)`, [`req-runner-${f.req}`, f.site, f.user]);
  }, 'canonical_runner_exists');
  for (const status of ['pending', 'in_progress', 'active', 'paused']) {
    await guarded(`competing live plan ${status}`, async f => {
      const otherInstance = (await one(`insert into remote_instances(name,instance_type,status,is_archived,site_id,user_id,created_by)
        values('competing','browser','running',false,$1,$2,$2) returning id`, [f.site, f.user])).id;
      await plan(f, status, { instance: otherInstance });
    }, 'competing_instance_active');
  }
  const failure = await fresh();
  // A validated insert followed by a transfer-time constraint failure must roll
  // back creation, requirement ownership and every previously moved plan.
  await plan(failure, 'pending');
  await db.query(`alter table instance_plans add constraint offline_fail_transfer check(instance_id='${failure.old}') not valid`);
  const failureBefore = await snapshot();
  await assert.rejects(replace(failure), e => e.code === '23514');
  assert.deepEqual(await snapshot(), failureBefore, 'transfer constraint error rolls back entire replacement');
  await db.exec('alter table instance_plans drop constraint offline_fail_transfer');
  checks++;
  const shared = await fresh();
  const other = await fresh();
  await db.query("update requirements set metadata=jsonb_set(metadata,'{runner_instance_id}',to_jsonb($2::text)),cron_lock_active=true where id=$1", [other.req, shared.old]);
  const sharedBefore = await snapshot();
  assert.equal((await replace(shared)).reason, 'original_instance_execution_active');
  assert.deepEqual(await snapshot(), sharedBefore);
  await db.query('update requirements set cron_lock_active=false where id=$1', [other.req]);
  assert.equal((await replace(shared)).state, 'replaced');
  checks++;

  const race = await fresh();
  const raceResults = await Promise.all([replace(race), replace(race), replace(race)]);
  assert.deepEqual(raceResults.map(r => r.state), ['replaced', 'duplicate', 'duplicate']);
  assert.equal(new Set(raceResults.map(r => r.instance_id)).size, 1);
  assert.equal((await activate(race)).state, 'active');
  assert.equal((await replace(race)).reason, 'execution_active', 'retry after activation cannot mutate active executor');
  assert.equal((await owner(race, 7)).reason, 'execution_generation_changed');
  assert.equal((await owner(race, 8)).current, true);
  await db.query('update requirements set cron_lock_active=false where id=$1', [race.req]);
  await db.query("update requirements set metadata=jsonb_set(metadata,'{requirement_execution_generation}','9') where id=$1", [race.req]);
  assert.equal((await inspect(race, raceResults[0].instance_id)).allowed, true, 'later lease fencing does not invalidate authentic owner receipt');
  await db.query("update requirements set metadata=jsonb_set(metadata,'{requirement_execution_generation}','7') where id=$1", [race.req]);
  assert.equal((await inspect(race, raceResults[0].instance_id)).reason, 'assistant_handoff_not_confirmed', 'generation below receipt cannot authenticate it');
  await db.query("update requirements set metadata=jsonb_set(metadata,'{requirement_execution_generation}','9') where id=$1", [race.req]);
  const untrusted = randomUUID();
  await db.query(`insert into remote_instances(id,name,instance_type,status,is_archived,site_id,user_id,created_by)
    values($1,'untrusted','browser','pending',false,$2,$3,$3)`, [untrusted, race.site, race.user]);
  const authentic = await requirement(race);
  const spoofed = { ...authentic.metadata, runner_instance_id: untrusted,
    archived_runner_reassignment: { previous_instance_id: race.old, instance_id: untrusted, run_id: race.run, generation: 9 } };
  await db.query('update requirements set metadata=$2 where id=$1', [race.req, spoofed]);
  assert.equal((await inspect(race, untrusted)).reason, 'assistant_handoff_not_confirmed', 'model metadata cannot author host evidence');
  await db.query('update requirements set metadata=$2 where id=$1', [race.req, authentic.metadata]);
  await db.query("update remote_instances set status='paused' where id=$1", [raceResults[0].instance_id]);
  assert.equal((await inspect(race, raceResults[0].instance_id)).reason, 'original_instance_paused');
  await db.query("update remote_instances set status='pending' where id=$1", [raceResults[0].instance_id]);
  await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
    values($1,$2,'user_action',true,'{"status":"running"}')`, [race.site, raceResults[0].instance_id]);
  assert.equal((await inspect(race, raceResults[0].instance_id)).reason, 'assistant_action_not_finished');
  assert.equal((await activate(race)).state, 'stale', 'receipt cannot bypass fresh interactive work');
  checks += 4;

  const stoppedOrigin = await fresh();
  const newOwnerWithOrigin = await replace(stoppedOrigin);
  const authenticOriginReq = await requirement(stoppedOrigin);
  assert.equal(authenticOriginReq.metadata.assistant_origin_instance_id, stoppedOrigin.old);
  // Replace again on a later claim while preserving the first assistant origin.
  await db.query('update remote_instances set is_archived=true where id=$1', [newOwnerWithOrigin.instance_id]);
  stoppedOrigin.run = `cron-${randomUUID()}`;
  await db.query('update requirements set cron_lock_run_id=$2 where id=$1', [stoppedOrigin.req, stoppedOrigin.run]);
  const secondReplacement = await replace(stoppedOrigin, { instance: newOwnerWithOrigin.instance_id, generation: 8 });
  assert.equal(secondReplacement.state, 'replaced');
  assert.equal(secondReplacement.metadata.assistant_origin_instance_id, stoppedOrigin.old);
  assert.equal((await inspect(stoppedOrigin, secondReplacement.instance_id)).allowed, true);
  checks++;

  // Null metadata legacy owner requires reproduced trusted discovery.
  const legacy = await fresh();
  await db.query('update requirements set metadata=null where id=$1', [legacy.req]);
  await plan(legacy, 'pending');
  const legacyResult = await replace(legacy, { generation: 0 });
  assert.equal(legacyResult.state, 'replaced');
  assert.equal(legacyResult.execution_generation, 1);
  assert.equal(legacyResult.metadata.assistant_origin_instance_id, undefined);
  assert.equal((await activate(legacy)).state, 'active');
  await assert.rejects(db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
    values($1,$2,'user_action',true,'{"status":"running"}')`, [legacy.site, legacyResult.instance_id]),
  e => e.code === '55P03' && e.message === 'requirement_execution_busy',
  'a replacement without assistant origin must not admit a second executor during cron');
  assert.equal((await owner(legacy, 1)).current, true, 'rejected chat must not interrupt the healthy replacement');
  await db.query('update requirements set cron_lock_active=false where id=$1', [legacy.req]);
  await db.query(`insert into instance_logs(site_id,instance_id,log_type,trusted_user_action,details)
    values($1,$2,'user_action',true,'{"status":"running"}')`, [legacy.site, legacyResult.instance_id]);
  assert.equal((await activate(legacy)).state, 'stale', 'chat wins before cron activation even without an origin');
  checks++;
  const unknown = await fresh();
  await db.query('update requirements set metadata=null where id=$1', [unknown.req]);
  assert.equal((await replace(unknown, { generation: 0 })).reason, 'runner_instance_owner_changed');
  const earliest = await fresh();
  const late = await fresh();
  await db.query('update requirements set metadata=null where id=$1', [earliest.req]);
  await db.query('update remote_instances set site_id=$2 where id=$1', [late.old, earliest.site]);
  await plan(earliest, 'completed', { order: -10 });
  await plan(earliest, 'pending', { instance: late.old, order: 10 });
  assert.equal((await replace(earliest, { instance: late.old, generation: 0 })).reason, 'runner_instance_owner_changed');
  assert.equal((await replace(earliest, { generation: 0 })).state, 'replaced');
  const canonical = await fresh();
  await db.query('update requirements set metadata=null where id=$1', [canonical.req]);
  await db.query('update remote_instances set name=$2 where id=$1', [canonical.old, `req-runner-${canonical.req}`]);
  assert.equal((await replace(canonical, { generation: 0 })).state, 'replaced');
  checks += 4;

  // Older resumable plans have no plan-level requirement_id. Match every
  // backlog reference, not merely one coincidentally shared item name.
  const legacyPlan = async (scope, status = 'in_progress', metadata = {}) => {
    const item = randomUUID();
    await db.query('update requirements set backlog=$2 where id=$1', [scope.req,
      { items: [{ id: item, status: 'in_progress', acceptance: ['keep existing contract'] }] }]);
    const id = await plan(scope, status);
    await db.query('update instance_plans set metadata=$2,steps=$3 where id=$1', [id, metadata, [
      { id: 'first', status: 'completed', backlog_item_id: item, result: { evidence: 'saved' } },
      { id: 'second', status: 'pending', retry_count: 3, metadata: { backlog_item_id: item, repair_run: { attempt: 2 } } },
    ]]);
    return { id, item };
  };
  for (const metadata of [null, {}, { note: 'preserve me' }]) {
    const scoped = await fresh();
    const saved = await legacyPlan(scoped, 'in_progress', metadata);
    const before = (await one('select to_jsonb(p) value from instance_plans p where id=$1', [saved.id])).value;
    const result = await replace(scoped);
    assert.equal(result.state, 'replaced');
    assert.deepEqual((await one('select to_jsonb(p) value from instance_plans p where id=$1', [saved.id])).value,
      { ...before, instance_id: result.instance_id }, 'legacy plan moves intact, including completed work and retry budgets');
    checks++;
  }
  for (const kind of ['mixed', 'foreign', 'unlinked', 'malformed', 'shared-owner', 'conflicting-links', 'numeric-link', 'other-plan']) {
    await guarded(`legacy ${kind} association`, async scope => {
      const saved = await legacyPlan(scope);
      if (kind === 'shared-owner') {
        const other = await fresh();
        await db.query("update requirements set site_id=$2,metadata=jsonb_set(metadata,'{runner_instance_id}',to_jsonb($3::text)) where id=$1",
          [other.req, scope.site, scope.old]);
      } else if (kind === 'other-plan') {
        await plan(scope, 'pending', { requirement: randomUUID() });
      } else {
        const steps = kind === 'mixed' ? [{ backlog_item_id: saved.item }, { metadata: { backlog_item_id: randomUUID() } }]
          : kind === 'foreign' ? [{ backlog_item_id: randomUUID() }]
          : kind === 'unlinked' ? [{ id: 'unlinked', status: 'pending' }]
          : kind === 'conflicting-links' ? [{ backlog_item_id: randomUUID(), metadata: { backlog_item_id: saved.item } }]
          : kind === 'numeric-link' ? [{ backlog_item_id: saved.item }, { backlog_item_id: 123 }]
          : { not: 'an array' };
        await db.query('update instance_plans set steps=$2 where id=$1', [saved.id, steps]);
      }
    }, 'legacy_plan_scope_ambiguous');
  }
  const pausedLegacy = await fresh();
  const pausedPlan = await legacyPlan(pausedLegacy, 'paused');
  const pausedReplacement = await replace(pausedLegacy);
  assert.equal(pausedReplacement.state, 'replaced');
  assert.equal((await one('select status from instance_plans where id=$1', [pausedPlan.id])).status, 'paused');
  assert.equal((await activate(pausedLegacy)).state, 'stale', 'transferring a legacy plan is not permission to unpause it');
  checks++;
  const managed = await fresh();
  const explicit = await plan(managed, 'pending');
  const managedIds = [];
  for (const key of ['workflow_run', 'workflow_template']) {
    for (const requirement of [undefined, managed.req]) {
      const id = await plan(managed, 'pending');
      await db.query('update instance_plans set metadata=$2 where id=$1', [id,
        { [key]: true, ...(requirement ? { requirement_id: requirement } : {}) }]);
      managedIds.push(id);
    }
  }
  const managedResult = await replace(managed);
  assert.equal(managedResult.state, 'replaced');
  assert.equal((await one('select instance_id from instance_plans where id=$1', [explicit])).instance_id, managedResult.instance_id);
  for (const id of managedIds) assert.equal((await one('select instance_id from instance_plans where id=$1', [id])).instance_id, managed.old,
    'independent workflow plans are not requirement runner plans');
  checks++;

  // ACL, RLS and append-only authority, including privileged attempted mutation.
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(replace(f), e => e.code === '42501');
    await assert.rejects(inspect(f, result.instance_id), e => e.code === '42501');
    await assert.rejects(db.query('select * from requirement_archived_runner_reassignments'), e => e.code === '42501');
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  assert.equal((await one('select count(*)::int n from requirement_archived_runner_reassignments')).n > 0, true);
  for (const sql of [
    'insert into requirement_archived_runner_reassignments select * from requirement_archived_runner_reassignments',
    'update requirement_archived_runner_reassignments set run_id=run_id',
    'delete from requirement_archived_runner_reassignments',
    'truncate requirement_archived_runner_reassignments',
  ]) await assert.rejects(db.exec(sql), e => e.code === '42501');
  await db.exec('reset role');
  for (const sql of ['update requirement_archived_runner_reassignments set run_id=run_id',
    'delete from requirement_archived_runner_reassignments', 'truncate requirement_archived_runner_reassignments']) {
    await assert.rejects(db.exec(sql), e => e.code === '23514');
  }
  assert.equal((await one("select relrowsecurity from pg_class where oid='public.requirement_archived_runner_reassignments'::regclass")).relrowsecurity, true);
  checks++;

  // Preserve existing real SQL binding guards during atomic replacement.
  const bindingSql = migration('20261003180000_robot_instance_requirement_deletion.sql');
  const start = bindingSql.indexOf('CREATE FUNCTION public.guard_requirement_instance_binding()');
  const end = bindingSql.indexOf('CREATE FUNCTION public.guard_requirement_status_instance_binding()');
  await db.exec(bindingSql.slice(start, end));
  const bound = await fresh();
  await plan(bound, 'in_progress');
  assert.equal((await replace(bound)).state, 'replaced');
  checks++;
  const boundLegacy = await fresh();
  const boundLegacyPlan = await legacyPlan(boundLegacy);
  const boundLegacyResult = await replace(boundLegacy);
  assert.equal(boundLegacyResult.state, 'replaced');
  assert.equal((await one('select instance_id from instance_plans where id=$1', [boundLegacyPlan.id])).instance_id,
    boundLegacyResult.instance_id, 'legacy transfer also respects the installed database binding triggers');
  checks++;

  // Claim selection respects archived+paused distinction without evicting active
  // unexpired archival leases, and continues to respect transferred plan pauses.
  await db.exec("update requirements set cron_lock_run_id=null,cron_lock_expires_at=null,cron_lock_active=false,status='done',cron=null");
  const claimArchived = await fresh({ status: 'paused' });
  await db.query('update requirements set cron_lock_run_id=null,cron_lock_expires_at=null where id=$1', [claimArchived.req]);
  let claims = (await db.query('select * from public.claim_requirement_cron_candidates(100,7200)')).rows;
  assert.equal(claims[0].claim_requirement_cron_candidates.requirement.id, claimArchived.req);
  const claimedReq = await requirement(claimArchived);
  claimArchived.run = claimedReq.cron_lock_run_id;
  assert.equal((await replace(claimArchived)).state, 'replaced');
  const healthyActive = await fresh({ status: 'paused' });
  await db.query('update requirements set cron_lock_active=true where id=$1', [healthyActive.req]);
  await db.query('update requirements set status=$2 where id=$1', [claimArchived.req, 'done']);
  await db.query('update requirements set status=$2 where id=$1', [healthyActive.req, 'backlog']);
  const healthyBefore = await requirement(healthyActive);
  claims = (await db.query('select * from public.claim_requirement_cron_candidates(100,7200)')).rows;
  assert.equal(claims.length, 0);
  assert.deepEqual(await requirement(healthyActive), healthyBefore, 'archive alone never reclaims healthy active unexpired lease');
  await db.query('update requirements set status=$2,cron_lock_active=false where id=$1', [healthyActive.req, 'done']);
  const claimPaused = await fresh({ status: 'paused' });
  await plan(claimPaused, 'paused');
  await db.query('update requirements set cron_lock_run_id=null,cron_lock_expires_at=null where id=$1', [claimPaused.req]);
  assert.equal((await db.query('select * from public.claim_requirement_cron_candidates(100,7200)')).rows.length, 0);
  await db.query('update requirements set status=$2 where id=$1', [claimPaused.req, 'done']);
  const claimLivePaused = await fresh({ status: 'paused', archived: false });
  await db.query('update requirements set cron_lock_run_id=null,cron_lock_expires_at=null where id=$1', [claimLivePaused.req]);
  assert.equal((await db.query('select * from public.claim_requirement_cron_candidates(100,7200)')).rows.length, 0);
  checks += 3;

  await db.exec("update requirements set cron_lock_run_id=null,cron_lock_expires_at=null,cron_lock_active=false,status='done',cron=null");
  const reclaim = await fresh();
  const reclaimResult = await replace(reclaim);
  await db.query("update requirements set cron_lock_expires_at=now()-interval '1 second' where id=$1", [reclaim.req]);
  claims = (await db.query('select * from public.claim_requirement_cron_candidates(100,7200)')).rows;
  assert.equal(claims[0].claim_requirement_cron_candidates.requirement.id, reclaim.req);
  assert.equal(claims[0].claim_requirement_cron_candidates.requirement.metadata.requirement_execution_generation, 9);
  assert.equal((await inspect(reclaim, reclaimResult.instance_id)).allowed, true, 'real expired lease reclaim retains receipt authentication');
  assert.equal((await owner(reclaim, 8, true)).reason, 'run_owner_changed', 'expired old claim fenced');
  reclaim.run = claims[0].claim_requirement_cron_candidates.run_id;
  assert.equal((await activate(reclaim)).state, 'active');
  assert.equal((await owner(reclaim, 9)).current, true);
  checks++;

  const beforeReapply = await snapshot();
  await db.exec(replacementMigration);
  assert.deepEqual(await snapshot(), beforeReapply, 'migration replay after replacement retains all rows/receipts');
  const receiptCount = (await one('select count(*)::int n from requirement_archived_runner_reassignments')).n;
  await db.query('delete from requirements where id=$1', [bound.req]);
  assert.equal((await one('select count(*)::int n from requirement_archived_runner_reassignments')).n, receiptCount - 1,
    'only real requirement-root cascade can remove receipt');
  checks += 2;
  console.log(`PASS PostgreSQL archived runner replacement: ${checks} guard/preservation/receipt/permission/idempotency checks`);
} finally {
  await db.close();
}