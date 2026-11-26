import { checkLinkedRecordTurns } from './fixtures/linked-record-ask-postgres';
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

it('reauthorizes connector and native Record Ask turns under real RLS without a shared report', () => {
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
      GRANT connector_result_reader TO CURRENT_USER;
      GRANT authenticated TO connector_result_reader;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      INSERT INTO auth.users VALUES ('${owner}');
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt()->>'role' $$;
      CREATE SCHEMA connector_result_private;
      REVOKE ALL ON SCHEMA connector_result_private FROM PUBLIC,anon,authenticated,service_role;
      GRANT USAGE ON SCHEMA connector_result_private TO connector_result_reader;
      CREATE SCHEMA connector_direct_rpc;
      REVOKE ALL ON SCHEMA connector_direct_rpc FROM PUBLIC,anon,authenticated;
      GRANT USAGE ON SCHEMA connector_direct_rpc TO service_role;
      CREATE TABLE public.remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid,visible boolean);
      ALTER TABLE public.remote_instances ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.remote_instances TO authenticated;
      CREATE POLICY fixture_owner_visibility ON public.remote_instances FOR SELECT TO authenticated
        USING (user_id=auth.uid() AND visible);
      CREATE TABLE public.instance_logs(id uuid PRIMARY KEY,site_id uuid,user_id uuid,instance_id uuid,
        agent_id uuid,log_type text,trusted_user_action boolean,details jsonb,level text,message text,parent_log_id uuid,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp());
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
      CREATE FUNCTION connector_result_private.direct_claim_admitted(c connector_result_private.direct_claims)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      ${sqlFunction(accountReceipts, 'connector_result_private.lock_direct_write')}
      ${sqlFunction(accountReceipts, 'connector_result_private.check_dispatch_authority')}
      ${sqlFunction(receipts, 'connector_result_private.authorize_direct_parent')}
      INSERT INTO public.remote_instances VALUES ('${instance}','${site}','${owner}',true);
      INSERT INTO public.instance_logs(id,site_id,user_id,instance_id,agent_id,log_type,trusted_user_action,details) VALUES ('${action}','${site}','${owner}','${instance}','${agent}','user_action',true,
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

    db.query('ALTER TABLE public.instance_logs ALTER COLUMN id SET DEFAULT gen_random_uuid();');
    db.migrate('20261123173000_connector_owner_ask_answers.sql');
    const text = 'Paid accounts: 719', foreign = randomUUID();
    const write = `SELECT public.store_connector_ask_answer('${action}',ARRAY['${claim}']::uuid[],'${text}');`;
    const read = `SELECT public.read_connector_ask_answer('${action}');`;
    const actor = (id:string, anonymous = false) => `SET ROLE authenticated; SET request.jwt.claims='{"sub":"${id}","role":"authenticated","is_anonymous":${anonymous}}';`;
    expect(db.query(asService('SELECT public.connector_ask_answer_ready();')).split('\n').at(-1)).toBe('t');
    denied(actor(owner)+write);
    denied(asService(write.replace(claim,foreign)));
    expect(db.query(asService(write)).split('\n').at(-1)).toBe('t');
    expect(db.query(asService(write)).split('\n').at(-1)).toBe('t');
    denied(asService(write.replace(text,'Different reply')));
    expect(db.query('SELECT count(*) FROM public.instance_logs WHERE parent_log_id IS NOT NULL')).toBe('1');
    const link = db.query('SELECT message FROM public.instance_logs WHERE parent_log_id IS NOT NULL');
    expect(link).toContain(`/robots/private-answer/${action}`);
    expect(link).not.toContain(text);
    expect(db.query(actor(owner)+read).split('\n').at(-1)).toBe(text);
    // The fixture's service role inherits authenticated for the RLS gate; the
    // RPC still does not disclose the answer even with the owner's JWT claims.
    expect(db.query(asService(`SET request.jwt.claims='{"sub":"${owner}","is_anonymous":false}'; ${read}`))).not.toContain(text);
    expect(db.query(actor(foreign)+read)).not.toContain(text);
    expect(db.query(actor(owner,true)+read)).not.toContain(text);
    denied(actor(owner)+'SELECT answer FROM connector_result_private.ask_answers;');
    expect(db.query('BEGIN; UPDATE public.remote_instances SET visible=false; '+actor(owner)+read+'ROLLBACK;')).not.toContain(text);
    expect(db.query('BEGIN; UPDATE connector_result_private.fixture_grants SET enabled=false; '+actor(owner)+read+'ROLLBACK;')).not.toContain(text);

    db.migrate('20261123175000_connector_ask_followup.sql');
    db.query(`INSERT INTO public.instance_logs(id,site_id,user_id,instance_id,agent_id,log_type,trusted_user_action,details)
      SELECT '${nextAction}',site_id,user_id,instance_id,agent_id,log_type,trusted_user_action,details FROM public.instance_logs WHERE id='${action}';
      INSERT INTO connector_result_private.direct_ask_submissions VALUES ('${nextAction}');
      UPDATE connector_result_private.direct_turn_heads SET action_id='${nextAction}';`);
    const followup = `SELECT public.connector_ask_followup('${nextAction}');`;
    const derived = 'Derived KPI comparison';
    const save = `SELECT public.connector_ask_followup('${nextAction}','${action}','${derived}');`;
    expect(db.query(asService(followup))).toContain(text);
    expect(db.query(asService(followup))).toContain(action);
    expect(db.query(asService(followup.replace(nextAction,action)))).not.toContain(text);
    denied(actor(owner)+followup);
    denied(asService(save.replace(action,foreign)));
    denied(`BEGIN; UPDATE public.remote_instances SET visible=false; ${asService(followup)} ROLLBACK;`);
    expect(db.query(`BEGIN; UPDATE connector_result_private.fixture_grants SET enabled=false; ${asService(followup)} ROLLBACK;`))
      .toContain('{"unavailable": true}');
    expect(db.query(`BEGIN; DELETE FROM connector_result_private.direct_turn_heads; ${asService(followup)} ROLLBACK;`))
      .toContain('{"unavailable": true}');
    denied(`BEGIN; UPDATE connector_result_private.fixture_grants SET enabled=false; ${asService(save)} ROLLBACK;`);
    expect(db.query(asService(save)).split('\n').at(-1)).toBe('true');
    expect(db.query(asService(save)).split('\n').at(-1)).toBe('true');
    denied(asService(save.replace(derived,'Different follow-up')));
    expect(db.query(actor(owner)+read.replace(action,nextAction)).split('\n').at(-1)).toBe(derived);
    expect(db.query(actor(foreign)+read.replace(action,nextAction))).not.toContain(derived);
    expect(db.query(`SELECT message FROM public.instance_logs WHERE parent_log_id='${nextAction}'`))
      .toBe(`This answer uses private connector data. [Open your answer](/robots/private-answer/${nextAction}).`);
    const thirdAction = randomUUID();
    db.query(`INSERT INTO public.instance_logs(id,site_id,user_id,instance_id,agent_id,log_type,trusted_user_action,details)
      SELECT '${thirdAction}',site_id,user_id,instance_id,agent_id,log_type,trusted_user_action,details FROM public.instance_logs WHERE id='${nextAction}';
      INSERT INTO connector_result_private.direct_ask_submissions VALUES ('${thirdAction}');
      UPDATE connector_result_private.direct_turn_heads SET action_id='${thirdAction}';`);
    const third = followup.replace(nextAction, thirdAction);
    expect(db.query(asService(third))).toContain(derived);
    expect(db.query(`BEGIN; UPDATE connector_result_private.fixture_grants SET enabled=false; ${asService(third)} ROLLBACK;`))
      .toContain('{"unavailable": true}');
    expect(db.query('SELECT count(*) FROM connector_direct_rpc.ask_followup_gate')).toBe('0');
    db.migrate('20261126010000_connector_ask_turn_context.sql');
    const context = (id:string) => `SELECT public.connector_ask_context('${id}');`;
    const load = (id:string) => JSON.parse(db.query(asService(context(id))).split('\n').at(-1)!);
    const freshClaim = randomUUID(), fourthAction = randomUUID();
    const data = [{ claim_id:freshClaim, result:{ paid_accounts:925 } }];
    expect(load(thirdAction)).toEqual({ source_id:nextAction, answer:derived, connector_ids:[connector], tool_context:[] });
    db.query(`INSERT INTO connector_result_private.direct_claims SELECT '${freshClaim}','${thirdAction}',site_id,owner_id,instance_id,
      agent_id,connector_id,authorization_id,attestation_id,connector_revision,policy_revision,direct_revision,clock_timestamp(),NULL
      FROM connector_result_private.direct_claims WHERE id='${claim}';`);
    const publish = `SELECT public.store_connector_ask_turn('${thirdAction}',ARRAY['${freshClaim}']::uuid[], 'Updated KPI', '${JSON.stringify(data)}', '${nextAction}');`;
    denied(asService(publish.replace(nextAction,action))); // cannot drop the inherited source
    denied(asService(publish.replace(`ARRAY['${freshClaim}']`,`ARRAY['${claim}']`))); // no foreign-turn dispatch
    denied(actor(owner)+publish);
    expect(db.query(asService(publish)).split('\n').at(-1)).toBe('t');
    expect(db.query(asService(publish)).split('\n').at(-1)).toBe('t');
    denied(asService(publish.replace('925','926')));
    expect(db.query(`SELECT count(*),bool_and(message NOT LIKE '%925%') FROM public.instance_logs WHERE parent_log_id='${thirdAction}'`)).toBe('1|t');
    expect(db.query(`SELECT cardinality(claims) FROM connector_result_private.ask_answers WHERE action_id='${thirdAction}'`)).toBe('2');
    db.query(`INSERT INTO public.instance_logs(id,site_id,user_id,instance_id,agent_id,log_type,trusted_user_action,details)
      SELECT '${fourthAction}',site_id,user_id,instance_id,agent_id,log_type,trusted_user_action,details FROM public.instance_logs WHERE id='${thirdAction}';
      INSERT INTO connector_result_private.direct_ask_submissions VALUES ('${fourthAction}');
      UPDATE connector_result_private.direct_turn_heads SET action_id='${fourthAction}';`);
    expect(load(fourthAction)).toEqual({ source_id:thirdAction, answer:'Updated KPI', connector_ids:[connector], tool_context:data });
    denied(actor(owner)+context(fourthAction));
    denied(actor(owner)+'SELECT entries FROM connector_result_private.ask_turn_context;');
    denied(`BEGIN; UPDATE public.remote_instances SET visible=false; ${asService(context(fourthAction))} ROLLBACK;`);
    for (const id of [claim,freshClaim]) {
      expect(db.query(`BEGIN; DELETE FROM connector_result_private.direct_claims WHERE id='${id}'; ${asService(context(fourthAction))} ROLLBACK;`))
        .toContain('{"unavailable": true}');
    }
    const answerOnly = `SELECT public.store_connector_ask_turn('${fourthAction}',ARRAY[]::uuid[],'Same data, revised report','[]','${thirdAction}');`;
    expect(db.query(asService(answerOnly)).split('\n').at(-1)).toBe('t');
    expect(JSON.parse(db.query(`SELECT entries FROM connector_result_private.ask_turn_context WHERE action_id='${fourthAction}'`))).toEqual(data);
    expect(db.query(actor(owner)+read.replace(action,fourthAction)).split('\n').at(-1)).toBe('Same data, revised report');
    // A new conversation without prior private context can publish its first turn atomically.
    const first = `SELECT public.store_connector_ask_turn('${action}',ARRAY['${claim}']::uuid[],'First report',
      '[{"claim_id":"${claim}","result":{"count":1}}]');`;
    expect(db.query(`BEGIN; DELETE FROM connector_result_private.ask_answers WHERE action_id='${action}';
      UPDATE connector_result_private.direct_turn_heads SET action_id='${action}'; ${asService(first)} ROLLBACK;`)).toContain('\nt\n');
    checkLinkedRecordTurns(db,{owner,site,instance,prior:fourthAction,connector,data});
  } finally { db.stop(); }
}, 20_000);