import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freshPostgres } from '@/lib/procurement/__tests__/fixtures/workflow-postgres';

const migration = (name: string) => readFileSync(resolve('supabase/migrations', name), 'utf8');
function sqlFunction(sql: string, name: string) {
  const definition = sql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${name.replace('.', '\\.')}\\([\\s\\S]*?\\$\\$;`))?.[0];
  if (!definition) throw new Error(`Missing SQL function ${name}`);
  return definition;
}

it('releases facts against the active claim and real parent RLS, without creating or consuming a report', () => {
  const db = freshPostgres();
  const [claim, owner, site, instance, agent, action, nextAction, connector, attempt] = Array.from({length:9}, () => randomUUID());
  const digest = randomBytes(32).toString('hex');
  const release = `SELECT public.confirm_connector_result_release('${claim}');`;
  const asService = (sql: string) => `SET ROLE service_role; ${sql}`;
  function denied(sql: string) {
    const result = db.result(sql);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('42501');
  }
  const receipts = migration('20261123020000_connector_direct_receipts.sql');
  const accountReceipts = migration('20261123151000_connector_account_receipts.sql');
  try {
    // Load the actual claim locks, final dispatch guard and RLS trigger. The
    // upstream connector admission joins are represented by a synthetic grant.
    db.query(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE connector_result_reader NOLOGIN;
      GRANT authenticated TO service_role;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt()->>'role' $$;
      CREATE SCHEMA connector_result_private;
      REVOKE ALL ON SCHEMA connector_result_private FROM PUBLIC,anon,authenticated,service_role;
      CREATE SCHEMA connector_direct_rpc;
      REVOKE ALL ON SCHEMA connector_direct_rpc FROM PUBLIC,anon,authenticated;
      GRANT USAGE ON SCHEMA connector_direct_rpc TO service_role;
      CREATE TABLE public.remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid,visible boolean);
      ALTER TABLE public.remote_instances ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.remote_instances TO authenticated;
      CREATE POLICY fixture_owner_visibility ON public.remote_instances FOR SELECT TO authenticated
        USING (user_id=auth.uid() AND visible);
      CREATE TABLE public.instance_logs(id uuid PRIMARY KEY,site_id uuid,user_id uuid,instance_id uuid,
        agent_id uuid,log_type text,trusted_user_action boolean,details jsonb);
      CREATE TABLE public.site_connector_auth_attempts(id uuid,site_id uuid,connector_id uuid,status text);
      CREATE TABLE public.connectors(id uuid,site_id uuid,revision int);
      CREATE TABLE public.connector_members(site_id uuid,connector_id uuid,user_id uuid,expires_at timestamptz);
      CREATE TABLE connector_result_private.direct_ask_submissions(action_id uuid PRIMARY KEY);
      CREATE TABLE connector_result_private.direct_turn_heads(instance_id uuid PRIMARY KEY,site_id uuid,action_id uuid,admission_snapshot pg_snapshot);
      CREATE TABLE connector_result_private.direct_revisions(connector_id uuid PRIMARY KEY,direct_revision int,authority_xid xid8);
      CREATE TABLE connector_result_private.direct_attestations(id uuid,site_id uuid,connector_id uuid,revoked_at timestamptz);
      CREATE TABLE connector_result_private.direct_claims(id uuid PRIMARY KEY,request_id uuid REFERENCES public.instance_logs ON DELETE CASCADE,
        site_id uuid,owner_id uuid,instance_id uuid,agent_id uuid,connector_id uuid,authorization_id uuid,attestation_id uuid,
        connector_revision int,policy_revision int,direct_revision int,claimed_at timestamptz,consumed_at timestamptz);
      CREATE TABLE connector_result_private.reports(id uuid PRIMARY KEY);
      CREATE TABLE connector_result_private.fixture_grants(connector_id uuid,policy_revision int,enabled boolean);
      CREATE FUNCTION connector_result_private.account_claim_admitted(c connector_result_private.direct_claims)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (
        SELECT FROM connector_result_private.fixture_grants g WHERE (g.connector_id,g.policy_revision)=(c.connector_id,c.policy_revision) AND g.enabled) $$;
      CREATE FUNCTION connector_result_private.check_direct_authority(c connector_result_private.direct_claims)
      RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE insufficient_privilege; END $$;
      ${sqlFunction(accountReceipts, 'connector_result_private.lock_direct_write')}
      ${sqlFunction(accountReceipts, 'connector_result_private.check_dispatch_authority')}
      ${sqlFunction(receipts, 'connector_result_private.authorize_direct_parent')}
      INSERT INTO public.remote_instances VALUES ('${instance}','${site}','${owner}',true);
      INSERT INTO public.instance_logs VALUES ('${action}','${site}','${owner}','${instance}','${agent}','user_action',true,
        '{"ask_request_sha256":"${digest}","status":"running","assistant_recovery":{"version":1,"respawnCount":0,"inFlight":true,
        "inFlightKind":"turn","execution":{"catalogUserSession":true,"callerSource":"interactive","executionMode":"direct"}}}');
      INSERT INTO public.site_connector_auth_attempts VALUES ('${attempt}','${site}','${connector}','completed');
      INSERT INTO public.connectors VALUES ('${connector}','${site}',1);
      INSERT INTO connector_result_private.direct_ask_submissions VALUES ('${action}');
      INSERT INTO connector_result_private.direct_revisions VALUES ('${connector}',1,pg_current_xact_id());
      INSERT INTO connector_result_private.fixture_grants VALUES ('${connector}',1,true);
      INSERT INTO connector_result_private.direct_claims VALUES ('${claim}','${action}','${site}','${owner}','${instance}','${agent}',
        '${connector}','${attempt}',NULL,1,1,1,clock_timestamp(),NULL);
    `);
    db.query(`INSERT INTO connector_result_private.direct_turn_heads VALUES ('${instance}','${site}','${action}',pg_current_snapshot());`);
    db.migrate('20261123172000_connector_optional_result_records.sql');

    expect(db.query(asService(release)).split('\n').at(-1)).toBe('t');
    expect(db.query(asService(release)).split('\n').at(-1)).toBe('t');
    expect(db.query(`SELECT (SELECT count(*) FROM connector_result_private.reports),
      (SELECT count(*) FROM connector_direct_rpc.result_gate),
      (SELECT count(*) FROM connector_result_private.direct_claims WHERE consumed_at IS NULL)`)).toBe('0|0|1');

    for (const role of ['anon','authenticated','connector_result_reader']) denied(`SET ROLE ${role}; ${release}`);
    denied(release); // a caller must enter as the explicit service role
    denied(asService(`INSERT INTO connector_direct_rpc.result_gate(claim_id,owner_id) VALUES ('${claim}','${owner}');`));
    denied(asService(`SELECT public.confirm_connector_result_release('${randomUUID()}');`));

    const changeDenies = (sql: string) => denied(`BEGIN; ${sql}; ${asService(release)} COMMIT;`);
    // These changes are rolled back by the expected failure.
    changeDenies('UPDATE public.remote_instances SET visible=false');
    changeDenies("UPDATE public.instance_logs SET details=jsonb_set(details,'{status}','\"cancelled\"')");
    changeDenies(`UPDATE connector_result_private.direct_turn_heads SET action_id='${nextAction}'`);
    changeDenies('UPDATE connector_result_private.fixture_grants SET enabled=false');
    changeDenies('UPDATE connector_result_private.direct_revisions SET direct_revision=2');
    changeDenies("UPDATE connector_result_private.direct_claims SET claimed_at=clock_timestamp()-interval '2 hours'");
    changeDenies(`INSERT INTO public.connector_members VALUES ('${site}','${connector}','${owner}',clock_timestamp()-interval '1 second')`);
    expect(db.query(asService(release)).split('\n').at(-1)).toBe('t');
  } finally { db.stop(); }
}, 20_000);