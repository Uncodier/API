// Standalone offline PostgreSQL checks; no app imports, .env, providers or server.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const site = randomUUID(), foreignSite = randomUUID(), req = randomUUID();
const instance = randomUUID(), otherInstance = randomUUID(), evidence = randomUUID();
const plan = randomUUID(), template = randomUUID(), diagnosticToken = randomUUID();
const stamp = '2026-10-05T10:00:00.123456Z';
const signature = 'public.record_harness_diagnostic_decision(uuid,uuid,uuid,bigint,timestamptz,uuid,text,text,text,jsonb)';
const migration = readFileSync('supabase/migrations/20261005020000_harness_support_circuit_breaker.sql', 'utf8');
const originalMigration = readFileSync('supabase/migrations/20261001220000_harness_diagnostic_decisions.sql', 'utf8');
const conflictMigration = readFileSync('supabase/migrations/20261003020000_harness_decision_conflict_http_status.sql', 'utf8');
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const asRole = async (role, fn) => {
  await db.exec('SET ROLE ' + role);
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
};
const baseSupport = {
  evidence_log_ids: [evidence], verification: 'Inspect durable receipts',
  impact: 'Bounded work is blocked', requested_action: 'Inspect exhausted host recovery',
  attempted_alternatives: ['Bounded recovery completed without reopening work'],
};
const proof = () => ({
  version: 1, execution_generation: 9, backlog_revision: 7, requirement_updated_at: stamp,
  no_runnable_work: true, no_pending_recovery: true,
  exhaustion: [{ kind: 'repair_attempts', target_id: 'item-1', used: 3, limit: 3, receipt_ids: ['repair-receipt'] }],
  blocked_item_ids: ['item-1'],
  plan_versions: [{ id: template, updated_at: stamp }, { id: plan, updated_at: stamp }],
  migration_versions: [{ file: 'migrations/0001.sql', version: 4, state: 'correction_required', updated_at: stamp }],
  diagnostic_versions: [{ file: 'migrations/0001.sql', token: diagnosticToken, state: 'exhausted', updated_at: stamp }],
});
const payload = cb => ({ ...baseSupport, circuit_breaker: cb ?? proof() });
const call = async (overrides = {}) => {
  const a = { site, req, instance, revision: 7, updated: stamp, request: randomUUID(),
    decision: 'escalate_support', item: null, reason: 'Host policy found exhausted bounded recovery',
    payload: payload(), ...overrides };
  return (await rows('SELECT public.record_harness_diagnostic_decision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS receipt',
    [a.site, a.req, a.instance, a.revision, a.updated, a.request, a.decision, a.item, a.reason, a.payload]))[0].receipt;
};
const rpc = overrides => asRole('service_role', () => call(overrides));
const protectedState = async () => {
  const state = {};
  for (const table of ['requirements', 'remote_instances', 'instance_plans', 'instance_logs',
    'requirement_migration_lifecycle', 'requirement_migration_diagnostics', 'notifications']) {
    state[table] = await rows(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`);
  }
  return state;
};
const receipts = () => rows('SELECT to_jsonb(t) AS value FROM requirement_harness_decisions t ORDER BY id');
const rejected = async (fn, code, message) => assert.rejects(fn, error => {
  assert.equal(error.code, code, error.message);
  if (message) assert.match(error.message, new RegExp(message));
  return true;
});
const unchangedFailure = async (overrides, code = '22023', message) => {
  const before = await protectedState(), decisions = await receipts();
  await rejected(() => rpc(overrides), code, message);
  assert.deepEqual(await protectedState(), before);
  assert.deepEqual(await receipts(), decisions);
};
const definition = async () => (await rows(
  'SELECT oid,prosrc,pg_get_functiondef(oid) AS definition,proowner,proacl::text,prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)',
  [signature]))[0];
const reset = async () => {
  await db.exec('TRUNCATE requirements,remote_instances,instance_logs,instance_plans,requirement_migration_lifecycle,requirement_migration_diagnostics,requirement_harness_decisions,notifications CASCADE');
  await db.query('INSERT INTO remote_instances VALUES ($1,$2,$3,false),($4,$2,$3,false)', [instance, site, 'running', otherInstance]);
  await db.query('INSERT INTO requirements(id,site_id,status,metadata,backlog,backlog_revision,updated_at,instructions) VALUES ($1,$2,$3,$4,$5,7,$6,$7)', [
    req, site, 'blocked', { runner_instance_id: instance, requirement_execution_generation: 9,
      execution_hold: { kind: 'migration_platform_review', attempts: 5 }, no_progress_cycles: 4 },
    { items: [{ id: 'item-1', status: 'in_progress', acceptance: ['Preserve scoped CRUD'], attempts: 3,
      tool_failures: { judge: 3 }, custom: { preserve: true } }], cycles_spent_total: 8 }, stamp, 'Original specification',
  ]);
  await db.query('INSERT INTO instance_logs(id,site_id,instance_id,details,tool_args) VALUES ($1,$2,$3,$4,$5)',
    [evidence, site, instance, { requirement_id: req }, {}]);
  for (const [id, owner, type] of [[plan, instance, 'execution'], [template, otherInstance, 'workflow_template']]) {
    await db.query('INSERT INTO instance_plans(id,site_id,instance_id,status,metadata,steps,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, site, owner, 'blocked', { requirement_id: req, workflow_template: type === 'workflow_template' }, [{ id: 'step', status: 'failed', backlog_item_id: 'item-1' }], stamp]);
  }
  await db.query('INSERT INTO requirement_migration_lifecycle VALUES ($1,$2,4,$3,5,$4,$5)',
    [req, 'migrations/0001.sql', 'correction_required', { denied: true }, stamp]);
  await db.query('INSERT INTO requirement_migration_diagnostics VALUES ($1,$2,$3,9,$4,$5,$6)',
    [req, 'migrations/0001.sql', diagnosticToken, 'exhausted', { result: 'No bounded recovery remains' }, stamp]);
  await db.query('INSERT INTO notifications VALUES ($1,$2)', [randomUUID(), { preserve: true }]);
};
const passed = [];
const check = async (name, fn) => { await reset(); await fn(); passed.push(name); };

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE public_only;
    CREATE ROLE service_role NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,public_only,service_role;
    CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,status text NOT NULL,
      instructions text,metadata jsonb,backlog jsonb,backlog_revision bigint NOT NULL,updated_at timestamptz NOT NULL,
      cron_lock_active boolean DEFAULT false,cron_lock_expires_at timestamptz);
    CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid NOT NULL,status text NOT NULL,is_archived boolean NOT NULL);
    CREATE TABLE instance_logs(id uuid PRIMARY KEY,site_id uuid NOT NULL,instance_id uuid NOT NULL,
      details jsonb,tool_args jsonb,log_type text DEFAULT 'tool_result',trusted_user_action boolean DEFAULT false,created_at timestamptz DEFAULT now());
    CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid NOT NULL,instance_id uuid NOT NULL,status text,
      metadata jsonb,steps jsonb,updated_at timestamptz NOT NULL,instructions text DEFAULT 'Original plan',retry_count integer DEFAULT 4);
    CREATE TABLE requirement_migration_lifecycle(requirement_id uuid REFERENCES requirements(id),file text,version integer NOT NULL,
      state text NOT NULL,attempts integer,review jsonb,updated_at timestamptz NOT NULL,PRIMARY KEY(requirement_id,file));
    CREATE TABLE requirement_migration_diagnostics(requirement_id uuid,file text,token uuid NOT NULL,execution_generation integer,
      state text NOT NULL,result jsonb,updated_at timestamptz NOT NULL,PRIMARY KEY(requirement_id,file),
      FOREIGN KEY(requirement_id,file) REFERENCES requirement_migration_lifecycle(requirement_id,file));
    CREATE TABLE notifications(id uuid PRIMARY KEY,payload jsonb);
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role;
  `);
  await db.exec(originalMigration);
  await db.exec(conflictMigration);

  await check('migration preserves legacy receipts and exact replay, identity and ACLs', async () => {
    const request = randomUUID();
    const legacy = await rpc({ request, payload: baseSupport });
    const before = await protectedState(), decisions = await receipts(), old = await definition();
    await db.exec(migration);
    const patched = await definition();
    assert.notEqual(patched.prosrc, old.prosrc);
    for (const field of ['oid', 'proowner', 'proacl', 'prosecdef', 'proconfig']) assert.deepEqual(patched[field], old[field]);
    assert.deepEqual(await protectedState(), before);
    assert.deepEqual(await receipts(), decisions);
    await db.exec("UPDATE requirements SET status='completed',backlog_revision=8,updated_at=updated_at+interval '1 second'");
    assert.deepEqual(await rpc({ request, payload: baseSupport }), legacy);
    await unchangedFailure({ request, payload: payload() }, '23505', 'harness_decision_request_conflict');
    await db.exec(migration);
    assert.deepEqual(await definition(), patched);
    assert.deepEqual(await receipts(), decisions);
  });

  await check('valid proof records only support receipt and exact replay survives later state', async () => {
    const request = randomUUID(), before = await protectedState();
    const receipt = await rpc({ request });
    assert.equal(receipt.decision.status, 'recorded');
    assert.equal(receipt.decision.email_state, 'pending');
    assert.deepEqual(receipt.decision.payload.circuit_breaker, proof());
    assert.deepEqual(receipt.effects, { backlog_changed: false, backlog_revision: 7, plans_updated: 0, plan_steps_updated: 0, execution_started: false });
    assert.deepEqual(await protectedState(), before);
    await unchangedFailure({}, '23505', 'harness_support_ticket_exists');
    await db.exec("UPDATE requirements SET status='completed',backlog_revision=99,updated_at=updated_at+interval '1 second'; UPDATE instance_plans SET updated_at=updated_at+interval '1 second'; UPDATE requirement_migration_diagnostics SET state='running'");
    assert.deepEqual(await rpc({ request }), receipt);
    assert.equal((await receipts()).length, 1);
  });

  await check('new legacy escalation and malformed proofs are rejected without mutation', async () => {
    await unchangedFailure({ payload: baseSupport });
    for (const cb of [null, true, [], 'Prose is not authority', {}, { ...proof(), unexpected: true }]) {
      await unchangedFailure({ payload: { ...baseSupport, circuit_breaker: cb } });
    }
    for (const key of Object.keys(proof())) {
      const cb = proof(); delete cb[key];
      await unchangedFailure({ payload: payload(cb) });
    }
    for (const [key, values] of Object.entries({
      version: [0, 2, '1', null], execution_generation: [-1, 1.2, '9', null, 2147483648],
      backlog_revision: [-1, 1.2, '7', null, 1e30], requirement_updated_at: [null, 1, 'invalid', 'infinity'],
      no_runnable_work: [false, 'true', null], no_pending_recovery: [false, 'true', null],
      exhaustion: [null, {}, [], Array(101).fill(proof().exhaustion[0])],
      blocked_item_ids: [null, {}, [null], [' '], ['x'.repeat(513)], Array(201).fill('item')],
      plan_versions: [null, {}, Array(51).fill(proof().plan_versions[0])],
      migration_versions: [null, {}, Array(101).fill(proof().migration_versions[0])],
      diagnostic_versions: [null, {}, Array(101).fill(proof().diagnostic_versions[0])],
    })) {
      for (const value of values) await unchangedFailure({ payload: payload({ ...proof(), [key]: value }) });
    }
    for (const [key, values] of Object.entries({
      kind: ['operator_prose', null, 1], target_id: [null, '', ' ', 'x'.repeat(513)],
      used: [-1, 2, 1.2, '3', null, 2147483648], limit: [0, -1, 4, 1.5, '3', null, 2147483648],
      receipt_ids: [null, {}, [null], [' '], ['x'.repeat(513)], Array(101).fill('receipt')],
    })) {
      for (const value of values) {
        const cb = proof(); cb.exhaustion[0][key] = value;
        await unchangedFailure({ payload: payload(cb) });
      }
    }
    for (const entry of [null, 'exhausted', {}, { ...proof().exhaustion[0], prose: 'trust me' }]) {
      await unchangedFailure({ payload: payload({ ...proof(), exhaustion: [entry] }) });
    }
  });

  await check('only blocked and matching generation, backlog and timestamp permit a ticket', async () => {
    for (const change of [{ execution_generation: 8 }, { backlog_revision: 8 },
      { requirement_updated_at: '2026-10-05T10:00:00.123455Z' }]) {
      await unchangedFailure({ payload: payload({ ...proof(), ...change }) }, 'PT409', 'harness_support_stale_proof');
    }
    await unchangedFailure({ revision: 8 }, 'PT409', 'harness_decision_stale_state');
    for (const status of ['backlog', 'pending', 'in-progress', 'completed', 'cancelled']) {
      await db.query('UPDATE requirements SET status=$1', [status]);
      await unchangedFailure({}, '23514', 'harness_support_requires_blocked');
    }
    await db.exec("UPDATE requirements SET status='blocked'");
    for (const value of [null, -1, 'invalid', 2147483648]) {
      await db.query("UPDATE requirements SET metadata=jsonb_set(metadata,'{requirement_execution_generation}',$1)", [JSON.stringify(value)]);
      await unchangedFailure({}, '22023', 'invalid_harness_execution_generation');
    }
    await db.exec("UPDATE requirements SET metadata=metadata-'requirement_execution_generation'");
    await rpc({ payload: payload({ ...proof(), execution_generation: 0 }) });
  });

  await check('exhaustion kinds, empty receipt IDs and empty complete snapshots remain valid', async () => {
    await db.exec('DELETE FROM instance_plans; DELETE FROM requirement_migration_diagnostics; DELETE FROM requirement_migration_lifecycle');
    const cb = proof();
    cb.plan_versions = []; cb.migration_versions = []; cb.diagnostic_versions = []; cb.blocked_item_ids = [];
    cb.exhaustion = ['repair_attempts', 'product_attempts', 'verification_attempts', 'infrastructure_attempts', 'no_progress_cycles', 'migration_recovery']
      .map(kind => ({ kind, target_id: req, used: 5, limit: 3, receipt_ids: [] }));
    await rpc({ payload: payload(cb) });
  });

  await check('exact snapshots reject omission, duplication, invented and malformed rows', async () => {
    for (const key of ['plan_versions', 'migration_versions', 'diagnostic_versions']) {
      for (const entries of [[], [proof()[key][0], ...proof()[key]]]) {
        await unchangedFailure({ payload: payload({ ...proof(), [key]: entries }) }, 'PT409', 'harness_support_stale_snapshot');
      }
      for (const entry of [null, 'row', {}, { ...proof()[key][0], unexpected: true },
        { ...proof()[key][0], updated_at: null }, { ...proof()[key][0], updated_at: 'infinity' },
        { ...proof()[key][0], updated_at: 'not-a-timestamp' }]) {
        await unchangedFailure({ payload: payload({ ...proof(), [key]: [entry] }) });
      }
      for (const field of Object.keys(proof()[key][0])) {
        const cb = proof(); delete cb[key][0][field];
        await unchangedFailure({ payload: payload(cb) });
      }
    }
    for (const [key, change] of [['plan_versions', { id: randomUUID() }], ['plan_versions', { updated_at: '2026-10-05T10:00:00.123455Z' }],
      ['migration_versions', { file: 'migrations/other.sql' }], ['migration_versions', { version: 5 }],
      ['migration_versions', { state: 'validated' }], ['diagnostic_versions', { token: randomUUID() }],
      ['diagnostic_versions', { state: 'running' }]]) {
      const cb = proof(); Object.assign(cb[key][0], change);
      await unchangedFailure({ payload: payload(cb) }, 'PT409', 'harness_support_stale_snapshot');
    }
    for (const [key, change] of [['plan_versions', { id: 'bad-uuid' }], ['migration_versions', { version: '4' }],
      ['migration_versions', { version: 0 }], ['migration_versions', { version: 2147483648 }],
      ['diagnostic_versions', { token: 'bad-uuid' }]]) {
      const cb = proof(); Object.assign(cb[key][0], change);
      await unchangedFailure({ payload: payload(cb) });
    }
  });

  await check('new, changed, removed and relinked plans are fenced including templates and other instances', async () => {
    await db.exec("UPDATE instance_plans SET updated_at=updated_at+interval '1 microsecond'");
    await unchangedFailure({}, 'PT409', 'harness_support_stale_snapshot');
    await reset();
    await db.query('DELETE FROM instance_plans WHERE id=$1', [template]);
    await unchangedFailure({}, 'PT409', 'harness_support_stale_snapshot');
    await reset();
    await db.query('UPDATE instance_plans SET metadata=$1 WHERE id=$2', [{ requirement_id: randomUUID() }, plan]);
    await unchangedFailure({}, 'PT409', 'harness_support_stale_snapshot');
    await reset();
    await db.query('INSERT INTO instance_plans SELECT $1,site_id,instance_id,status,metadata,steps,updated_at,instructions,retry_count FROM instance_plans WHERE id=$2', [randomUUID(), template]);
    await unchangedFailure({}, 'PT409', 'harness_support_stale_snapshot');
    await reset();
    const cb = proof(); cb.plan_versions = cb.plan_versions.filter(row => row.id !== template);
    await unchangedFailure({ payload: payload(cb) }, 'PT409', 'harness_support_stale_snapshot');
    // Legacy instance-only plans are not part of the explicit requirement set.
    const legacy = randomUUID();
    await db.query('INSERT INTO instance_plans SELECT $1,site_id,instance_id,status,$2,steps,updated_at,instructions,retry_count FROM instance_plans WHERE id=$3', [legacy, {}, template]);
    for (const status of ['pending', 'in_progress', 'active', 'paused']) {
      await db.query('UPDATE instance_plans SET status=$1 WHERE id=$2', [status, legacy]);
      await unchangedFailure({}, 'PT409', 'harness_support_legacy_plan_ambiguous');
    }
    await db.query('UPDATE instance_plans SET metadata=$1 WHERE id=$2', [{ workflow_template: true }, legacy]);
    await rpc();
  });

  await check('lifecycle and diagnostic changes and additions invalidate the captured proof', async () => {
    for (const sql of [
      "UPDATE requirement_migration_lifecycle SET version=version+1",
      "UPDATE requirement_migration_lifecycle SET state='validated'",
      "UPDATE requirement_migration_lifecycle SET updated_at=updated_at+interval '1 microsecond'",
      "UPDATE requirement_migration_diagnostics SET token=gen_random_uuid()",
      "UPDATE requirement_migration_diagnostics SET state='running'",
      "UPDATE requirement_migration_diagnostics SET updated_at=updated_at+interval '1 microsecond'",
      'DELETE FROM requirement_migration_diagnostics',
      "INSERT INTO requirement_migration_lifecycle SELECT requirement_id,'migrations/0002.sql',version,state,attempts,review,updated_at FROM requirement_migration_lifecycle",
    ]) {
      await reset(); await db.exec(sql);
      await unchangedFailure({}, 'PT409', 'harness_support_stale_snapshot');
    }
    await reset();
    await db.exec('DELETE FROM requirement_migration_diagnostics');
    const cb = proof(); cb.diagnostic_versions = [];
    await db.query('INSERT INTO requirement_migration_diagnostics VALUES ($1,$2,$3,9,$4,NULL,$5)', [req, 'migrations/0001.sql', randomUUID(), 'running', stamp]);
    await unchangedFailure({ payload: payload(cb) }, 'PT409', 'harness_support_stale_snapshot');
  });

  await check('oversized actual snapshot sets fail rather than silently truncating', async () => {
    await db.exec("INSERT INTO instance_plans SELECT gen_random_uuid(),site_id,instance_id,status,metadata,steps,updated_at,instructions,retry_count FROM instance_plans CROSS JOIN generate_series(1,25)");
    let cb = proof();
    cb.plan_versions = (await rows('SELECT id FROM instance_plans ORDER BY id LIMIT 50')).map(row => ({ ...row, updated_at: stamp }));
    await unchangedFailure({ payload: payload(cb) }, 'PT409', 'harness_support_stale_snapshot');
    await reset();
    await db.exec("INSERT INTO requirement_migration_lifecycle SELECT requirement_id,'migrations/extra-'||n||'.sql',version,state,attempts,review,updated_at FROM requirement_migration_lifecycle CROSS JOIN generate_series(1,100) n");
    cb = proof();
    cb.migration_versions = (await rows('SELECT file,version,state FROM requirement_migration_lifecycle ORDER BY file LIMIT 100')).map(row => ({ ...row, updated_at: stamp }));
    await unchangedFailure({ payload: payload(cb) }, 'PT409', 'harness_support_stale_snapshot');
  });

  await check('timestamps and snapshot order compare semantically without losing microseconds', async () => {
    const cb = proof();
    cb.plan_versions.reverse();
    cb.requirement_updated_at = '2026-10-05T12:00:00.123456+02:00';
    for (const key of ['plan_versions', 'migration_versions', 'diagnostic_versions']) {
      for (const entry of cb[key]) entry.updated_at = cb.requirement_updated_at;
    }
    await rpc({ payload: payload(cb) });
  });

  await check('bounded long identifiers remain valid but the total payload cap cannot be bypassed', async () => {
    const cb = proof();
    cb.blocked_item_ids = Array.from({ length: 200 }, (_, i) => 'blocked-item-' + i);
    cb.blocked_item_ids[0] = 'x'.repeat(512);
    cb.exhaustion[0].target_id = 'x'.repeat(512);
    cb.exhaustion[0].receipt_ids = ['x'.repeat(512)];
    await rpc({ payload: payload(cb) });
    await reset();
    cb.blocked_item_ids = Array(200).fill('x'.repeat(512));
    await unchangedFailure({ payload: payload(cb) }, '22023', 'invalid_harness_decision_payload_keys_or_size');
  });

  await check('approve and adapt retain their old payloads and reject circuit_breaker', async () => {
    const approve = { evidence_log_ids: [evidence], verification: 'Test existing scoped CRUD' };
    const adapt = { ...approve, implementation_instructions: 'Use the existing scoped endpoint', equivalence_reason: 'Same acceptance',
      acceptance_mapping: [{ criterion: 'Preserve scoped CRUD', implementation: 'Use existing endpoint', verification: 'Test scope' }] };
    for (const [decision, input] of [['approve_backlog', approve], ['adapt_backlog', adapt]]) {
      await unchangedFailure({ decision, item: 'item-1', payload: { ...input, circuit_breaker: proof() } });
    }
    const before = await protectedState();
    const approved = await rpc({ decision: 'approve_backlog', item: 'item-1', payload: approve });
    assert.equal(approved.decision.email_state, 'unconfigured');
    assert.deepEqual(await protectedState(), before);
    const adapted = await rpc({ decision: 'adapt_backlog', item: 'item-1', payload: adapt });
    assert.equal(adapted.decision.status, 'applied');
    const after = await protectedState();
    assert.equal(after.requirements[0].value.status, 'blocked');
    assert.deepEqual(after.requirements[0].value.metadata, before.requirements[0].value.metadata);
    assert.equal(after.requirements[0].value.backlog.items[0].attempts, 3);
    for (const key of Object.keys(before).filter(key => key !== 'requirements')) assert.deepEqual(after[key], before[key]);
  });

  await check('only service_role can execute and cannot bypass authoring via direct writes', async () => {
    for (const role of ['anon', 'authenticated', 'public_only']) {
      await rejected(() => asRole(role, () => call()), '42501');
      assert.equal((await rows('SELECT has_function_privilege($1,$2,$3) AS permitted', [role, signature, 'EXECUTE']))[0].permitted, false);
    }
    assert.equal((await rows('SELECT has_function_privilege($1,$2,$3) AS permitted', ['service_role', signature, 'EXECUTE']))[0].permitted, true);
    await unchangedFailure({ site: foreignSite }, '42501', 'harness_decision_scope_denied');
    for (const statement of [
      'INSERT INTO requirement_harness_decisions DEFAULT VALUES',
      "UPDATE requirement_harness_decisions SET reason='bypass'", 'DELETE FROM requirement_harness_decisions',
    ]) await rejected(() => asRole('service_role', () => db.exec(statement)), '42501');
    const receipt = await rpc();
    await asRole('service_role', () => db.query("UPDATE requirement_harness_decisions SET email_state='sending' WHERE id=$1", [receipt.decision.id]));
    assert.equal((await receipts())[0].value.email_state, 'sending');
  });

  await check('plan phantom fence is retained for the receipt transaction', async () => {
    await db.exec('BEGIN');
    try {
      await rpc();
      const locks = await rows("SELECT mode FROM pg_locks WHERE relation='public.instance_plans'::regclass AND granted");
      assert.ok(locks.some(lock => lock.mode === 'ShareLock'));
    } finally { await db.exec('ROLLBACK'); }
  });

  await check('migration fails closed for missing function, partial patches and source drift', async () => {
    const patched = await definition();
    const rejectMigration = async code => rejected(async () => {
      try { await db.exec(migration); } finally { await db.exec('ROLLBACK'); }
    }, code);
    await db.exec('ALTER FUNCTION ' + signature + ' RENAME TO fixture_harness_decision');
    try { await rejectMigration('42883'); }
    finally { await db.exec('ALTER FUNCTION ' + signature.replace('record_harness_diagnostic_decision', 'fixture_harness_decision') + ' RENAME TO record_harness_diagnostic_decision'); }
    for (const drifted of [
      patched.definition.replace("'attempted_alternatives', 'circuit_breaker'] END", "'attempted_alternatives'] END"),
      patched.definition.replace("ERRCODE = 'PT409', MESSAGE = 'harness_decision_stale_state'", "ERRCODE = '40001', MESSAGE = 'harness_decision_stale_state'"),
      patched.definition.replace('  v_plans_updated integer := 0;', '  v_plans_updated integer := 1;'),
      patched.definition.replace('    -- Host-only structural proof;', '    -- Unexpected drift\n    -- Host-only structural proof;'),
    ]) {
      await db.exec(drifted);
      const before = await definition();
      await rejectMigration('P0001');
      assert.deepEqual(await definition(), before);
      await db.exec(patched.definition);
    }
    assert.deepEqual(await definition(), patched);
  });
  process.stdout.write(JSON.stringify(passed));
} finally {
  await db.close();
}