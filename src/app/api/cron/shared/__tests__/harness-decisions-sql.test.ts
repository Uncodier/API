import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Real PostgreSQL in a child process; no application imports, credentials, network,
// remote database, or production changes. PGlite does not prove concurrent races.
describe('harness diagnostic decisions SQL', () => {
  let passed: string[];
  beforeAll(() => {
    const script = String.raw`
      import { PGlite } from '@electric-sql/pglite';
      import { readFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      const db = new PGlite();
      const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
      const site = id(1), foreignSite = id(2), req = id(3), instance = id(4), origin = id(5), other = id(6);
      const stamp = '2026-10-01T10:00:00.000Z', evidence = id(10), request = id(20), plan = id(30);
      const item = {
        id: 'item-1', title: 'Account CRUD', kind: 'crud', status: 'in_progress', phase_id: 'p1',
        acceptance: ['Create an account', 'Read persisted account'],
        acceptance_contract: { schema_version: 2, source: 'declared', criteria: [{ id: 'one', route: '/account' }] },
        constraints: ['No public writes'], tier: 'core', scope_level: 'full', depends_on: ['auth'],
        attempts: 3, tool_failures: { judge: 3, migration: 5 }, touches: ['/account'],
        blocked_by: [{ category: 'infrastructure_unavailable', resolution_actor: 'platform', reason: 'SQL review hold' }],
        plan_cancellation_pending: { reason: 'await reconciliation', requested_at: stamp },
        review_quarantine: { active: false, released_by_action_id: 'historic-only' },
        custom_unknown: { nested: ['preserve', 1] }, updated_at: stamp,
      };
      const sibling = { id: 'held', status: 'needs_review', attempts: 5,
        review_quarantine: { active: true, external_action_revision: 8, quarantined_at: stamp } };
      const backlog = { schema_version: 1, items: [item, sibling], completion_ratio: 0,
        cycles_spent_total: 7, current_phase_id: 'p1', custom: 'preserve' };
      const metadata = { runner_instance_id: instance, assistant_origin_instance_id: origin,
        execution_hold: { kind: 'migration_platform_review', attempts: 5 }, requirement_execution_generation: 9,
        cron_failures: 4, infrastructure_retries: 5 };
      const approve = { evidence_log_ids: [evidence], verification: 'Inspect persisted review and original specification' };
      const adapt = { ...approve, implementation_instructions: 'Use the existing scoped account API',
        equivalence_reason: 'Same CRUD contract and authorization', acceptance_mapping: item.acceptance.map(criterion =>
          ({ criterion, implementation: 'Use scoped API', verification: 'Test authenticated CRUD and tenant isolation' })) };
      const support = { ...approve, impact: 'Account implementation is blocked', requested_action: 'Reconcile reviewed migration',
        attempted_alternatives: ['Inspected original SQL and recorded review without retrying execution'] };
      const rows = async (sql, args=[]) => (await db.query(sql, args)).rows;
      const readReq = async () => (await rows('SELECT to_jsonb(r) AS value FROM requirements r WHERE id=$1', [req]))[0].value;
      const readDecisions = () => rows('SELECT * FROM requirement_harness_decisions ORDER BY created_at,id');
      const protectedRows = async () => ({
        logs: await rows('SELECT * FROM instance_logs ORDER BY id'), plans: await rows('SELECT * FROM instance_plans ORDER BY id'),
        instances: await rows('SELECT * FROM remote_instances ORDER BY id'),
        lifecycle: await rows('SELECT * FROM requirement_migration_lifecycle'),
        notifications: await rows('SELECT * FROM notifications'),
      });
      const role = async (name, fn) => {
        await db.exec('SET ROLE ' + name);
        try { return await fn(); } finally { await db.exec('RESET ROLE'); }
      };
      const args = overrides => ({ site, req, instance, revision: 7, updated: stamp, request,
        decision: 'adapt_backlog', item: 'item-1', reason: 'Preserve acceptance; adapt implementation only', payload: adapt, ...overrides });
      const call = async (overrides={}) => {
        const a = args(overrides);
        return (await rows('SELECT public.record_harness_diagnostic_decision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS receipt',
          [a.site,a.req,a.instance,a.revision,a.updated,a.request,a.decision,a.item,a.reason,a.payload]))[0].receipt;
      };
      const rpc = overrides => role('service_role', () => call(overrides));
      const rejected = async (fn, code, message) => assert.rejects(fn, e => {
        assert.equal(e.code, code, e.message);
        if (message) assert.match(e.message, new RegExp(message));
        return true;
      });
      const unchangedFailure = async (overrides, code, message) => {
        const before = await readReq(), decisions = await readDecisions(), protectedBefore = await protectedRows();
        await rejected(() => rpc(overrides), code, message);
        assert.deepEqual(await readReq(), before);
        assert.deepEqual(await readDecisions(), decisions);
        assert.deepEqual(await protectedRows(), protectedBefore);
      };
      const reset = async () => {
        await db.exec('TRUNCATE requirement_harness_decisions,requirements,remote_instances,instance_logs,instance_plans,requirement_migration_lifecycle,notifications CASCADE');
        await db.query('INSERT INTO remote_instances(id,site_id,status,is_archived) VALUES ($1,$2,$3,false),($4,$2,$3,false),($5,$2,$3,false),($6,$7,$3,false)',
          [instance,site,'running',origin,other,id(7),foreignSite]);
        await db.query('INSERT INTO requirements(id,site_id,status,metadata,backlog,backlog_revision,updated_at,instructions,external_user_action_revision,last_external_user_action_id,progress) VALUES ($1,$2,$3,$4,$5,7,$6,$7,8,NULL,$8)',
          [req,site,'blocked',metadata,backlog,stamp,'Original non-negotiable product specification',[{ stage: 'blocked', attempts: 5 }]]);
        await db.query('INSERT INTO instance_logs(id,site_id,instance_id,details,tool_args) VALUES ($1,$2,$3,$4,$5)',
          [evidence,site,instance,{ requirement_id: req },{}]);
        await db.query('INSERT INTO requirement_migration_lifecycle VALUES ($1,$2,$3,5,$4)',
          [req,'migrations/0001.sql','platform_review',{ decision: 'correction_required', original_sql: 'SELECT 1' }]);
        await db.query('INSERT INTO notifications VALUES ($1,$2)', [id(40),{ untouched: true }]);
      };
      const setItem = async (changes) => db.query('UPDATE requirements SET backlog=jsonb_set(backlog,$1,$2) WHERE id=$3',
        [['items','0'],{...item,...changes},req]);
      const addPlan = async (changes={}) => {
        const p = { id: plan, instance, site, status: 'in_progress', metadata: { requirement_id: req },
          steps: [{ id: 'step', status: 'pending', metadata: { backlog_item_id: 'item-1' } }], ...changes };
        await db.query('INSERT INTO instance_plans(id,instance_id,site_id,status,metadata,steps,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [p.id,p.instance,p.site,p.status,p.metadata,p.steps,stamp]);
      };
      const passed = [];
      const check = async (name, fn) => { await reset(); await fn(); passed.push(name); };
      try {
        await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE public_only; CREATE ROLE service_role NOBYPASSRLS; ' +
          'GRANT USAGE ON SCHEMA public TO anon,authenticated,public_only,service_role; ' +
          'CREATE TABLE requirements(id uuid PRIMARY KEY,site_id uuid NOT NULL,status text NOT NULL,instructions text,metadata jsonb,backlog jsonb,backlog_revision bigint NOT NULL,updated_at timestamptz NOT NULL,cron_lock_active boolean DEFAULT false,cron_lock_expires_at timestamptz,cron_lock_run_id text,external_user_action_revision bigint,last_external_user_action_id text,progress jsonb); ' +
          'CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid NOT NULL,status text NOT NULL,is_archived boolean NOT NULL); ' +
          'CREATE TABLE instance_logs(id uuid PRIMARY KEY,site_id uuid NOT NULL,instance_id uuid NOT NULL,details jsonb,tool_args jsonb,log_type text DEFAULT $$tool_result$$,trusted_user_action boolean DEFAULT false,created_at timestamptz DEFAULT now()); ' +
          'CREATE TABLE instance_plans(id uuid PRIMARY KEY,site_id uuid NOT NULL,instance_id uuid NOT NULL,status text,metadata jsonb,steps jsonb,updated_at timestamptz DEFAULT now(),instructions text DEFAULT $$Original plan instructions$$,retry_count integer DEFAULT 4,steps_completed integer DEFAULT 0); ' +
          'CREATE TABLE requirement_migration_lifecycle(requirement_id uuid,file text,state text,attempts integer,review jsonb); ' +
          'CREATE TABLE notifications(id uuid PRIMARY KEY,payload jsonb); ' +
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role;');
        const migration = readFileSync('supabase/migrations/20261001220000_harness_diagnostic_decisions.sql','utf8');
        assert.ok(migration.split('\n').length <= 500);
        await db.exec(migration);

        await check('authoring preserves all guards and original contracts', async () => {
          const before = await readReq(), protectedBefore = await protectedRows();
          const receipt = await rpc();
          assert.equal(receipt.decision.status, 'applied');
          assert.equal(receipt.decision.email_state, 'unconfigured');
          assert.deepEqual(receipt.effects, {backlog_changed:true, backlog_revision:8, plans_updated:0, plan_steps_updated:0, execution_started:false});
          const after = await readReq(), strategy = after.backlog.items[0].implementation_strategy;
          assert.deepEqual(strategy, { decision_id: receipt.decision.id, instructions: adapt.implementation_instructions,
            verification: adapt.verification, equivalence_reason: adapt.equivalence_reason,
            acceptance_mapping: adapt.acceptance_mapping, recorded_at: receipt.decision.created_at });
          assert.equal(after.backlog_revision, 8);
          assert.notEqual(after.updated_at, before.updated_at);
          delete after.backlog.items[0].implementation_strategy;
          assert.deepEqual({...after,backlog_revision:before.backlog_revision,updated_at:before.updated_at}, before);
          assert.deepEqual(await protectedRows(), protectedBefore);
          for (const key of ['acceptance','acceptance_contract','constraints','tier','scope_level','depends_on'])
            assert.deepEqual(receipt.decision.contract_snapshot[key], item[key]);
          assert.equal(receipt.decision.contract_snapshot.requirement_instructions, before.instructions);
          assert.equal((await readDecisions()).length, 1);
          // Replacing an existing strategy still cannot replace any original field.
          const second = await rpc({request:id(21),revision:8,updated:(await readReq()).updated_at});
          assert.notEqual(second.decision.id, receipt.decision.id);
          assert.equal((await readReq()).backlog.items[0].implementation_strategy.decision_id, second.decision.id);
        });

        await check('approval and support are receipts, never completion or execution', async () => {
          await addPlan(); // Approval does not rewrite a bound plan's strategy.
          const before = await readReq(), protectedBefore = await protectedRows();
          const receipt = await rpc({decision:'approve_backlog',payload:approve});
          assert.equal(receipt.decision.status,'recorded');
          assert.deepEqual(receipt.effects,{backlog_changed:false,backlog_revision:7,plans_updated:0,plan_steps_updated:0,execution_started:false});
          assert.deepEqual(await readReq(),before);
          const ticket = await rpc({request:id(21),decision:'escalate_support',item:null,payload:support});
          assert.equal(ticket.decision.status,'recorded');
          assert.equal(ticket.decision.email_state,'pending');
          assert.match(ticket.decision.id,/^[0-9a-f-]{36}$/);
          assert.equal(ticket.decision.contract_snapshot.acceptance,null);
          assert.equal(ticket.effects.execution_started,false);
          const inaccessible = await rpc({request:id(22),decision:'escalate_support',item:'item-1',
            reason:'Evidence logs unavailable; request technical investigation',payload:{...support,evidence_log_ids:[]}});
          assert.equal(inaccessible.decision.email_state,'pending');
          assert.deepEqual(await readReq(),before);
          assert.deepEqual(await protectedRows(),protectedBefore);
        });

        await check('tenant and current instance ownership are mandatory', async () => {
          for (const overrides of [{site:foreignSite},{req:id(99)},{instance:id(99)},{instance:id(7)},{instance:other}])
            await unchangedFailure(overrides,'42501');
          await db.query('UPDATE remote_instances SET is_archived=true WHERE id=$1',[instance]);
          await unchangedFailure({},'42501');
          await db.query('UPDATE remote_instances SET is_archived=false WHERE id=$1',[instance]);
          await addPlan({instance:other});
          await unchangedFailure({instance:other},'42501','owner_required');
          const approved = await rpc({instance:origin,decision:'approve_backlog',payload:approve});
          assert.equal(approved.decision.instance_id,origin);
          const ticket = await rpc({instance:other,request:id(21),decision:'escalate_support',item:null,payload:support});
          assert.equal(ticket.decision.instance_id,other);
          await db.query('UPDATE instance_plans SET site_id=$1',[foreignSite]);
          await unchangedFailure({instance:other,request:id(22),decision:'escalate_support',payload:support},'42501','link_required');
          await db.query('UPDATE instance_plans SET site_id=$1,metadata=$2',[site,{requirement_id:id(99)}]);
          await unchangedFailure({instance:other,request:id(22),decision:'escalate_support',payload:support},'42501','link_required');
        });

        await check('CAS and exact replay prevent stale or conflicting writes', async () => {
          await unchangedFailure({revision:6},'40001');
          await unchangedFailure({updated:'2026-09-01T00:00:00Z'},'40001');
          const receipt = await rpc();
          assert.deepEqual(await rpc(),receipt); // Old revision and timestamp are intentional.
          for (const overrides of [{reason:'Different reason'},{payload:{...adapt,verification:'Different'}},
            {decision:'approve_backlog',payload:approve},{item:'held'},{instance:origin}])
            await unchangedFailure(overrides,'23505','request_conflict');
          await unchangedFailure({request:id(21)},'40001');
          await db.query('UPDATE requirements SET status=$1,cron_lock_active=true,cron_lock_expires_at=now()+interval $$1 hour$$ WHERE id=$2',['done',req]);
          await setItem({status:'done'});
          assert.deepEqual(await rpc(),receipt);
          await db.query('UPDATE remote_instances SET is_archived=true WHERE id=$1',[instance]);
          await unchangedFailure({},'42501'); // Replay cannot bypass current scope.
          assert.equal((await readDecisions()).length,1);
        });

        await check('completed, quarantined, and ambiguous items cannot be authored', async () => {
          for (const status of ['done','needs_review','critic_review','judge_review','rejected','quarantined',null]) {
            await setItem({status});
            for (const [decision,payload] of [['adapt_backlog',adapt],['approve_backlog',approve]])
              await unchangedFailure({decision,payload},'23514');
          }
          await setItem({review_quarantine:{active:true}});
          await unchangedFailure({},'23514');
          await rpc({decision:'escalate_support',payload:support}); // Records evidence, never releases quarantine.
          await setItem({});
          for (const status of ['done','completed','canceled','cancelled','on-review']) {
            await db.query('UPDATE requirements SET status=$1',[status]);
            await unchangedFailure({request:id(21)},'23514');
          }
          await db.query('UPDATE requirements SET status=$1',['blocked']);
          await unchangedFailure({request:id(21),item:'missing'},'22023','item_missing');
          await db.query('UPDATE requirements SET backlog=jsonb_set(backlog,$1,$2)',[['items'],[item,item]]);
          await unchangedFailure({request:id(21)},'22023','ambiguous');
        });

        await check('active cron, manual pause, and other conversation fence changes', async () => {
          await db.query('UPDATE requirements SET cron_lock_active=true,cron_lock_expires_at=now()+interval $$1 hour$$');
          await unchangedFailure({},'55P03','cron_busy');
          const busyBefore = await readReq();
          const approval = await rpc({request:id(25),decision:'approve_backlog',payload:approve});
          assert.equal(approval.decision.status,'recorded');
          assert.equal(approval.effects.execution_started,false);
          assert.deepEqual(await readReq(),busyBefore); // Active-run approval cannot mutate its state.
          await rpc({decision:'escalate_support',payload:support});
          await db.query('UPDATE requirements SET cron_lock_active=false');
          await rpc({request:id(21),decision:'approve_backlog',payload:approve});
          await db.query('UPDATE requirements SET cron_lock_active=true,cron_lock_expires_at=now()-interval $$1 hour$$');
          await rpc({request:id(22),decision:'approve_backlog',payload:approve});
          for (const owner of [instance,origin]) for (const status of ['paused','stopped','stopping']) {
            await db.query('UPDATE remote_instances SET status=$1 WHERE id=$2',[status,owner]);
            await unchangedFailure({request:id(23)},'55P03','instance_paused');
            await db.query('UPDATE remote_instances SET status=$1 WHERE id=$2',['running',owner]);
          }
          await db.query('INSERT INTO instance_logs(id,site_id,instance_id,log_type,trusted_user_action,details) VALUES ($1,$2,$3,$4,true,$5)',
            [id(50),site,origin,'user_action',{status:'running'}]);
          await unchangedFailure({request:id(23)},'55P03','other_conversation_busy');
          await db.query('UPDATE instance_logs SET details=$1 WHERE id=$2',[{status:'completed'},id(50)]);
          await rpc({request:id(23),decision:'approve_backlog',payload:approve});
          await db.query('UPDATE instance_logs SET instance_id=$1,details=$2 WHERE id=$3',[instance,{status:'running'},id(50)]);
          await rpc({request:id(24),decision:'approve_backlog',payload:approve});
        });

        await check('adapt rejects active, paused, mixed, and ambiguously bound plans', async () => {
          for (const status of ['active','in_progress','paused']) {
            await addPlan({status});
            await unchangedFailure({},'55P03','bound_plan_busy');
            await db.exec('DELETE FROM instance_plans');
          }
          for (const status of ['in_progress','completed','failed','cancelled','paused','blocked',null]) {
            for (const linked of [true,false]) {
              await addPlan({status:'pending',steps:[{status:'pending',backlog_item_id:'item-1'},
                {status,backlog_item_id:linked?'item-1':'unrelated'}]});
              await unchangedFailure({},'55P03','bound_plan_busy');
              await db.exec('DELETE FROM instance_plans');
            }
          }
          await addPlan({status:'pending',instance:other});
          await unchangedFailure({},'55P03'); // Even pending plans on non-owner instances are not rewritten.
          await db.query('UPDATE instance_plans SET steps=$1,metadata=$2',[[],{requirement_id:req,backlog_item_id:'item-1'}]);
          await unchangedFailure({},'55P03');
          await db.query('UPDATE instance_plans SET instance_id=$1,metadata=$2',[instance,{backlog_item_id:'item-1'}]);
          await unchangedFailure({},'55P03'); // Legacy instance-bound plan without requirement metadata.
          await db.query('UPDATE instance_plans SET metadata=$1',[{requirement_id:req,backlog_item_id:'item-1'}]);
          for (const steps of [[],{},null,[{status:'pending',backlog_item_id:'unrelated'}],
            [{status:'pending',backlog_item_id:'item-1',metadata:['invalid']}],
            [{status:'pending',backlog_item_id:'item-1',metadata:{backlog_item_id:'conflicting'}}]]) {
            await db.query('UPDATE instance_plans SET steps=$1',[steps]);
            await unchangedFailure({},'55P03');
          }
          await db.query('UPDATE instance_plans SET status=$1',['completed']);
          const before = await protectedRows();
          await rpc();
          assert.deepEqual(await protectedRows(),before);
        });

        await check('adapt rewrites only linked instructions on wholly pending owned plans', async () => {
          const first = {id:'one',status:'pending',instructions:'Old implementation',acceptance:['Keep this'],
            attempts:4,blocked_by:['migration'],metadata:{backlog_item_id:'item-1',guard:{attempts:5},harness_decision_id:'old'}};
          const second = {id:'two',status:'pending',instructions:'Old alternate',backlog_item_id:'item-1',metadata:null,
            validation_targets:['original target'],success_criteria:['Original success']};
          const unbound = {id:'unrelated',status:'pending',instructions:'Do not touch',metadata:{backlog_item_id:'held'}};
          await addPlan({status:'pending',steps:[first,second,unbound],metadata:{requirement_id:req,keep:['all','metadata'],retry_budget:3}});
          await addPlan({id:id(31),instance:origin,status:'pending',steps:[{status:'pending',backlog_item_id:'item-1',attempts:2}]});
          // Same IDs on other requirements/sites are not scope. Held/terminal plans remain held/terminal.
          for (const changes of [{id:id(32),site:foreignSite},{id:id(33),metadata:{requirement_id:id(99)}},
            {id:id(34),status:'blocked'},{id:id(35),status:'cancelled'}]) await addPlan(changes);
          const protectedBefore = await protectedRows(), beforeReq = await readReq();
          const receipt = await rpc();
          assert.deepEqual(receipt.effects,{backlog_changed:true,backlog_revision:8,plans_updated:2,plan_steps_updated:3,execution_started:false});
          const after = await protectedRows();
          for (const [index,p] of after.plans.entries()) {
            const before = protectedBefore.plans[index];
            if (![plan,id(31)].includes(p.id)) { assert.deepEqual(p,before); continue; }
            assert.notEqual(p.updated_at.toISOString(),before.updated_at.toISOString());
            for (const [i,step] of p.steps.entries()) {
              if (step.id==='unrelated') { assert.deepEqual(step,before.steps[i]); continue; }
              assert.deepEqual(step.metadata,{...(before.steps[i].metadata || {}),harness_decision_id:receipt.decision.id});
              for (const text of [adapt.implementation_instructions,adapt.verification,adapt.equivalence_reason,...item.acceptance])
                assert.ok(step.instructions.includes(text));
              p.steps[i] = {...step,instructions:before.steps[i].instructions,metadata:before.steps[i].metadata};
              if (!('instructions' in before.steps[i])) delete p.steps[i].instructions;
              if (!('metadata' in before.steps[i])) delete p.steps[i].metadata;
            }
            p.updated_at = before.updated_at;
            assert.deepEqual(p,before); // status/acceptance/counters/plan metadata/unknown fields preserved.
          }
          assert.deepEqual(after,protectedBefore);
          const changedReq = await readReq();
          assert.equal(changedReq.backlog.items[0].implementation_strategy.decision_id,receipt.decision.id);
          delete changedReq.backlog.items[0].implementation_strategy;
          assert.deepEqual({...changedReq,updated_at:beforeReq.updated_at,backlog_revision:7},beforeReq);
          const persistedPlans = await rows('SELECT * FROM instance_plans ORDER BY id');
          assert.deepEqual(await rpc(),receipt);
          assert.deepEqual(await rows('SELECT * FROM instance_plans ORDER BY id'),persistedPlans);
          const revised = await rpc({request:id(21),instance:origin,revision:8,updated:(await readReq()).updated_at});
          assert.equal(revised.effects.plans_updated,2);
          assert.equal(revised.effects.plan_steps_updated,3);
          assert.equal(revised.effects.backlog_revision,9);
        });

        await check('pending plan updates roll back with later plan or receipt errors', async () => {
          await addPlan({status:'pending'});
          await addPlan({id:id(31),status:'paused'});
          await unchangedFailure({},'55P03','bound_plan_busy'); // First plan was updated before later rejection.
          await db.query('DELETE FROM instance_plans WHERE id=$1',[id(31)]);
          await db.exec('CREATE FUNCTION fixture_fail_plan_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE=$code$23514$code$,MESSAGE=$msg$receipt unavailable$msg$; END $$; ' +
            'CREATE TRIGGER fixture_plan_receipt BEFORE INSERT ON requirement_harness_decisions FOR EACH ROW EXECUTE FUNCTION fixture_fail_plan_receipt();');
          await unchangedFailure({},'23514','receipt unavailable');
          await db.exec('DROP TRIGGER fixture_plan_receipt ON requirement_harness_decisions; DROP FUNCTION fixture_fail_plan_receipt();');
          await db.query('UPDATE requirements SET cron_lock_active=true,cron_lock_expires_at=now()+interval $$1 hour$$');
          await unchangedFailure({},'55P03','cron_busy');
          await db.query('UPDATE requirements SET cron_lock_active=false');
          await db.query('UPDATE remote_instances SET is_archived=true WHERE id=$1',[origin]);
          await addPlan({id:id(31),instance:origin,status:'pending'});
          await unchangedFailure({},'55P03','bound_plan_busy');
        });

        await check('support deduplicates the same snapshot across request IDs without replacing its receipt', async () => {
          const input = {decision:'escalate_support',payload:{...support,evidence_log_ids:[]},item:null};
          const ticket = await rpc(input);
          const rejectDuplicate = overrides => unchangedFailure({...input,request:id(21),...overrides},'23505','harness_support_ticket_exists');
          await rejectDuplicate({});
          await rejectDuplicate({instance:origin,payload:{...support,impact:'Changed wording cannot create another ticket'}});
          for (const email_state of ['pending','sending','sent','failed','unconfigured']) {
            await role('service_role',()=>db.query('UPDATE requirement_harness_decisions SET email_state=$1 WHERE id=$2',[email_state,ticket.decision.id]));
            await rejectDuplicate({});
          }
          const replay = await rpc(input);
          assert.equal(replay.decision.id,ticket.decision.id);
          assert.deepEqual(replay.effects,ticket.effects);
          await unchangedFailure({...input,payload:support},'23505','request_conflict');
          const visible = await role('service_role',()=>readDecisions());
          assert.equal(visible.length,1);
          assert.equal(visible[0].id,ticket.decision.id);
          assert.deepEqual(visible[0].payload,ticket.decision.payload);
          // Item identity is part of dedupe; a distinct item can have its own ticket.
          await rpc({...input,request:id(21),item:'item-1'});
          await unchangedFailure({...input,request:id(22),item:'item-1'},'23505','harness_support_ticket_exists');
          const newStamp = '2026-10-01T10:01:00.000Z';
          await db.query('UPDATE requirements SET updated_at=$1',[newStamp]);
          const changedTime = await rpc({...input,request:id(22),updated:newStamp});
          assert.notEqual(changedTime.decision.id,ticket.decision.id);
          await db.query('UPDATE requirements SET backlog_revision=8');
          const changedRevision = await rpc({...input,request:id(23),updated:newStamp,revision:8});
          assert.notEqual(changedRevision.decision.id,changedTime.decision.id);
          await unchangedFailure({...input,request:id(24),updated:newStamp,revision:8},'23505','harness_support_ticket_exists');
          await db.query('INSERT INTO requirements(id,site_id,status,metadata,backlog,backlog_revision,updated_at) SELECT $1,site_id,status,metadata,backlog,backlog_revision,updated_at FROM requirements WHERE id=$2',[id(98),req]);
          const distinctRequirement = await rpc({...input,req:id(98),request:id(24),updated:newStamp,revision:8});
          assert.equal(distinctRequirement.decision.requirement_id,id(98));
        });

        await check('acceptance mapping is complete, ordered, typed, and exact', async () => {
          const maps = [adapt.acceptance_mapping.slice(1), [...adapt.acceptance_mapping].reverse(),
            [...adapt.acceptance_mapping,adapt.acceptance_mapping[0]],
            [{...adapt.acceptance_mapping[0],criterion:'Weaker acceptance'},adapt.acceptance_mapping[1]],
            [{...adapt.acceptance_mapping[0],extra:'forbidden'},adapt.acceptance_mapping[1]],
            [{...adapt.acceptance_mapping[0],verification:''},adapt.acceptance_mapping[1]],
            [{...adapt.acceptance_mapping[0],implementation:9},adapt.acceptance_mapping[1]],
            [{criterion:item.acceptance[0],implementation:'missing verification'},adapt.acceptance_mapping[1]],null,{}];
          for (const acceptance_mapping of maps)
            await unchangedFailure({payload:{...adapt,acceptance_mapping}},'22023');
          await setItem({acceptance:null});
          await unchangedFailure({},'22023');
          await setItem({acceptance:[]});
          await rpc({payload:{...adapt,acceptance_mapping:[]}}); // Empty original set must remain empty.
          assert.deepEqual((await readReq()).backlog.items[0].acceptance,[]);
        });

        await check('evidence is scoped by requirement or bound instance without conflicts', async () => {
          for (const evidence_log_ids of [[id(99)],[evidence,evidence],[evidence,evidence.toUpperCase()],[],['not-uuid'],[9],null,{},Array(21).fill(evidence)])
            await unchangedFailure({payload:{...adapt,evidence_log_ids}},evidence_log_ids?.[0]===id(99)?'42501':'22023');
          for (const [logSite,logInstance,details,toolArgs] of [
            [foreignSite,instance,{requirement_id:req},{}], [site,other,{},{}],
            [site,instance,{requirement_id:id(99)},{}], [site,instance,{requirement_id:req},{requirement_id:id(99)}],
            [site,instance,{}, {requirementId:id(99)}], [site,instance,{requirementId:id(99)},{}],
          ]) {
            await db.query('UPDATE instance_logs SET site_id=$1,instance_id=$2,details=$3,tool_args=$4 WHERE id=$5',
              [logSite,logInstance,details,toolArgs,evidence]);
            await unchangedFailure({},'42501','evidence_scope_denied');
          }
          for (const [logInstance,details,toolArgs] of [[instance,{},{}],[other,{requirement_id:req},{}],
            [other,{}, {requirement_id:req}],[other,{requirementId:req},{}],[other,{}, {requirementId:req}]]) {
            await db.query('UPDATE instance_logs SET site_id=$1,instance_id=$2,details=$3,tool_args=$4 WHERE id=$5',
              [site,logInstance,details,toolArgs,evidence]);
            await rpc({decision:'approve_backlog',payload:approve,request:crypto.randomUUID()});
          }
        });

        await check('SQL independently enforces strict keys and payload limits', async () => {
          for (const overrides of [{decision:null},{decision:'complete'},{reason:''},{reason:' \n\t'},
            {reason:'x'.repeat(4001)},{item:null},{item:''},{item:'x'.repeat(201)},
            {request:null},{revision:null},{revision:-1},{updated:null},{updated:'infinity'},
            {payload:null},{payload:[]},{payload:{}},{payload:{...adapt,recipient:'attacker@example.com'}},
            {payload:{...adapt,status:'done'}},{payload:{...adapt,verification:null}},
            {payload:{...adapt,verification:'\t\n'}},{payload:{...adapt,verification:'x'.repeat(4001)}},
            {payload:{...adapt,implementation_instructions:'x'.repeat(12001)}},
            {payload:{...adapt,equivalence_reason:'x'.repeat(4001)}}]) await unchangedFailure(overrides,'22023');
          for (const payload of [{...support,recipient:'forbidden'},{...support,impact:'x'.repeat(4001)},
            {...support,requested_action:''},{...support,attempted_alternatives:[]},
            {...support,attempted_alternatives:Array(21).fill('one')},{...support,attempted_alternatives:['x'.repeat(2001)]},
            {...support,attempted_alternatives:[null]},{...support,attempted_alternatives:{}},
            {...support,verification:'界'.repeat(4000),impact:'界'.repeat(4000),requested_action:'界'.repeat(4000),attempted_alternatives:Array(20).fill('界'.repeat(2000))}])
            await unchangedFailure({decision:'escalate_support',payload},'22023');
          await unchangedFailure({decision:'approve_backlog',payload:adapt},'22023');
          await setItem({acceptance:Array(51).fill('criterion')});
          await unchangedFailure({payload:{...adapt,acceptance_mapping:Array(51).fill({criterion:'criterion',implementation:'Impl',verification:'Test'})}},'22023');
        });

        await check('late SQL errors roll back backlog and durable receipt atomically', async () => {
          await db.exec('CREATE FUNCTION fixture_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE=$code$23514$code$, MESSAGE=$message$injected receipt failure$message$; END $$; ' +
            'CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON requirement_harness_decisions FOR EACH ROW EXECUTE FUNCTION fixture_fail_receipt();');
          await unchangedFailure({},'23514','injected receipt failure');
          await db.exec('DROP TRIGGER fixture_receipt_failure ON requirement_harness_decisions; DROP FUNCTION fixture_fail_receipt();');
          await db.exec('BEGIN');
          await call();
          await db.exec('ROLLBACK');
          assert.equal((await readDecisions()).length,0);
          assert.deepEqual((await readReq()).backlog,backlog);
          assert.equal((await readReq()).backlog_revision,7);
          await rpc();
          assert.equal((await readDecisions()).length,1);
        });

        await check('service-only RLS and column grants permit delivery CAS, not authoring', async () => {
          const signature = 'public.record_harness_diagnostic_decision(uuid,uuid,uuid,bigint,timestamptz,uuid,text,text,text,jsonb)';
          const acl = await rows('SELECT rolname,has_function_privilege(rolname,$1,$2) AS execute,has_table_privilege(rolname,$3,$4) AS read,has_table_privilege(rolname,$3,$5) AS write FROM pg_roles WHERE rolname IN ($6,$7,$8,$9)',
            [signature,'EXECUTE','public.requirement_harness_decisions','SELECT','UPDATE','anon','authenticated','public_only','service_role']);
          for (const a of acl) assert.deepEqual(a,{rolname:a.rolname,execute:a.rolname==='service_role',read:a.rolname==='service_role',write:false});
          for (const name of ['anon','authenticated','public_only']) await role(name,async () => {
            await rejected(()=>call(),'42501');
            await rejected(()=>readDecisions(),'42501');
            await rejected(()=>db.exec('UPDATE requirement_harness_decisions SET email_state=$$sent$$'),'42501');
          });
          const receipt = await rpc({decision:'escalate_support',payload:support,item:null});
          await role('service_role',async () => {
            assert.equal((await readDecisions()).length,1); // NOBYPASSRLS exercises actual policy.
            for (const sql of ['INSERT INTO requirement_harness_decisions SELECT * FROM requirement_harness_decisions',
              'DELETE FROM requirement_harness_decisions','UPDATE requirement_harness_decisions SET reason=$$forged$$',
              'UPDATE requirement_harness_decisions SET payload=jsonb_build_object()','UPDATE requirement_harness_decisions SET contract_snapshot=jsonb_build_object()',
              'UPDATE requirement_harness_decisions SET status=$$applied$$']) await rejected(()=>db.exec(sql),'42501');
            const claim = () => rows('UPDATE requirement_harness_decisions SET email_state=$1,email_attempted_at=clock_timestamp(),email_error=NULL WHERE id=$2 AND email_state IN ($3,$4) RETURNING id',
              ['sending',receipt.decision.id,'pending','failed']);
            assert.equal((await claim()).length,1);
            assert.equal((await claim()).length,0); // Never auto-retry uncertain sending.
            await db.query('UPDATE requirement_harness_decisions SET email_state=$1,email_error=$2 WHERE id=$3',['failed','Definite local pre-delivery failure',receipt.decision.id]);
            assert.equal((await claim()).length,1);
            await db.query('UPDATE requirement_harness_decisions SET email_state=$1 WHERE id=$2',['sent',receipt.decision.id]);
            assert.equal((await claim()).length,0);
            await rejected(()=>db.exec('UPDATE requirement_harness_decisions SET email_state=$$invalid$$'),'23514');
            await rejected(()=>db.query('UPDATE requirement_harness_decisions SET email_error=$1',['x'.repeat(2001)]),'23514');
          });
          const replay = await rpc({decision:'escalate_support',payload:support,item:null});
          assert.equal(replay.decision.id,receipt.decision.id);
          assert.equal(replay.decision.email_state,'sent'); // Receipt reflects delivery; effects stay original.
          assert.deepEqual(replay.effects,receipt.effects);
          assert.equal((await rows('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',['public.requirement_harness_decisions']))[0].relrowsecurity,true);
          assert.equal((await rows('SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid=$1::regclass AND contype=$2',['public.requirement_harness_decisions','f']))[0].n,2);
        });
        console.log(JSON.stringify(passed));
      } catch (error) {
        console.error([error.message, error.code, error.detail, error.where, error.internalQuery,
          error.query?.slice(Math.max(0, Number(error.position)-150),Number(error.position)+150), error.stack].filter(Boolean).join('\n'));
        process.exitCode = 1;
      } finally { await db.close(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8', timeout: 50_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(child.stderr?.slice(-7000) || child.error?.message || 'Offline PGlite decisions test failed');
    passed = JSON.parse(child.stdout.trim());
  }, 55_000);

  it.each([
    'authoring preserves all guards and original contracts',
    'approval and support are receipts, never completion or execution',
    'tenant and current instance ownership are mandatory',
    'CAS and exact replay prevent stale or conflicting writes',
    'completed, quarantined, and ambiguous items cannot be authored',
    'active cron, manual pause, and other conversation fence changes',
    'adapt rejects active, paused, mixed, and ambiguously bound plans',
    'adapt rewrites only linked instructions on wholly pending owned plans',
    'pending plan updates roll back with later plan or receipt errors',
    'support deduplicates the same snapshot across request IDs without replacing its receipt',
    'acceptance mapping is complete, ordered, typed, and exact',
    'evidence is scoped by requirement or bound instance without conflicts',
    'SQL independently enforces strict keys and payload limits',
    'late SQL errors roll back backlog and durable receipt atomically',
    'service-only RLS and column grants permit delivery CAS, not authoring',
  ])('%s', name => {
    expect(passed).toContain(name);
  });
});