-- Target: Makinari, NEVER Apps. Forward-only; no backfill or automatic resume.
-- transferred ends LEGACY execution authority, NOT SQL validation/approval.
-- Trusted host operator contract: quiesce cron, sandbox and plan writers; check
-- site/user authorization and configured Apps project/tenant; capture observed_at
-- BEFORE remote I/O; read current file bytes, confirm no applied receipt, and
-- register feedback for those exact bytes. SQL can verify only the attestation,
-- local canonical specification and scope, not remote facts atomically.
-- Evidence has exactly the keys below, <=4096 bytes. Checksums are SHA-256 hex;
-- sql_checksum describes CURRENT observed bytes, not necessarily legacy bytes.
-- Keep the exact request/evidence for replay. Resume is a separate host decision
-- using resume_instance_execution_on_user_action(..., p_allow_terminal_reopen =>
-- true) in service-only internal operator mode; transfer never calls that RPC.
-- Compatible with the old two-argument reconciliation resume draft: only receipt
-- identity is inspected, never its newer evidence column or resume overload.
BEGIN;

ALTER TABLE public.requirement_migration_lifecycle
  DROP CONSTRAINT requirement_migration_lifecycle_state_check;
ALTER TABLE public.requirement_migration_lifecycle
  ADD CONSTRAINT requirement_migration_lifecycle_state_check CHECK (state IN (
    'correction_required', 'reviewing', 'validation_pending', 'validated', 'platform_review', 'transferred'
  ));

CREATE TABLE public.requirement_migration_execution_handoffs (
  id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL REFERENCES public.requirements(id),
  file text NOT NULL,
  site_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id),
  operator_id text NOT NULL CHECK (operator_id ~ '[^[:space:]]' AND char_length(operator_id) <= 200),
  reason text NOT NULL CHECK (reason ~ '[^[:space:]]' AND char_length(reason) <= 2000),
  prior_lifecycle jsonb NOT NULL CHECK (jsonb_typeof(prior_lifecycle) = 'object'),
  prior_diagnostic jsonb CHECK (jsonb_typeof(prior_diagnostic) = 'object'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4096),
  execution_generation integer NOT NULL CHECK (execution_generation BETWEEN 0 AND 2147483646),
  transferred_version integer NOT NULL CHECK (transferred_version > 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (requirement_id, file),
  FOREIGN KEY (requirement_id, file) REFERENCES public.requirement_migration_lifecycle(requirement_id, file)
);
ALTER TABLE public.requirement_migration_execution_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.requirement_migration_execution_handoffs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.requirement_migration_execution_handoffs TO service_role;
CREATE POLICY migration_execution_handoffs_service_read ON public.requirement_migration_execution_handoffs
  FOR SELECT TO service_role USING (true);

CREATE FUNCTION public.reject_migration_execution_handoff_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Migration execution handoffs are append-only' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.reject_migration_execution_handoff_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER migration_execution_handoffs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.requirement_migration_execution_handoffs
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_migration_execution_handoff_mutation();

-- One shared predicate for both row integrity and the status guard. No caller
-- flags, role names or metadata markers can substitute for this private receipt.
CREATE FUNCTION public.migration_execution_handoff_matches(p_row public.requirement_migration_lifecycle)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_row.state = 'transferred' AND EXISTS (
    SELECT 1 FROM public.requirement_migration_execution_handoffs h
    JOIN public.requirements r ON r.id = h.requirement_id AND r.site_id = h.site_id
    WHERE h.requirement_id = p_row.requirement_id AND h.file = p_row.file
      AND h.transferred_version = p_row.version
      AND h.prior_lifecycle->'version' = to_jsonb(p_row.version - 1)
      AND h.created_at = p_row.updated_at
      AND h.prior_lifecycle->>'state' IN ('platform_review', 'correction_required')
      AND h.prior_lifecycle - ARRAY['state','version','updated_at']
        = to_jsonb(p_row) - ARRAY['state','version','updated_at']
  );
$$;
REVOKE ALL ON FUNCTION public.migration_execution_handoff_matches(public.requirement_migration_lifecycle)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.guard_migration_execution_handoff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (OLD.state = 'transferred' OR EXISTS (
    SELECT 1 FROM public.requirement_migration_execution_handoffs h
    WHERE h.requirement_id = OLD.requirement_id AND h.file = OLD.file
  )) THEN
    IF TG_OP <> 'UPDATE' OR OLD.state = 'transferred' OR NEW.state <> 'transferred' THEN
      RAISE EXCEPTION 'Transferred migration lifecycle is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.state = 'transferred' THEN
    IF TG_OP <> 'UPDATE' OR NOT public.migration_execution_handoff_matches(NEW)
      OR NOT EXISTS (SELECT 1 FROM public.requirement_migration_execution_handoffs h
        WHERE h.requirement_id = NEW.requirement_id AND h.file = NEW.file
          AND h.prior_lifecycle = to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'Transferred migration requires its matching immutable receipt' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_migration_execution_handoff() FROM PUBLIC, anon, authenticated, service_role;
-- AFTER checks the final row, including changes made by any BEFORE trigger.
CREATE TRIGGER requirement_migration_execution_handoff_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.requirement_migration_lifecycle
  FOR EACH ROW EXECUTE FUNCTION public.guard_migration_execution_handoff();

CREATE OR REPLACE FUNCTION public.guard_requirement_migration_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status = 'blocked' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_lifecycle l
    WHERE l.requirement_id = NEW.id AND (l.state = 'platform_review'
      OR (l.state = 'transferred' AND NOT public.migration_execution_handoff_matches(l)))) THEN
    RAISE EXCEPTION 'Requirement is blocked by migration platform review or invalid handoff' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('done', 'on-review') AND EXISTS (
    SELECT 1 FROM public.requirement_migration_lifecycle l WHERE l.requirement_id = NEW.id
      AND l.state <> 'validated' AND NOT public.migration_execution_handoff_matches(l)
  ) THEN
    RAISE EXCEPTION 'Requirement has unvalidated migration lifecycle records' USING ERRCODE = '23514';
  END IF;
  -- Exempt only the matching lifecycle row, not the requirement. Pending
  -- reconciliation and durable quarantine guards remain installed unchanged;
  -- this does not replace the generic resume's explicit user/operator policy.
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_requirement_migration_status() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.transfer_requirement_migration_execution(
  p_requirement_id uuid, p_file text, p_expected_version integer,
  p_expected_execution_generation integer, p_instance_id uuid, p_request_id uuid,
  p_operator_id text, p_reason text, p_evidence jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  r public.requirements%ROWTYPE;
  i public.remote_instances%ROWTYPE;
  old_row public.requirement_migration_lifecycle%ROWTYPE;
  new_row public.requirement_migration_lifecycle%ROWTYPE;
  saved public.requirement_migration_execution_handoffs%ROWTYPE;
  v_diagnostic jsonb;
  v_generation text;
  v_keys text[] := ARRAY['apps_project_ref','tenant_id','schema','sandbox_name','file','observed_at',
    'sql_checksum','specification_checksum','receipt_found','feedback_registered','feedback_checksum'];
  v_key text;
  v_observed timestamptz;
  v_now timestamptz;
BEGIN
  IF p_requirement_id IS NULL OR p_instance_id IS NULL OR p_request_id IS NULL
    OR p_file IS NULL OR octet_length(p_file) > 512
    OR p_file !~ '^(migrations|supabase/migrations|src/db/migrations|platform)/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$'
    OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 2147483646
    OR p_expected_execution_generation IS NULL OR p_expected_execution_generation NOT BETWEEN 0 AND 2147483646
    OR p_operator_id IS NULL OR p_operator_id !~ '[^[:space:]]' OR char_length(p_operator_id) > 200
    OR p_reason IS NULL OR p_reason !~ '[^[:space:]]' OR char_length(p_reason) > 2000
    OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' OR octet_length(p_evidence::text) > 4096 THEN
    RAISE EXCEPTION 'Invalid migration execution handoff input' USING ERRCODE = '22023';
  END IF;
  -- Requirement first serializes absent-row checks with lifecycle/diagnostic RPCs.
  SELECT * INTO r FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Handoff requirement missing' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO saved FROM public.requirement_migration_execution_handoffs WHERE id = p_request_id;
  IF FOUND THEN
    IF saved.requirement_id IS DISTINCT FROM p_requirement_id OR saved.file IS DISTINCT FROM p_file
      OR saved.instance_id IS DISTINCT FROM p_instance_id OR saved.transferred_version <> p_expected_version + 1
      OR saved.execution_generation <> p_expected_execution_generation
      OR saved.operator_id IS DISTINCT FROM p_operator_id OR saved.reason IS DISTINCT FROM p_reason
      OR saved.evidence IS DISTINCT FROM p_evidence THEN
      RAISE EXCEPTION 'Handoff request identity conflict' USING ERRCODE = '23505';
    END IF;
    -- Historical read, even after pause/resume, spec changes or evidence expiry.
    RETURN jsonb_build_object('receipt_id', saved.id, 'state', 'transferred', 'resumed', false);
  END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_execution_handoffs
    WHERE requirement_id = r.id AND file = p_file) THEN
    RAISE EXCEPTION 'Migration execution already transferred' USING ERRCODE = '23505';
  END IF;
  IF r.status IS DISTINCT FROM 'blocked' OR r.cron_lock_active IS DISTINCT FROM false
    OR r.cron_lock_expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Handoff requires an idle blocked requirement' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(r.metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid handoff metadata' USING ERRCODE = '22023';
  END IF;
  v_generation := CASE WHEN r.metadata ? 'requirement_execution_generation'
    THEN r.metadata->>'requirement_execution_generation' ELSE '0' END;
  IF v_generation IS NULL OR v_generation !~ '^(0|[1-9][0-9]{0,9})$' THEN
    RAISE EXCEPTION 'Invalid handoff execution generation' USING ERRCODE = '22023';
  END IF;
  IF v_generation::bigint <> p_expected_execution_generation::bigint
    OR r.metadata->>'runner_instance_id' IS DISTINCT FROM p_instance_id::text THEN
    RAISE EXCEPTION 'Stale handoff generation or runner' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.requirement_migration_lifecycle WHERE requirement_id = r.id ORDER BY file FOR UPDATE;
  SELECT * INTO old_row FROM public.requirement_migration_lifecycle WHERE requirement_id = r.id AND file = p_file;
  IF NOT FOUND OR old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'Stale handoff lifecycle version' USING ERRCODE = '40001';
  END IF;
  IF old_row.state NOT IN ('platform_review','correction_required')
    OR (old_row.review IS NOT NULL AND (jsonb_typeof(old_row.review) <> 'object'
      OR old_row.review->>'decision' = 'approved_for_validation')) THEN
    RAISE EXCEPTION 'Migration is not eligible for execution handoff' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.requirement_migration_diagnostics WHERE requirement_id = r.id ORDER BY file FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_diagnostics WHERE requirement_id = r.id
    AND state IN ('running','followup_reviewing')) THEN
    RAISE EXCEPTION 'Migration diagnosis is active or consumed by review' USING ERRCODE = '23514';
  END IF;
  SELECT to_jsonb(d) INTO v_diagnostic FROM public.requirement_migration_diagnostics d
    WHERE requirement_id = r.id AND file = p_file;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_reconciliations h WHERE h.requirement_id = r.id
    AND NOT EXISTS (SELECT 1 FROM public.requirement_migration_reconciliation_resumes s WHERE s.receipt_id = h.id)) THEN
    RAISE EXCEPTION 'Migration reconciliation still requires its own resume' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO i FROM public.remote_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND OR i.site_id IS DISTINCT FROM r.site_id OR i.is_archived IS DISTINCT FROM false
    OR COALESCE(i.status, '') NOT IN ('pending','running') THEN
    RAISE EXCEPTION 'Handoff runner is not eligible' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.instance_plans WHERE instance_id = i.id OR metadata->>'requirement_id' = r.id::text
    ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.instance_plans WHERE metadata->>'requirement_id' = r.id::text
    AND COALESCE(metadata->>'workflow_template','false') <> 'true' AND status = 'paused') THEN
    RAISE EXCEPTION 'Handoff cannot consume a manual plan pause' USING ERRCODE = '40001';
  END IF;
  -- The existing visibility trigger clears platform holds on transition. Never
  -- let it erase unrelated metadata. Other lifecycle rows remain untouched.
  IF (r.metadata ? 'execution_hold' AND NOT (
      r.metadata#>>'{execution_hold,kind}' IS NOT DISTINCT FROM 'migration_platform_review'
      AND r.metadata#>>'{execution_hold,file}' IS NOT DISTINCT FROM p_file))
    OR NULLIF(r.metadata->>'cron_blocker_provenance', '') IS NOT NULL THEN
    RAISE EXCEPTION 'Requirement has another execution hold' USING ERRCODE = '23514';
  END IF;
  IF r.instructions IS NULL OR r.instructions !~ '[^[:space:]]' OR octet_length(r.instructions) > 65536 THEN
    RAISE EXCEPTION 'Canonical specification missing' USING ERRCODE = '23514';
  END IF;
  IF NOT (p_evidence ?& v_keys) OR (p_evidence - v_keys) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid handoff evidence keys' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF v_key NOT IN ('receipt_found','feedback_registered') AND jsonb_typeof(p_evidence->v_key) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid handoff evidence type' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_evidence->>'apps_project_ref' !~ '^[a-z]{20}$'
    OR p_evidence->>'tenant_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_evidence->>'schema' IS DISTINCT FROM 'app_' || left(replace(r.id::text, '-', ''), 24)
    OR p_evidence->>'sandbox_name' IS DISTINCT FROM 'req-' || left(r.id::text, 8) || '-' || left(i.id::text, 8)
    OR p_evidence->>'file' IS DISTINCT FROM p_file
    OR p_evidence->>'sql_checksum' !~ '^[a-f0-9]{64}$'
    OR p_evidence->>'feedback_checksum' IS DISTINCT FROM p_evidence->>'sql_checksum'
    OR p_evidence->>'specification_checksum' IS DISTINCT FROM encode(sha256(convert_to(r.instructions, 'UTF8')), 'hex')
    OR p_evidence->'receipt_found' IS DISTINCT FROM 'false'::jsonb
    OR p_evidence->'feedback_registered' IS DISTINCT FROM 'true'::jsonb
    OR p_evidence->>'observed_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
    RAISE EXCEPTION 'Handoff evidence scope mismatch' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_observed := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid handoff observation time' USING ERRCODE = '22023';
  END;
  v_now := clock_timestamp();
  IF NOT isfinite(v_observed) OR v_observed < v_now - interval '5 minutes' OR v_observed > v_now THEN
    RAISE EXCEPTION 'Stale or future handoff evidence' USING ERRCODE = '40001';
  END IF;
  -- Insert BEFORE updating the row; every later failure rolls back both.
  INSERT INTO public.requirement_migration_execution_handoffs
    (id,requirement_id,file,site_id,instance_id,operator_id,reason,prior_lifecycle,prior_diagnostic,
      evidence,execution_generation,transferred_version,created_at)
    VALUES (p_request_id,r.id,p_file,r.site_id,i.id,p_operator_id,p_reason,to_jsonb(old_row),v_diagnostic,
      p_evidence,p_expected_execution_generation,old_row.version + 1,v_now);
  UPDATE public.requirement_migration_lifecycle SET state = 'transferred', version = old_row.version + 1,
    updated_at = v_now WHERE requirement_id = r.id AND file = p_file RETURNING * INTO new_row;
  IF NOT public.migration_execution_handoff_matches(new_row) THEN
    RAISE EXCEPTION 'Handoff lifecycle changed unexpectedly' USING ERRCODE = '40001';
  END IF;
  -- correction_required may still have a stale projection; remove only this
  -- file's projection. Never clear another hold published by the visibility RPC.
  UPDATE public.requirements SET metadata = metadata - 'execution_hold' WHERE id = r.id
    AND metadata#>>'{execution_hold,kind}' = 'migration_platform_review'
    AND metadata#>>'{execution_hold,file}' = p_file;
  INSERT INTO public.instance_logs(instance_id,site_id,log_type,level,message,details)
    VALUES (i.id,r.site_id,'system','info','Legacy migration execution authority transferred; execution remains blocked. No validation was granted.',
      jsonb_build_object('event','migration_execution_handoff','receipt_id',p_request_id,
        'requirement_id',r.id,'transferred_version',new_row.version,
        'execution_generation',p_expected_execution_generation,'state','transferred','resumed',false));
  RETURN jsonb_build_object('receipt_id',p_request_id,'state','transferred','resumed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.transfer_requirement_migration_execution(uuid,text,integer,integer,uuid,uuid,text,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transfer_requirement_migration_execution(uuid,text,integer,integer,uuid,uuid,text,text,jsonb)
  TO service_role;

COMMIT;