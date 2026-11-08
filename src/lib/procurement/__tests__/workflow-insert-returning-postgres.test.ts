import { asActor, fixture, freshPostgres, ids, instanceId } from './fixtures/workflow-postgres';

const oldMigration = '20261104101000_procurement_workflow_confidentiality.sql';
const newMigration = '20261106110000_procurement_workflow_insert_returning.sql';
const insert = (n: number, site = ids.site, actor = ids.member) =>
  `INSERT INTO public.remote_instances(id,site_id,user_id)
   VALUES('${instanceId(n)}','${site}','${actor}') RETURNING *`;
const tables = ['remote_instances', 'workflow_runs', 'workflow_triggers', 'instance_plans',
  'instance_nodes', 'instance_logs', 'instance_context_state', 'instance_context_memories'];

// This suite deliberately requires real PostgreSQL binaries, not PGlite or a remote URL.
describe('procurement INSERT RETURNING on real PostgreSQL', () => {
  let db: ReturnType<typeof freshPostgres>;
  beforeAll(() => { db = freshPostgres(); db.query(fixture); db.migrate(oldMigration); }, 30000);
  afterAll(() => db?.stop());

  it('reproduces canonical 42501, then fixes the same authenticated INSERT RETURNING', () => {
    const old = db.result(asActor(ids.member, insert(1)));
    expect(old.status).not.toBe(0);
    expect(old.stderr).toMatch(/42501:.*row-level security policy/);
    expect(db.query('SELECT count(*) FROM remote_instances')).toBe('0');
    // VOLATILE PL/pgSQL still cannot see the row during the RETURNING policy check.
    const hypothesis = db.result(`BEGIN;
      CREATE OR REPLACE FUNCTION public.procurement_workflow_rls_read(p_site uuid,p_instance uuid)
      RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
      BEGIN RETURN public.procurement_workflow_instance_can_read(p_site,p_instance,auth.uid()); END $$;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claims='{"sub":"${ids.member}","role":"authenticated"}';
      ${insert(1)}; ROLLBACK;`);
    expect(hypothesis.status).not.toBe(0);
    expect(hypothesis.stderr).toMatch(/42501:.*row-level security policy/);
    // The rejected correction called the revoked helper directly from the policy.
    const rejected = db.result(`BEGIN;
      ALTER POLICY procurement_workflow_read_guard ON remote_instances
        USING(public.site_user_has_effective_access(site_id,auth.uid()));
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claims='{"sub":"${ids.member}","role":"authenticated"}';
      ${insert(1)}; ROLLBACK;`);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/42501:.*permission denied for function site_user_has_effective_access/);
    db.migrate(newMigration);
    expect(db.query(asActor(ids.member, insert(1)))).toContain(instanceId(1));
    expect(db.query(asActor(ids.manager, insert(2, ids.site, ids.manager)))).toContain(instanceId(2));
  });

  it('retains tenant INSERT/SELECT policies and denies fabricated owners', () => {
    for (const [site, actor] of [[ids.otherSite, ids.member], [ids.site, ids.manager]]) {
      const denied = db.result(asActor(ids.member, insert(9, site, actor)));
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toContain('42501');
    }
    db.query(`INSERT INTO remote_instances VALUES('${instanceId(3)}','${ids.otherSite}','${ids.outsider}')`);
    expect(db.query(asActor(ids.member, `SELECT id FROM remote_instances WHERE site_id='${ids.otherSite}'`)))
      .not.toContain(instanceId(3));
    expect(db.query(asActor(ids.outsider, 'SELECT id FROM remote_instances'))).not.toContain(instanceId(1));
  });

  it.each([
    ['single', { table: 'procurement_tenders' }],
    ['array', { db_events: [{ table: 'tasks' }, { table: 'purchase_orders' }] }],
  ])('restricts %s db_event and every derived read to procurement members', (_shape, config) => {
    const n = _shape === 'single' ? 4 : 5;
    const id = instanceId(n);
    db.query(`INSERT INTO remote_instances VALUES('${id}','${ids.site}','${ids.manager}');
      INSERT INTO workflow_triggers VALUES('${id}','${id}','${ids.site}','db_event','${JSON.stringify(config)}');
      INSERT INTO workflow_runs VALUES('${id}','${id}','${ids.site}','{}');
      INSERT INTO instance_plans VALUES('${id}','${id}','${ids.site}','{}');
      INSERT INTO instance_nodes VALUES('${id}','${id}','${ids.site}');
      INSERT INTO instance_logs VALUES('${id}','${id}','${ids.site}');
      INSERT INTO instance_context_state VALUES('${id}','${ids.site}');
      INSERT INTO instance_context_memories VALUES('${id}','${ids.site}');`);
    for (const table of tables) {
      const column = table === 'remote_instances' ? 'id' : 'instance_id';
      const select = `SELECT ${column} FROM ${table} WHERE ${column}='${id}'`;
      expect(db.query(asActor(ids.manager, select))).toContain(id);
      for (const actor of [ids.member, ids.outsider]) {
        expect(db.query(asActor(actor, select))).not.toContain(id);
      }
    }
    // A persisted purchasing run makes classification survive subscription and payload removal.
    db.query(`UPDATE workflow_runs SET payload='{"table":"procurement_tenders"}' WHERE instance_id='${id}';
      DELETE FROM workflow_triggers WHERE instance_id='${id}';
      DELETE FROM workflow_runs WHERE instance_id='${id}';`);
    expect(db.query(`SELECT instance_id FROM procurement_workflow_private_instances WHERE instance_id='${id}'`)).toBe(id);
    for (const table of tables.filter(t => !['workflow_runs', 'workflow_triggers'].includes(t))) {
      const column = table === 'remote_instances' ? 'id' : 'instance_id';
      const select = `SELECT ${column} FROM ${table} WHERE ${column}='${id}'`;
      expect(db.query(asActor(ids.member, select))).not.toContain(id);
      expect(db.query(asActor(ids.manager, select))).toContain(id);
    }
  });

  it('keeps privileged helpers private and binds candidate checks to the caller', () => {
    for (const signature of ['site_user_has_effective_access(uuid,uuid)',
      'procurement_workflow_instance_is_private(uuid)', 'procurement_workflow_instance_can_read(uuid,uuid,uuid)']) {
      expect(db.query(`SELECT has_function_privilege('authenticated','public.${signature}','EXECUTE')`)).toBe('f');
    }
    for (const role of ['anon', 'service_role']) {
      expect(db.query(`SELECT has_function_privilege('${role}',
        'public.procurement_workflow_candidate_can_read(uuid,uuid)','EXECUTE')`)).toBe('f');
    }
    const denied = db.result(asActor(ids.member,
      `SELECT procurement_workflow_instance_is_private('${instanceId(4)}')`));
    expect(denied.stderr).toMatch(/42501:.*permission denied/);
    expect(db.query(asActor(ids.outsider,
      `SELECT procurement_workflow_candidate_can_read('${ids.site}','${instanceId(99)}')`))).toMatch(/\nf\n/);
    expect(db.query(`SET ROLE authenticated;
      SELECT procurement_workflow_candidate_can_read('${ids.site}','${instanceId(99)}')`)).toBe('SET\nf');
    expect(db.query(asActor(ids.member,
      `SELECT procurement_workflow_candidate_can_read(NULL,'${instanceId(1)}'),
        procurement_workflow_candidate_can_read('${ids.site}',NULL)`))).toMatch(/\nf\|f\n/);
    expect(db.query(`SET ROLE service_role;
      SELECT procurement_workflow_instance_can_read('${ids.site}','${instanceId(1)}','${ids.outsider}')`)).toBe('SET\nf');
  });

  it('keeps direct RPC missing-ID and wrong-site checks fail closed', () => {
    expect(db.query(asActor(ids.member,
      `SELECT procurement_workflow_rls_read('${ids.site}','${instanceId(99)}')`))).toMatch(/\nf\n/);
    expect(db.query(`SET ROLE service_role;
      SELECT procurement_workflow_instance_can_read('${ids.site}','${instanceId(99)}','${ids.manager}');
      SELECT procurement_workflow_instance_can_read('${ids.otherSite}','${instanceId(1)}','${ids.member}');`))
      .toBe('SET\nf\nf');
  });
});
