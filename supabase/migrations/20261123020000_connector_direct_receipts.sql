BEGIN;
SET LOCAL lock_timeout = '5s';

-- The host writes the verified interactive execution into an existing server-owned
-- recovery snapshot. A user_action label or trusted_user_action bit alone is not proof.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='public.instance_logs'::regclass
    AND tgname='connector_recovery_provenance_guard' AND tgenabled IN ('O','A') AND tgtype=23
    AND tgqual IS NULL AND tgattr=''::int2vector
    AND tgfoid='public.guard_connector_recovery_provenance()'::regprocedure) THEN
    RAISE EXCEPTION 'Server-owned assistant recovery provenance must be installed first';
  END IF;
END $$;
-- A browser must not install its own trigger on the server's provenance source.
-- No row CRUD, FK creation or unrelated table privileges are changed here.
REVOKE TRIGGER ON public.instance_logs FROM PUBLIC, anon, authenticated;

-- A newer trusted action must stay newer even if its log is subsequently deleted.
-- No scan or backfill of the log table. Start tracking only upon a new server
-- action at an enrolled site. A pre-enrollment turn cannot dispatch retroactively.
CREATE TABLE connector_result_private.direct_turn_heads (
  instance_id uuid PRIMARY KEY REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  site_id uuid NOT NULL, action_id uuid NOT NULL, action_created_at timestamptz NOT NULL
);
ALTER TABLE connector_result_private.direct_turn_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.direct_turn_heads FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE FUNCTION connector_result_private.advance_direct_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
     (current_setting('role',true)='none' AND session_user=current_user) THEN
    IF EXISTS (SELECT FROM connector_result_private.direct_enrollments e WHERE e.site_id=NEW.site_id) THEN
      INSERT INTO connector_result_private.direct_turn_heads AS h(instance_id,site_id,action_id,action_created_at)
      VALUES (NEW.instance_id,NEW.site_id,NEW.id,NEW.created_at) ON CONFLICT (instance_id) DO UPDATE SET
        site_id=EXCLUDED.site_id,action_id=EXCLUDED.action_id,action_created_at=EXCLUDED.action_created_at
      WHERE (h.action_created_at,h.action_id)<(EXCLUDED.action_created_at,EXCLUDED.action_id);
    ELSE
      -- Withdraw the slot if the site has no remaining enrollments. Re-enrollment
      -- then requires a fresh action, never the previously tracked one.
      DELETE FROM connector_result_private.direct_turn_heads WHERE instance_id=NEW.instance_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.advance_direct_turn() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER connector_direct_turn_advance AFTER INSERT ON public.instance_logs FOR EACH ROW
  WHEN (NEW.log_type='user_action' AND NEW.trusted_user_action) EXECUTE FUNCTION connector_result_private.advance_direct_turn();

-- The Ask ingress admits an effectful workflow only to the winner of an exact
-- action-PK insert. Keep its non-secret tombstone if a log, its conversation,
-- or the instance is erased. No prompt, digest, user, site or payload is retained.
-- An independently generated new submission remains a different user intent.
CREATE TABLE connector_result_private.direct_ask_submissions (
  action_id uuid PRIMARY KEY
);
ALTER TABLE connector_result_private.direct_ask_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.direct_ask_submissions FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE FUNCTION connector_result_private.reserve_ask_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (current_setting('role',true) IN ('postgres','service_role','supabase_admin') OR
    (current_setting('role',true)='none' AND session_user=current_user)) OR NEW.log_type IS DISTINCT FROM 'user_action'
    OR NEW.trusted_user_action IS NOT TRUE OR (NEW.details->>'ask_request_sha256' COLLATE "C" ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN
    RAISE insufficient_privilege;
  END IF;
  INSERT INTO connector_result_private.direct_ask_submissions VALUES (NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.reserve_ask_submission() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER connector_reserve_ask_submission AFTER INSERT ON public.instance_logs FOR EACH ROW
  WHEN (NEW.details ? 'ask_request_sha256') EXECUTE FUNCTION connector_result_private.reserve_ask_submission();

-- Do not let browser lifecycle writes transplant or reactivate a protected direct
-- turn. Normal cancellation and changes to unrelated logs retain their existing RLS.
CREATE FUNCTION connector_result_private.guard_direct_turn() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Only the prompt producer may pin an unbound Ask action. Once resolved it
  -- cannot be replaced, even by a late server checkpoint.
  IF OLD.details ? 'ask_request_sha256' AND OLD.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    RAISE insufficient_privilege;
  END IF;
  IF current_user NOT IN ('postgres','service_role','supabase_admin') AND (
    (NEW.details->'ask_request_sha256') IS DISTINCT FROM (OLD.details->'ask_request_sha256') OR
    ((OLD.details ? 'ask_request_sha256') AND (
      (NEW.id,NEW.instance_id,NEW.site_id,NEW.user_id,NEW.log_type,NEW.trusted_user_action,NEW.message,NEW.created_at,NEW.agent_id) IS DISTINCT FROM
      (OLD.id,OLD.instance_id,OLD.site_id,OLD.user_id,OLD.log_type,OLD.trusted_user_action,OLD.message,OLD.created_at,OLD.agent_id) OR
      (NEW.details - 'status') IS DISTINCT FROM (OLD.details - 'status') OR
      ((NEW.details->'status') IS DISTINCT FROM (OLD.details->'status') AND
        (OLD.details->>'status'='running' AND NEW.details->>'status' IN ('stopped','cancelled')) IS NOT TRUE)))
  ) THEN RAISE insufficient_privilege; END IF;
  IF current_user NOT IN ('postgres','service_role','supabase_admin') AND
     OLD.details #> '{assistant_recovery,execution,catalogUserSession}' = 'true'::jsonb AND (
       (NEW.message,NEW.created_at,NEW.agent_id) IS DISTINCT FROM (OLD.message,OLD.created_at,OLD.agent_id)
       OR ((NEW.details->'status') IS DISTINCT FROM (OLD.details->'status') AND
           (OLD.details->>'status'='running' AND NEW.details->>'status' IN ('stopped','cancelled')) IS NOT TRUE)) THEN
    RAISE insufficient_privilege;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.guard_direct_turn() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER connector_direct_turn_guard BEFORE UPDATE ON public.instance_logs FOR EACH ROW
  EXECUTE FUNCTION connector_result_private.guard_direct_turn();

-- This journal survives receipt expiry/eviction and grant rotation. It is removed
-- with its original action, which can no longer admit a dispatch. Never store raw
-- arguments, provider results, project/resource locators, keys or prompts here.
CREATE TABLE connector_result_private.direct_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.instance_logs(id) ON DELETE CASCADE,
  site_id uuid NOT NULL, owner_id uuid NOT NULL, instance_id uuid NOT NULL,
  agent_id uuid NOT NULL, connector_id uuid NOT NULL, attestation_id uuid NOT NULL,
  connector_revision integer NOT NULL, policy_revision integer NOT NULL, direct_revision integer NOT NULL,
  credential_revision text NOT NULL CHECK (credential_revision COLLATE "C" ~ '^(platform:)?[a-f0-9]{64}$'),
  tool text COLLATE "C" NOT NULL CHECK (tool ~ '^[A-Z0-9][A-Z0-9_]{0,149}$'),
  version text COLLATE "C" NOT NULL CHECK (version ~ '^[A-Za-z0-9_.-]{1,100}$'),
  schema_hash text COLLATE "C" NOT NULL CHECK (schema_hash ~ '^[a-f0-9]{64}$'),
  arguments_digest text COLLATE "C" NOT NULL CHECK (arguments_digest ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(), consumed_at timestamptz,
  UNIQUE(request_id,connector_id,tool,arguments_digest)
);
ALTER TABLE connector_result_private.direct_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.direct_claims FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- Match the private document's strict presentation DTO. In particular, no raw
-- provider envelope, next_after, published flag or provider-selected follow-up.
CREATE FUNCTION connector_result_private.valid_direct_report(doc jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE row_value jsonb; width integer;
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR octet_length(doc::text)>65536 THEN RETURN false; END IF;
  IF doc - ARRAY['title','note','columns','rows'] <> '{}'::jsonb OR
    jsonb_typeof(doc->'title') IS DISTINCT FROM 'string' OR length(doc->>'title') NOT BETWEEN 1 AND 200 OR
    jsonb_typeof(doc->'note') IS DISTINCT FROM 'string' OR length(doc->>'note')>500 OR
    jsonb_typeof(doc->'columns') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'rows') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  width := jsonb_array_length(doc->'columns');
  IF width NOT BETWEEN 1 AND 5 OR jsonb_array_length(doc->'rows')>100 OR EXISTS (
    SELECT FROM jsonb_array_elements(doc->'columns') c WHERE jsonb_typeof(c)<>'string' OR length(c #>> '{}') NOT BETWEEN 1 AND 200
  ) THEN RETURN false; END IF;
  FOR row_value IN SELECT value FROM jsonb_array_elements(doc->'rows') LOOP
    IF jsonb_typeof(row_value)<>'array' THEN RETURN false; END IF;
    IF jsonb_array_length(row_value)<>width OR EXISTS (SELECT FROM jsonb_array_elements(row_value) cell
      WHERE jsonb_typeof(cell)<>'string' OR length(cell #>> '{}')>200) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.valid_direct_report(jsonb) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

ALTER TABLE connector_result_private.reports ADD COLUMN direct_claim_id uuid
  REFERENCES connector_result_private.direct_claims(id) ON DELETE CASCADE,
  ADD CHECK (direct_claim_id IS NULL OR (NOT catalog AND data_scope IS NULL AND connector_result_private.valid_direct_report(report)));
CREATE UNIQUE INDEX reports_one_per_direct_claim ON connector_result_private.reports(direct_claim_id) WHERE direct_claim_id IS NOT NULL;

-- Private scalar check shared by claim, store and open. It always requests an
-- exact account and action (the policy's NULL discovery selectors are not grants).
CREATE FUNCTION connector_result_private.direct_claim_admitted(c connector_result_private.direct_claims) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.tool IS NOT NULL AND c.connector_id IS NOT NULL AND EXISTS (
    SELECT FROM connector_result_private.direct_admissions(c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool) a
    WHERE (a.connector_id,a.attestation_id,a.connector_revision,a.policy_revision,a.direct_revision,a.credential_revision) =
      (c.connector_id,c.attestation_id,c.connector_revision,c.policy_revision,c.direct_revision,c.credential_revision));
$$;
REVOKE ALL ON FUNCTION connector_result_private.direct_claim_admitted(connector_result_private.direct_claims)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- Serialize siblings on the contributing turn, including cancellation. Serialize
-- both writes with revocation and manager policy/grant changes, then admit against
-- a fresh snapshot. These locks never span a provider call. The host must still
-- reverify the live account, project, credential, selected agent and descriptor.
CREATE FUNCTION connector_result_private.lock_direct_write(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Parent before referencing rows (notably instance deletion cascades).
  -- Snapshots pinned to transaction start cannot supply the post-wait ACL check.
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(c.instance_id,c.site_id,c.owner_id) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  -- Serialize a competing start with the short reservation/storage transaction;
  -- do not hold a database lock across the network call. The slot is not an FK
  -- to the log: removing the newest action must never revive a superseded one.
  PERFORM FROM connector_result_private.direct_turn_heads h WHERE
    (h.instance_id,h.site_id,h.action_id)=(c.instance_id,c.site_id,c.request_id) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM public.instance_logs l WHERE (l.id,l.site_id,l.user_id,l.instance_id)=(c.request_id,c.site_id,c.owner_id,c.instance_id)
    AND l.log_type='user_action' AND l.trusted_user_action AND l.agent_id=c.agent_id
    AND l.details->>'ask_request_sha256' COLLATE "C" ~ '^[a-f0-9]{64}$'
    AND EXISTS (SELECT FROM connector_result_private.direct_ask_submissions s WHERE s.action_id=l.id)
    AND l.details->>'status'='running' AND l.details @> '{"assistant_recovery":{"version":1,"respawnCount":0,"inFlight":true,"inFlightKind":"turn","execution":{"catalogUserSession":true,"callerSource":"interactive","executionMode":"direct"}}}'::jsonb
    AND NOT ((l.details->'assistant_recovery') ?| ARRAY['lease_token','conversationOnly'])
    AND NOT ((l.details #> '{assistant_recovery,execution}') ? 'instanceNodeId')
    AND coalesce(l.details #> '{assistant_recovery,execution,expectedResultsAmount}','1'::jsonb)='1'::jsonb
    AND coalesce(l.details #> '{assistant_recovery,execution,connectorIdHint}',to_jsonb(c.connector_id))=to_jsonb(c.connector_id)
    FOR UPDATE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM connector_result_private.direct_attestations b WHERE (b.id,b.site_id,b.connector_id)=(c.attestation_id,c.site_id,c.connector_id)
    AND b.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM public.connectors k WHERE (k.id,k.site_id,k.revision)=(c.connector_id,c.site_id,c.connector_revision) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM FROM connector_result_private.direct_revisions d WHERE (d.connector_id,d.direct_revision)=(c.connector_id,c.direct_revision) FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
END $$;
CREATE FUNCTION connector_result_private.check_direct_authority(c connector_result_private.direct_claims) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- The policy's stable read predicate tests expiry at statement start. Recheck
  -- the three time-based authorities at wall time, *after* any lock/retention wait.
  IF connector_result_private.direct_claim_admitted(c) IS NOT TRUE OR NOT EXISTS (
    SELECT FROM connector_result_private.direct_attestations b WHERE b.id=c.attestation_id AND b.expires_at>clock_timestamp()
  ) OR EXISTS (SELECT FROM public.connector_members m WHERE (m.site_id,m.connector_id,m.user_id)=(c.site_id,c.connector_id,c.owner_id)
    AND m.expires_at<=clock_timestamp()) OR EXISTS (SELECT FROM public.connector_agents a
    WHERE (a.site_id,a.connector_id,a.agent_id)=(c.site_id,c.connector_id,c.agent_id) AND a.expires_at<=clock_timestamp()) THEN
    RAISE insufficient_privilege;
  END IF;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.lock_direct_write(connector_result_private.direct_claims),
  connector_result_private.check_direct_authority(connector_result_private.direct_claims)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- PostgreSQL forbids SET ROLE anywhere in a SECURITY DEFINER stack. Use an
-- empty INSERT gate, not a definer that simulates the parent policies. Ordered
-- before-row triggers keep the tentative mutation and the actual requester RLS
-- SELECT in the same statement/transaction. Neither trigger can be invoked as
-- an RPC. No grant to service_role on the existing private schema or journal.
CREATE SCHEMA connector_direct_rpc;
REVOKE ALL ON SCHEMA connector_direct_rpc FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT USAGE ON SCHEMA connector_direct_rpc TO service_role;
CREATE TABLE connector_direct_rpc.write_gate (
  site_id uuid, owner_id uuid, instance_id uuid, agent_id uuid, connector_id uuid, request_id uuid,
  tool text, version text, schema_hash text, attestation_id uuid, connector_revision integer,
  policy_revision integer, direct_revision integer, credential_revision text, arguments_digest text,
  claim_id uuid, report jsonb, result_id uuid, CHECK (false)
);
ALTER TABLE connector_direct_rpc.write_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_direct_rpc.write_gate FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT INSERT (site_id,owner_id,instance_id,agent_id,connector_id,request_id,tool,version,schema_hash,attestation_id,
  connector_revision,policy_revision,direct_revision,credential_revision,arguments_digest,claim_id,report)
  ON connector_direct_rpc.write_gate TO service_role;

CREATE FUNCTION connector_result_private.apply_direct_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE c connector_result_private.direct_claims; incumbent uuid;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  c.site_id:=NEW.site_id; c.owner_id:=NEW.owner_id; c.instance_id:=NEW.instance_id; c.agent_id:=NEW.agent_id;
  c.connector_id:=NEW.connector_id; c.request_id:=NEW.request_id; c.tool:=NEW.tool; c.version:=NEW.version;
  c.schema_hash:=NEW.schema_hash; c.attestation_id:=NEW.attestation_id; c.connector_revision:=NEW.connector_revision;
  c.policy_revision:=NEW.policy_revision; c.direct_revision:=NEW.direct_revision; c.credential_revision:=NEW.credential_revision;
  IF NEW.claim_id IS NULL AND NEW.report IS NULL THEN
    IF (c.version COLLATE "C" ~ '^[A-Za-z0-9_.-]{1,100}$' AND c.schema_hash COLLATE "C" ~ '^[a-f0-9]{64}$'
      AND NEW.arguments_digest COLLATE "C" ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE invalid_parameter_value; END IF;
    PERFORM connector_result_private.lock_direct_write(c);
    PERFORM connector_result_private.check_direct_authority(c);
    c.id:=gen_random_uuid(); c.arguments_digest:=NEW.arguments_digest; c.claimed_at:=clock_timestamp();
    INSERT INTO connector_result_private.direct_claims SELECT c.* ON CONFLICT(request_id,connector_id,tool,arguments_digest) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch already reserved for this turn' USING ERRCODE='P0D03'; END IF;
    IF (SELECT count(*) FROM connector_result_private.direct_claims WHERE request_id=c.request_id)>100 THEN
      RAISE EXCEPTION 'Turn dispatch budget exceeded' USING ERRCODE='54000';
    END IF;
    NEW.result_id:=c.id;
  ELSE
    IF NEW.arguments_digest IS NOT NULL OR NOT connector_result_private.valid_direct_report(NEW.report) THEN RAISE invalid_parameter_value; END IF;
    SELECT j.* INTO c FROM connector_result_private.direct_claims j WHERE j.id=NEW.claim_id AND
      (j.site_id,j.owner_id,j.instance_id,j.agent_id,j.connector_id,j.request_id,j.tool,j.version,j.schema_hash,
        j.attestation_id,j.connector_revision,j.policy_revision,j.direct_revision,j.credential_revision) =
      (NEW.site_id,NEW.owner_id,NEW.instance_id,NEW.agent_id,NEW.connector_id,NEW.request_id,NEW.tool,NEW.version,NEW.schema_hash,
        NEW.attestation_id,NEW.connector_revision,NEW.policy_revision,NEW.direct_revision,NEW.credential_revision);
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid dispatch reservation' USING ERRCODE='P0D04'; END IF;
    PERFORM connector_result_private.lock_direct_write(c);
    PERFORM pg_advisory_xact_lock(hashtextextended('connector-private-results:' || c.owner_id::text,0));
    -- Re-read the claim under lock AFTER waiting for siblings and legacy retention.
    SELECT j.* INTO c FROM connector_result_private.direct_claims j WHERE j.id=NEW.claim_id FOR UPDATE;
    IF NOT FOUND OR c.claimed_at<=clock_timestamp()-interval '1 hour' THEN
      RAISE EXCEPTION 'Stale dispatch reservation' USING ERRCODE='P0D04'; END IF;
    IF c.consumed_at IS NOT NULL THEN
      SELECT r.id INTO incumbent FROM connector_result_private.reports r WHERE r.direct_claim_id=c.id AND r.report=NEW.report
        AND r.expires_at>clock_timestamp() FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Receipt unavailable or different' USING ERRCODE='P0D04'; END IF;
      NEW.result_id:=incumbent;
    ELSE
      -- All private producers share the owner fence and 20-row cap. Evict
      -- at most one further row to make room, never on a matching replay.
      DELETE FROM connector_result_private.reports WHERE id IN (SELECT r.id FROM connector_result_private.reports r
        WHERE r.owner_id=c.owner_id ORDER BY r.created_at DESC,r.id OFFSET 19 LIMIT 1);
      UPDATE connector_result_private.direct_claims SET consumed_at=clock_timestamp() WHERE id=c.id;
      INSERT INTO connector_result_private.reports(site_id,owner_id,instance_id,agent_id,connector_id,tool,catalog,version,schema_hash,
        connector_revision,policy_revision,credential_revision,report,direct_claim_id) VALUES
        (c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool,false,c.version,c.schema_hash,
        c.connector_revision,c.policy_revision,c.credential_revision,NEW.report,c.id) RETURNING id INTO NEW.result_id;
      -- Global expiry cleanup comes last, after owner rows and FK inserts, to
      -- avoid cross-owner lock cycles. Skip a row being deleted elsewhere.
      DELETE FROM connector_result_private.reports WHERE id IN (SELECT r.id FROM connector_result_private.reports r
        WHERE r.expires_at<=statement_timestamp() ORDER BY r.expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
    END IF;
    -- Recheck the clock and current authority after retention and report/FK waits.
    PERFORM connector_result_private.check_direct_authority(c);
    IF c.claimed_at<=clock_timestamp()-interval '1 hour' OR NOT EXISTS (SELECT FROM connector_result_private.reports r
      WHERE r.id=NEW.result_id AND r.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'Stale dispatch reservation' USING ERRCODE='P0D04'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.apply_direct_write() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER a_apply BEFORE INSERT ON connector_direct_rpc.write_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.apply_direct_write();

-- The hosted migration owner cannot install function-level SET clauses for
-- request.* placeholders. Set them transaction-locally under the authenticated
-- role instead, and restore every outer value before returning. On an exception
-- PostgreSQL rolls back the whole statement, including these settings/mutations.
-- Never carry a bearer token into a workflow. If policies need token claims
-- beyond the verified identity/role, do not enroll without a new review.
CREATE FUNCTION connector_result_private.authorize_direct_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET role = authenticated SET row_security = on AS $$
DECLARE claims text:=jsonb_build_object('sub',NEW.owner_id,'role','authenticated','is_anonymous',false)::text;
  names text[]:=ARRAY['request.jwt.claims','request.jwt.claim','request.jwt.claim.sub','request.jwt.claim.role','request.headers','request.cookies'];
  replacements text[]:=ARRAY[claims,claims,NEW.owner_id::text,'authenticated','{}','{}']; saved text[]:=ARRAY[]::text[]; i integer;
BEGIN
  FOR i IN 1..cardinality(names) LOOP
    saved:=array_append(saved,coalesce(current_setting(names[i],true),''));
    PERFORM set_config(names[i],replacements[i],true);
  END LOOP;
  IF current_user<>'authenticated' OR current_setting('role')<>'authenticated' OR NOT row_security_active('public.remote_instances')
    OR auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS DISTINCT FROM NEW.owner_id OR auth.jwt()::jsonb IS DISTINCT FROM claims::jsonb
    OR NEW.result_id IS NULL OR NOT EXISTS (SELECT FROM public.remote_instances i
      WHERE (i.id,i.site_id,i.user_id)=(NEW.instance_id,NEW.site_id,auth.uid())) THEN RAISE insufficient_privilege; END IF;
  FOR i IN 1..cardinality(names) LOOP PERFORM set_config(names[i],saved[i],true); END LOOP;
  PERFORM set_config('connector_direct.result_id',NEW.result_id::text,true);
  RETURN NULL; -- No gate row is persisted, even on success.
END $$;
REVOKE ALL ON FUNCTION connector_result_private.authorize_direct_parent() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER z_authorize BEFORE INSERT ON connector_direct_rpc.write_gate FOR EACH ROW EXECUTE FUNCTION connector_result_private.authorize_direct_parent();

CREATE FUNCTION public.claim_connector_direct_dispatch(
  p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_tool text,p_version text,p_schema_hash text,p_attestation_id uuid,p_connector_revision integer,p_policy_revision integer,
  p_direct_revision integer,p_credential_revision text,p_arguments_digest text
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE receipt uuid; previous_result text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  PERFORM set_config('connector_direct.result_id','',true);
  INSERT INTO connector_direct_rpc.write_gate(site_id,owner_id,instance_id,agent_id,connector_id,request_id,tool,version,schema_hash,
    attestation_id,connector_revision,policy_revision,direct_revision,credential_revision,arguments_digest) VALUES
    (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_request_id,p_tool,p_version,p_schema_hash,
    p_attestation_id,p_connector_revision,p_policy_revision,p_direct_revision,p_credential_revision,p_arguments_digest);
  receipt:=nullif(current_setting('connector_direct.result_id'),'')::uuid;
  PERFORM set_config('connector_direct.result_id',coalesce(previous_result,''),true);
  IF receipt IS NULL THEN RAISE insufficient_privilege; END IF;
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.claim_connector_direct_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,text)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.claim_connector_direct_dispatch(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,text) TO service_role;

CREATE FUNCTION public.store_connector_direct_result(
  p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_agent_id uuid,p_connector_id uuid,p_request_id uuid,
  p_tool text,p_version text,p_schema_hash text,p_attestation_id uuid,p_connector_revision integer,p_policy_revision integer,
  p_direct_revision integer,p_credential_revision text,p_claim_id uuid,p_report jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE receipt uuid; previous_result text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  PERFORM set_config('connector_direct.result_id','',true);
  INSERT INTO connector_direct_rpc.write_gate(site_id,owner_id,instance_id,agent_id,connector_id,request_id,tool,version,schema_hash,
    attestation_id,connector_revision,policy_revision,direct_revision,credential_revision,claim_id,report) VALUES
    (p_site_id,p_user_id,p_instance_id,p_agent_id,p_connector_id,p_request_id,p_tool,p_version,p_schema_hash,
    p_attestation_id,p_connector_revision,p_policy_revision,p_direct_revision,p_credential_revision,p_claim_id,p_report);
  receipt:=nullif(current_setting('connector_direct.result_id'),'')::uuid;
  PERFORM set_config('connector_direct.result_id',coalesce(previous_result,''),true);
  IF receipt IS NULL THEN RAISE insufficient_privilege; END IF;
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.store_connector_direct_result(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.store_connector_direct_result(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,integer,integer,integer,text,uuid,jsonb) TO service_role;

-- Only a scalar check for one real, own receipt. Do not give the low-privilege
-- reader access to the journal, proofs, credential records or admission listing.
CREATE FUNCTION connector_result_private.direct_receipt_current(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT current_setting('role',true)='authenticated' AND auth.jwt()->'is_anonymous'='false'::jsonb AND EXISTS (
    SELECT FROM connector_result_private.reports r JOIN connector_result_private.direct_claims c ON c.id=r.direct_claim_id
    WHERE r.id=p_id AND r.owner_id=auth.uid() AND r.expires_at>statement_timestamp() AND c.consumed_at IS NOT NULL AND NOT r.catalog
      AND (r.site_id,r.owner_id,r.instance_id,r.agent_id,r.connector_id,r.tool,r.version,r.schema_hash,r.connector_revision,r.policy_revision,r.credential_revision)=
          (c.site_id,c.owner_id,c.instance_id,c.agent_id,c.connector_id,c.tool,c.version,c.schema_hash,c.connector_revision,c.policy_revision,c.credential_revision)
      AND connector_result_private.direct_claim_admitted(c));
$$;
REVOKE ALL ON FUNCTION connector_result_private.direct_receipt_current(uuid) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION connector_result_private.direct_receipt_current(uuid) TO connector_result_reader;

-- Keep the actual caller-limited, non-BYPASSRLS remote_instances SELECT outside
-- the definer. Legacy rows retain both their original catalogue and analytics checks.
CREATE OR REPLACE FUNCTION connector_result_private.visible(r connector_result_private.reports)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT current_setting('role',true)='authenticated' AND auth.jwt()->'is_anonymous'='false'::jsonb
    AND r.owner_id=auth.uid() AND r.expires_at>statement_timestamp()
    AND EXISTS (SELECT FROM public.remote_instances i WHERE (i.id,i.site_id,i.user_id)=(r.instance_id,r.site_id,auth.uid()))
    AND CASE WHEN r.direct_claim_id IS NOT NULL THEN connector_result_private.direct_receipt_current(r.id)
      ELSE connector_result_private.admitted(r.site_id,r.owner_id,r.instance_id,r.agent_id,r.connector_id,r.tool,r.catalog,
        r.connector_revision,r.policy_revision,r.credential_revision)
        AND (r.data_scope IS NULL OR connector_result_private.analytics_permitted(r.site_id,auth.uid(),r.connector_id,r.agent_id,
          r.project_ref,r.data_scope,r.source_name,r.grant_id)) END;
$$;
COMMIT;
