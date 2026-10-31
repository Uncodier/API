/** Offline adapter-boundary tests, NOT substitutes for canonical domain tests.
 * Real dispatch SQL and Postgres roles/claims/queries run in PGlite. Canonical
 * workflow RPCs are explicit recording stubs: lifecycle/policy evaluation is
 * owned by market-fit's domain migrations and tested separately there.
 */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20261031010000_procurement_mcp_bridge.sql'), 'utf8');
const site = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const id = '30000000-0000-4000-8000-000000000001';
const stage = '40000000-0000-4000-8000-000000000001';
const policy = { version: 1, settings: { supervisorId: null, substituteIds: [], rejectionNotifications: { recipientIds: [] }, fallback: { mode: 'none' } }, rules: [] };
const plan = { status: 'ready', stages: [], requirements: [], minimumSupplierProposals: null };

const schema = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),current_setting('request.jwt.claims',true)::jsonb->>'role') $$;
CREATE TABLE sites(id uuid,user_id uuid);
CREATE TABLE site_members(site_id uuid,user_id uuid,status text,license_suspended boolean,manually_disabled boolean);
CREATE TABLE catalog_items(id uuid,site_id uuid,category_id uuid);
CREATE TABLE catalog_categories(id uuid,site_id uuid);
CREATE TABLE agents(id uuid,site_id uuid);
CREATE TABLE procurement_policy_versions(site_id uuid,revision int,document jsonb);
CREATE TABLE procurement_requests(id uuid,site_id uuid,revision int,title text,status text,currency text,net_amount_minor bigint,requester_id uuid,updated_at timestamptz DEFAULT now());
CREATE TABLE procurement_request_items(id uuid,request_id uuid,revision int,position int,catalog_item_id uuid,category_ids jsonb,valuation_source text,unit_net_minor bigint,net_amount_minor bigint,tax_snapshot jsonb);
CREATE TABLE procurement_request_stages(id uuid,request_id uuid,revision int,position int,definition jsonb,status text);
CREATE TABLE procurement_request_decisions(id uuid,stage_id uuid,actor_id uuid,decision text,created_at timestamptz DEFAULT now());
CREATE TABLE procurement_tenders(id uuid,site_id uuid,version int,title text,status text,currency text,net_amount_minor bigint,requirements jsonb,updated_at timestamptz DEFAULT now());
CREATE TABLE procurement_tender_publications(id uuid,site_id uuid,tender_id uuid,version int);
CREATE TABLE procurement_tender_participants(id uuid,site_id uuid,tender_id uuid);
CREATE TABLE procurement_event_approvals(id uuid,site_id uuid,target_id uuid,event text,status text,target_version int DEFAULT 1,actor_id uuid,plan jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE procurement_awards(id uuid,site_id uuid,approval_id uuid,quotation_id uuid);
CREATE TABLE purchase_orders(id uuid,site_id uuid,approval_id uuid,award_id uuid);
CREATE TABLE procurement_event_stages(id uuid,approval_id uuid,position int,definition jsonb,status text);
CREATE TABLE procurement_event_decisions(id uuid,stage_id uuid,actor_id uuid,decision text,created_at timestamptz DEFAULT now());
CREATE TABLE calls(name text,args jsonb,actor uuid,role text);
CREATE FUNCTION current_user_site_role(uuid) RETURNS text LANGUAGE sql AS $$ SELECT CASE WHEN auth.uid()='${actor}'::uuid THEN 'owner' ELSE 'member' END $$;
CREATE FUNCTION current_user_has_site_location_restrictions(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT COALESCE(NULLIF(current_setting('test.restricted',true),''),'false')::boolean $$;
CREATE FUNCTION procurement_tender_access(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${site}'::uuid AND COALESCE(NULLIF(current_setting('test.denied',true),''),'')<>$2 $$;
`;

// Intentionally fixed canonical signatures: never derive executable names from
// caller/model input. These only record argument forwarding and actor identity.
const stubs: [string, string, string][] = [
  ['save_procurement_request', 'uuid,uuid,integer,jsonb', 'uuid'],
  ['revalidate_procurement_request', 'uuid,uuid,integer', 'uuid'],
  ['decide_procurement_request', 'uuid,uuid,integer,uuid,text,text', 'uuid'],
  ['submit_procurement_request', 'uuid,uuid,integer,integer,uuid,jsonb', 'uuid'],
  ['save_procurement_tender', 'uuid,uuid,integer,jsonb', 'uuid'],
  ['transition_procurement_tender', 'uuid,uuid,integer,text', 'void'],
  ['set_procurement_tender_participant', 'uuid,uuid,integer,uuid,text', 'uuid'],
  ['configure_procurement_tender_portal', 'uuid,boolean', 'text'],
  ['create_procurement_event_approval', 'uuid,uuid,integer,text,uuid,integer,jsonb', 'uuid'],
  ['create_procurement_commerce_approval', 'uuid,uuid,integer,text,uuid,integer,jsonb', 'uuid'],
  ['decide_procurement_event', 'uuid,uuid,uuid,text,text', 'uuid'],
  ['procurement_inherited_policy', 'uuid,uuid,text', 'jsonb'],
  ['procurement_commerce_event_context', 'uuid,uuid,integer,text', 'jsonb'],
  ['list_procurement_quotations', 'uuid', 'jsonb'],
  ['list_procurement_quotation_envelopes', 'uuid', 'jsonb'],
  ['get_procurement_quotation', 'uuid,uuid', 'jsonb'],
  ['procurement_quotation_options', 'uuid', 'jsonb'],
  ['record_procurement_quotation', 'uuid,jsonb', 'uuid'],
  ['list_procurement_orders', 'uuid', 'jsonb'],
  ['record_procurement_receipt', 'uuid,jsonb', 'uuid'],
];
const downstream = { inherited_requirements: [], minimum_supplier_proposals: 0, supplier_proposals: 2,
  currency: 'USD', net_amount_minor: 10, lines: [{ id, productId: null, categoryIds: [], netAmountMinor: 10 }] };
const stubSql = stubs.map(([name, types, returns]) => {
  const args = types.split(',').map((_, i) => `$${i + 1}`).join(',');
  const value = returns === 'void' ? '' : returns === 'uuid' ? `'${id}'::uuid`
    : returns === 'text' ? "'test-portal'" : name.includes('context') || name.includes('inherited')
      ? `'${JSON.stringify(downstream)}'::jsonb` : `jsonb_build_object('canonical','${name}')`;
  return `CREATE FUNCTION public.${name}(${types}) RETURNS ${returns} LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO public.calls VALUES('${name}',jsonb_build_array(${args}),auth.uid(),auth.role());
    IF current_setting('test.canonical_error',true)='true' THEN RAISE EXCEPTION 'canonical denied' USING ERRCODE='42501'; END IF;
    IF '${name}'='decide_procurement_event' AND current_setting('test.reauthorize_initiator',true)='true' THEN
      -- Mirror canonical finalizers: switch JSON claims, not individual GUCs.
      PERFORM set_config('request.jwt.claims','{"sub":"${other}","role":"authenticated"}',true);
      IF public.current_user_site_role($1) NOT IN ('owner','admin') THEN
        RAISE EXCEPTION 'original initiator revoked' USING ERRCODE='42501'; END IF;
    END IF;
    ${name === 'procurement_commerce_event_context' ? `IF current_setting('test.catalog',true)='true' THEN
      RETURN '${JSON.stringify(downstream)}'::jsonb || jsonb_build_object('lines',
        (SELECT jsonb_agg(jsonb_build_object('id',id,'productId',id,'categoryIds',jsonb_build_array(category_id),'netAmountMinor',10) ORDER BY id) FROM public.catalog_items));
    END IF;` : ''}
    RETURN ${value}; END $$;`;
}).join('\n');

describe('procurement MCP SQL bridge (offline boundary fixtures)', () => {
  let db: PGlite;
  beforeAll(async () => {
    // PGlite dynamically imports node builtins; run it outside Jest's CommonJS
    // VM in an in-process worker, without experimental flags or a DB server.
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      const { PGlite } = require(${JSON.stringify(require.resolve('@electric-sql/pglite'))});
      const db = new PGlite();
      parentPort.on('message', async ({method,args}) => {
        try { parentPort.postMessage({ result: await db[method](...args) }); }
        catch (error) { parentPort.postMessage({ error: error.message }); }
      });
    `, { eval: true });
    const invoke = (method: string, args: unknown[]) => new Promise((resolve, reject) => {
      worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.result));
      worker.postMessage({ method, args });
    });
    db = { exec: (...args: unknown[]) => invoke('exec', args), query: (...args: unknown[]) => invoke('query', args),
      close: async () => { await invoke('close', []); await worker.terminate(); } } as unknown as PGlite;
    await db.exec(schema + stubSql);
    await db.exec(migration);
    await db.query('INSERT INTO sites VALUES($1,$2)', [site, actor]);
    await db.query('INSERT INTO procurement_policy_versions VALUES($1,1,$2)', [site, policy]);
    await db.query("INSERT INTO procurement_requests(id,site_id,revision,title,status,currency,net_amount_minor,requester_id) VALUES($1,$2,1,'Draft request','draft','USD',10,$3)", [id, site, other]);
    await db.query("INSERT INTO procurement_request_items VALUES($1,$1,1,0,NULL,'[]','manager_estimate',10,10,'[]')", [id]);
    await db.query("INSERT INTO procurement_tenders(id,site_id,version,title,status,currency,net_amount_minor,requirements) VALUES($1,$2,1,'Draft tender','draft','USD',10,$3)", [id, site, [{ id, catalog_item_id: null, quantity: 1, unit_net_minor: 10 }]]);
    await db.query("INSERT INTO procurement_event_approvals(id,site_id,target_id,event,status) VALUES($1,$2,$1,'publication','pending')", [id, site]);
    await db.query("INSERT INTO procurement_request_stages VALUES($1,$2,1,0,'{}','pending');", [stage, id]);
    await db.query("INSERT INTO procurement_event_stages VALUES($1,$2,0,'{}','pending');", [stage, id]);
    await db.query("INSERT INTO procurement_event_decisions(id,stage_id,actor_id,decision) VALUES($1,$2,$3,'approve')", [id, stage, actor]);
    await db.query('INSERT INTO procurement_awards(id,site_id,approval_id) VALUES($1,$2,$3)', [other, site, id]);
  }, 60000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec(`RESET ROLE; TRUNCATE calls, catalog_items, procurement_event_decisions; SET test.catalog='false'; SET test.restricted='false'; SET test.denied=''; SET test.canonical_error='false'; SET test.reauthorize_initiator='false';`);
    await db.query("UPDATE procurement_event_approvals SET status='pending',event='publication',actor_id=$1,plan='{}'", [actor]);
    await db.query("INSERT INTO procurement_event_decisions(id,stage_id,actor_id,decision) VALUES($1,$2,$3,'approve')", [id, stage, actor]);
    await db.query('UPDATE procurement_tenders SET requirements=$1', [[{ id, catalog_item_id: null, quantity: 1, unit_net_minor: 10 }]]);
    await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.sub',$2,false),set_config('request.jwt.claim.role','service_role',false)", [JSON.stringify({ sub: other, role: 'service_role', marker: 'original' }), other]);
    await db.exec('SET ROLE service_role');
  });
  const call = async (operation: string, args: object = {}, user = actor, tenant = site) =>
    (await db.query<{ result: any }>('SELECT public.procurement_mcp_dispatch($1,$2,$3,$4) AS result', [tenant, user, operation, args])).rows[0].result;
  const claims = async () => (await db.query("SELECT current_setting('request.jwt.claims') AS claims,current_setting('request.jwt.claim.sub') AS sub,current_setting('request.jwt.claim.role') AS role")).rows[0];

  test('service role only, not a JWT-spoofing owner or public/authenticated caller', async () => {
    await db.exec('RESET ROLE');
    await expect(call('policy.get')).rejects.toThrow('requires service_role');
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await expect(call('policy.get')).rejects.toThrow('permission denied');
    }
    await db.exec('SET ROLE service_role');
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',false)");
    await expect(call('policy.get')).rejects.toThrow('requires service_role');
  });
  test('restores all claims after success, permission errors, and canonical exceptions', async () => {
    const before = await claims();
    expect(await call('requests.save', { expected_revision: 0, document: {} })).toEqual({ id });
    expect(await claims()).toEqual(before);
    await expect(call('requests.list', {}, other)).rejects.toThrow('manager access denied');
    expect(await claims()).toEqual(before);
    await db.exec("SET test.canonical_error='true'");
    await expect(call('orders.list')).rejects.toThrow('canonical denied');
    expect(await claims()).toEqual(before);
  });
  test('manager gate uses scoped select/update, unrestricted locations and tenant', async () => {
    await expect(call('requests.list', {}, actor, other)).rejects.toThrow('manager access denied');
    await db.exec("SET test.restricted='true'");
    await expect(call('requests.list')).rejects.toThrow('manager access denied');
    await db.exec("SET test.restricted='false'; SET test.denied='update'");
    expect(await call('requests.list')).toHaveLength(1);
    await expect(call('requests.save', { expected_revision: 0, document: {} })).rejects.toThrow('manager access denied');
  });
  test('nested canonical finalizers reauthorize original initiator, not deciding actor', async () => {
    const before = await claims();
    await db.exec("SET test.reauthorize_initiator='true'");
    await expect(call('approvals.decide', { id, stage_id: stage, decision: 'approve', reason: 'Reviewed' })).rejects.toThrow('original initiator revoked');
    expect(await claims()).toEqual(before);
  });
  test('rejects unknown operations, injected arguments and unbounded pagination', async () => {
    for (const op of ['pg_sleep', 'requests.list;SELECT 1', 'policy.save']) await expect(call(op)).rejects.toThrow('Unknown procurement operation');
    for (const args of [{ action: 'list' }, { thought_process: 'not persisted' }, { site_id: other }, { limit: 101 }, { offset: 10001 }]) await expect(call('requests.list', args)).rejects.toThrow();
    await expect(call('requests.get', {})).rejects.toThrow('Invalid procurement arguments');
  });
  test('direct lists and detail reads expose subordinate IDs only within site', async () => {
    for (const op of ['requests.list', 'tenders.list', 'approvals.list']) {
      expect(await call(op, { limit: 1, offset: 0 })).toHaveLength(1);
      expect(await call(op, { offset: 1 })).toEqual([]);
    }
    expect((await call('requests.get', { id })).stages[0].id).toBe(stage);
    expect((await call('approvals.get', { id })).stages[0].decisions[0].actor_id).toBe(actor);
    expect((await call('approvals.get', { id })).result.award_id).toBe(other);
    expect((await call('tenders.get', { id })).approvals[0].id).toBe(id);
    await expect(call('requests.get', { id: other })).rejects.toThrow('target not found');
  });
  test('trusted contexts use stored requester/prices, exact versions and inherited data', async () => {
    const req = await call('context.requisition', { id, expected_revision: 1 });
    expect(req).toMatchObject({ actor_id: actor, requester_id: other, target_id: id, target_version: 1, net_amount_minor: 10, policy: { revision: 1, document: policy } });
    expect(req.lines).toEqual([{ id, productId: null, categoryIds: [], netAmountMinor: 10 }]);
    expect(await call('context.publication', { id, expected_version: 1 })).toMatchObject({ supplier_proposals: 0, inherited_requirements: [], minimum_supplier_proposals: 0 });
    for (const event of ['award', 'order']) expect(await call(`context.${event}`, { target_id: id, expected_version: 1, event })).toMatchObject({ ...downstream, actor_id: actor, requester_id: actor });
    await expect(call('context.requisition', { id, expected_revision: 2 })).rejects.toThrow('conflict');
    await expect(call('context.publication', { id, expected_version: 2 })).rejects.toThrow('conflict');
  });
  test('blocks JSON-null taxes, unpriced/nondraft requests and repeats checks at submit', async () => {
    await db.exec("RESET ROLE; UPDATE procurement_request_items SET tax_snapshot='null'; SET ROLE service_role");
    for (const operation of ['context.requisition', 'requests.submit']) await expect(call(operation, { id, expected_revision: 1, ...(operation.endsWith('submit') ? { policy_revision: 1, plan, expected_context: {} } : {}) })).rejects.toThrow('Unpriced request');
    await db.exec("RESET ROLE; UPDATE procurement_request_items SET tax_snapshot='[]',valuation_source='unpriced'; SET ROLE service_role");
    await expect(call('context.requisition', { id, expected_revision: 1 })).rejects.toThrow('Unpriced request');
    await db.exec("RESET ROLE; UPDATE procurement_request_items SET valuation_source='manager_estimate'; UPDATE procurement_requests SET status='approved'; SET ROLE service_role");
    await expect(call('context.requisition', { id, expected_revision: 1 })).rejects.toThrow('conflict');
    await db.exec("RESET ROLE; UPDATE procurement_requests SET status='draft'; SET ROLE service_role");
  });
  test('saved references revalidated at persistence, archived references retained', async () => {
    expect(await call('policy.references', { policy_revision: 1 })).toEqual({ valid: true });
    await expect(call('policy.references', { policy_revision: 2 })).rejects.toThrow('Policy revision conflict');
    await db.exec('RESET ROLE');
    await db.query('UPDATE procurement_policy_versions SET document=$1', [{ ...policy, settings: { ...policy.settings, supervisorId: other } }]);
    await db.exec('SET ROLE service_role');
    for (const [op, args] of [['policy.references', { policy_revision: 1 }], ['requests.submit', { id, expected_revision: 1, policy_revision: 1, plan, expected_context: {} }]] as const) await expect(call(op, args)).rejects.toThrow('references no longer eligible');
    await db.exec('RESET ROLE');
    await db.query('UPDATE procurement_policy_versions SET document=$1', [{ ...policy, rules: [{ status: 'archived', scope: { productIds: [other] } }] }]);
    await db.exec('SET ROLE service_role');
    expect(await call('policy.references', { policy_revision: 1 })).toEqual({ valid: true });
    await db.exec('RESET ROLE'); await db.query('UPDATE procurement_policy_versions SET document=$1', [policy]); await db.exec('SET ROLE service_role');
  });
  test.each([
    ['requests.save', { expected_revision: 0, document: {} }, 'save_procurement_request'],
    ['requests.revalidate', { id, expected_revision: 1 }, 'revalidate_procurement_request'],
    ['requests.decide', { id, expected_revision: 1, stage_id: stage, decision: 'approve', reason: 'Reviewed' }, 'decide_procurement_request'],
    ['requests.submit', { id, expected_revision: 1, policy_revision: 1, plan }, 'submit_procurement_request'],
    ['tenders.save', { expected_version: 0, document: {} }, 'save_procurement_tender'],
    ['tenders.transition', { id, expected_version: 1, transition: 'close' }, 'transition_procurement_tender'],
    ['tenders.participant', { id, expected_version: 1, supplier_id: other, status: 'invited' }, 'set_procurement_tender_participant'],
    ['tenders.portal', { enabled: true }, 'configure_procurement_tender_portal'],
    ['tenders.publish', { id, expected_version: 1, policy_revision: 1, plan }, 'create_procurement_event_approval'],
    ['quotations.record', { document: {} }, 'record_procurement_quotation'],
    ['quotations.get', { id }, 'get_procurement_quotation'],
    ['quotations.options', {}, 'procurement_quotation_options'],
    ['orders.list', {}, 'list_procurement_orders'],
    ['orders.receive', { document: {} }, 'record_procurement_receipt'],
    ['approvals.decide', { id, stage_id: stage, decision: 'approve', reason: 'Reviewed' }, 'decide_procurement_event'],
    ['approvals.create', { target_id: id, expected_version: 1, event: 'award', policy_revision: 1, plan }, 'create_procurement_commerce_approval'],
  ])('%s forwards fixed canonical signature under bound actor', async (op, args, name) => {
    const contexts: Record<string, [string, object]> = {
      'requests.submit': ['context.requisition', { id, expected_revision: 1 }],
      'tenders.publish': ['context.publication', { id, expected_version: 1 }],
      'approvals.create': ['context.award', { target_id: id, expected_version: 1, event: 'award' }],
    };
    const prepared = contexts[op as string];
    await call(op as string, prepared ? { ...args, expected_context: await call(...prepared) } : args as object);
    await db.exec('RESET ROLE');
    const rows = (await db.query<{ args: unknown[]; actor: string; role: string }>('SELECT * FROM calls WHERE name=$1', [name])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor, role: 'authenticated' });
    expect(rows[0].args[0]).toBe(site);
  });
  test('quotation list delegates exclusively to both sealed-safe canonical projections', async () => {
    expect(await call('quotations.list')).toEqual({ quotations: { canonical: 'list_procurement_quotations' }, envelopes: { canonical: 'list_procurement_quotation_envelopes' } });
    expect(migration).not.toMatch(/FROM public\.(?:quotations|quotation_items)\b/i);
  });
  test('private reference helper is not executable by service role', async () => {
    await expect(db.query('SELECT public.procurement_mcp_policy_references($1,$2)', [site, policy])).rejects.toThrow('permission denied');
  });
  const workflows = [
    ['requests.submit', 'context.requisition', { id, expected_revision: 1 }, 'submit_procurement_request'],
    ['tenders.publish', 'context.publication', { id, expected_version: 1 }, 'create_procurement_event_approval'],
    ['approvals.create', 'context.award', { target_id: id, expected_version: 1, event: 'award' }, 'create_procurement_commerce_approval'],
    ['approvals.create', 'context.order', { target_id: id, expected_version: 1, event: 'order' }, 'create_procurement_commerce_approval'],
  ] as const;
  test.each(workflows)('%s / %s requires exact full evaluated context before persistence', async (operation, contextOp, args, canonical) => {
    const expected_context = await call(contextOp, args);
    const commit = { ...args, policy_revision: 1, plan };
    await expect(call(operation, commit)).rejects.toThrow('Invalid procurement arguments');
    for (const forged of [null, {}, { ...expected_context, actor_id: other }, { ...expected_context, target_id: other },
      { ...expected_context, target_version: 2 }, { ...expected_context, policy: { revision: 1, document: {} } },
      { ...expected_context, lines: [] }]) {
      await expect(call(operation, { ...commit, expected_context: forged })).rejects.toThrow();
    }
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT * FROM calls WHERE name=$1', [canonical])).rows).toHaveLength(0);
    await db.exec('SET ROLE service_role');
    await call(operation, { ...commit, expected_context, plan: { ...plan, mcp_context: { forged: true } } });
    await db.exec('RESET ROLE');
    const rows = (await db.query<{ args: any[] }>('SELECT args FROM calls WHERE name=$1', [canonical])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].args.at(-1)).toEqual({ ...plan, mcp_context: expected_context });
  });
  const useCatalog = async () => {
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO catalog_items VALUES($1,$2,$3)', [id, site, actor]);
    await db.query('UPDATE procurement_tenders SET requirements=$1', [[{ id, catalog_item_id: id, quantity: 1, unit_net_minor: 10 }]]);
    await db.exec("SET test.catalog='true'; SET ROLE service_role");
  };
  const mutateCategory = async () => {
    await db.exec('RESET ROLE');
    await db.query('UPDATE catalog_items SET category_id=$1', [other]);
    await db.exec('SET ROLE service_role');
  };
  test.each(workflows.slice(1))('%s / %s rejects live category changes with identical target/policy versions', async (operation, contextOp, args, canonical) => {
    await useCatalog();
    const expected_context = await call(contextOp, args);
    expect(expected_context.lines[0].categoryIds).toEqual([actor]);
    await mutateCategory();
    const current = await call(contextOp, args);
    expect(current).toMatchObject({ target_version: expected_context.target_version, policy: expected_context.policy });
    expect(current.lines[0].categoryIds).toEqual([other]);
    await expect(call(operation, { ...args, policy_revision: 1, plan, expected_context })).rejects.toThrow('evaluated context changed');
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT * FROM calls WHERE name=$1', [canonical])).rows).toHaveLength(0);
  });
  test.each(['publication', 'award', 'order'])('pending %s approvals retain their original context across deciders', async event => {
    await useCatalog();
    const expected_context = await call(`context.${event}`, event === 'publication'
      ? { id, expected_version: 1 } : { target_id: id, expected_version: 1, event });
    // Original requester can differ from deciding manager; metadata alone must
    // not cause a stale-context error. Canonical finalizer reauthorizes them.
    expected_context.actor_id = other; expected_context.requester_id = other;
    await db.exec('RESET ROLE; TRUNCATE procurement_event_decisions');
    await db.query('UPDATE procurement_event_approvals SET actor_id=$1,event=$2,plan=$3', [other, event, { ...plan, mcp_context: expected_context }]);
    await db.exec('SET ROLE service_role');
    const decision = { id, stage_id: stage, decision: 'approve', reason: 'Reviewed' };
    expect(await call('approvals.decide', decision)).toEqual({ id });
    await db.exec('RESET ROLE; TRUNCATE calls; SET ROLE service_role');
    await mutateCategory();
    const before = await claims();
    await expect(call('approvals.decide', decision)).rejects.toThrow('evaluated context changed');
    expect(await claims()).toEqual(before);
    await db.exec('RESET ROLE');
    expect((await db.query("SELECT * FROM calls WHERE name='decide_procurement_event'")).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM procurement_event_decisions')).rows).toHaveLength(0);
    expect((await db.query('SELECT status FROM procurement_event_approvals')).rows[0]).toEqual({ status: 'pending' });
    await db.exec('SET ROLE service_role');
    expect(await call('approvals.decide', { ...decision, decision: 'reject' })).toEqual({ id });
  });
  test('missing pending snapshot fails closed; existing-vote and finalized replays remain canonical', async () => {
    const decision = { id, stage_id: stage, decision: 'approve', reason: 'Reviewed' };
    // Existing vote bypasses context validation, not canonical replay authorization.
    expect(await call('approvals.decide', decision)).toEqual({ id });
    await db.exec('RESET ROLE; TRUNCATE procurement_event_decisions; SET ROLE service_role');
    await expect(call('approvals.decide', decision)).rejects.toThrow('context missing');
    expect(await call('approvals.decide', { ...decision, decision: 'reject' })).toEqual({ id });
    await db.exec("RESET ROLE; UPDATE procurement_event_approvals SET status='approved',event='order'; TRUNCATE calls; SET ROLE service_role");
    expect(await call('approvals.decide', decision)).toEqual({ id });
    await db.exec('RESET ROLE');
    expect((await db.query("SELECT * FROM calls WHERE name='procurement_commerce_event_context'")).rows).toHaveLength(0);
    // Domain replay/reason/eligibility semantics remain its responsibility.
    await db.exec("SET test.canonical_error='true'; SET ROLE service_role");
    await expect(call('approvals.decide', decision)).rejects.toThrow('canonical denied');
  });
  test.each(['effectiveFrom', 'effectiveUntil'])('DB clock token detects %s crossings at commit and pending approve', async bound => {
    await db.exec('RESET ROLE');
    // No host-clock dependency: arrange a boundary in the same DB clock used by SQL.
    await db.query(`UPDATE procurement_policy_versions SET document=jsonb_set(document,'{rules}',
      jsonb_build_array(jsonb_build_object('id','window-rule','event','publication','status','active',$1::text,
        date_trunc('milliseconds',clock_timestamp())+interval '300 milliseconds')))`, [bound]);
    await db.exec('SET ROLE service_role');
    try {
      const expected_context = await call('context.publication', { id, expected_version: 1 });
      expect(expected_context.policy_active_rule_ids).toEqual(bound === 'effectiveFrom' ? [] : ['window-rule']);
      expect(Number.isFinite(Date.parse(expected_context.evaluated_at))).toBe(true);
      await db.exec('RESET ROLE; TRUNCATE procurement_event_decisions');
      await db.query('UPDATE procurement_event_approvals SET plan=$1', [{ ...plan, mcp_context: expected_context }]);
      await db.exec('SET ROLE service_role');
      await new Promise(resolve => setTimeout(resolve, 350));
      const current = await call('context.publication', { id, expected_version: 1 });
      expect(current.policy).toEqual(expected_context.policy);
      expect(current.policy_active_rule_ids).toEqual(bound === 'effectiveFrom' ? ['window-rule'] : []);
      await expect(call('tenders.publish', { id, expected_version: 1, policy_revision: 1, plan, expected_context })).rejects.toThrow('evaluated context changed');
      await expect(call('approvals.decide', { id, stage_id: stage, decision: 'approve', reason: 'Reviewed' })).rejects.toThrow('evaluated context changed');
      await db.exec('RESET ROLE');
      expect((await db.query("SELECT * FROM calls WHERE name IN ('create_procurement_event_approval','decide_procurement_event')")).rows).toHaveLength(0);
    } finally {
      await db.exec('RESET ROLE');
      await db.query('UPDATE procurement_policy_versions SET document=$1', [policy]);
      await db.exec('SET ROLE service_role');
    }
  });
  test.each(['award', 'order'])('approved %s reapproval returns existing artifact from its canonical target', async event => {
    const table = event === 'award' ? 'procurement_awards' : 'purchase_orders';
    const targetColumn = event === 'award' ? 'quotation_id' : 'award_id';
    await db.exec('RESET ROLE');
    await db.query(`INSERT INTO ${table}(id,site_id,approval_id,${targetColumn}) VALUES($1,$2,$3,$4)`, [stage, site, other, other]);
    await db.query('UPDATE procurement_event_approvals SET event=$1,target_id=$2', [event, other]);
    await db.exec('SET ROLE service_role');
    try {
      expect((await call('approvals.get', { id })).result[`${event}_id`]).not.toBe(stage);
      await db.exec("RESET ROLE; UPDATE procurement_event_approvals SET status='approved'; SET ROLE service_role");
      // Remove unrelated fixture approval-id match to exercise canonical fallback.
      await db.exec('RESET ROLE');
      await db.query('UPDATE procurement_awards SET approval_id=NULL WHERE id=$1', [other]);
      await db.exec('SET ROLE service_role');
      expect((await call('approvals.get', { id })).result[`${event}_id`]).toBe(stage);
    } finally {
      await db.exec('RESET ROLE');
      await db.query(`DELETE FROM ${table} WHERE id=$1`, [stage]);
      await db.query('UPDATE procurement_event_approvals SET target_id=$1', [id]);
      await db.query('UPDATE procurement_awards SET approval_id=$1 WHERE id=$2', [id, other]);
      await db.exec('SET ROLE service_role');
    }
  });
  test('installation fails closed when a required canonical dependency is missing', async () => {
    await db.exec('RESET ROLE; ALTER FUNCTION public.get_procurement_quotation(uuid,uuid) RENAME TO hidden_quotation_dependency');
    await expect(db.exec(migration)).rejects.toThrow('Procurement MCP dependency missing: public.get_procurement_quotation');
    await db.exec('ROLLBACK; ALTER FUNCTION public.hidden_quotation_dependency(uuid,uuid) RENAME TO get_procurement_quotation');
  });
});