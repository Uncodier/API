-- Target: Makinari, NEVER Apps. Operator opt-in; no automatic backfill/resume.
-- Retires legacy execution authority, not SQL/history/product validation.
-- Unlike a workspace handoff, this receipt makes NO assertion about remote bytes,
-- application or receipt absence. The normal Apps history/policy gates still apply.
BEGIN;

CREATE TABLE public.requirement_migration_retirements (
  id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL REFERENCES public.requirements(id),
  file text NOT NULL,
  site_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id),
  operator_id text NOT NULL CHECK (char_length(btrim(operator_id)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  execution_generation integer NOT NULL CHECK (execution_generation BETWEEN 0 AND 2147483646),
  transferred_version integer NOT NULL CHECK (transferred_version > 1),
  prior_lifecycle jsonb NOT NULL CHECK (jsonb_typeof(prior_lifecycle) = 'object'),
  prior_diagnostic jsonb CHECK (jsonb_typeof(prior_diagnostic) = 'object'),
  prior_requirement_metadata jsonb NOT NULL CHECK (jsonb_typeof(prior_requirement_metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (requirement_id, file),
  FOREIGN KEY (requirement_id, file)
    REFERENCES public.requirement_migration_lifecycle(requirement_id, file)
);
ALTER TABLE public.requirement_migration_retirements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.requirement_migration_retirements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.requirement_migration_retirements TO service_role;
CREATE POLICY migration_retirements_service_read ON public.requirement_migration_retirements
  FOR SELECT TO service_role USING (true);
CREATE FUNCTION public.reject_migration_retirement_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Migration retirement receipts are append-only' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.reject_migration_retirement_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER migration_retirements_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.requirement_migration_retirements
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_migration_retirement_mutation();

-- Existing runtime understands transferred. Each authority-transfer route has
-- its OWN private receipt; never fabricate a workspace/SQL validation attestation.
CREATE OR REPLACE FUNCTION public.migration_execution_handoff_matches(p_row public.requirement_migration_lifecycle)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_row.state = 'transferred' AND (
    EXISTS (
      SELECT 1 FROM public.requirement_migration_execution_handoffs h
      JOIN public.requirements r ON r.id = h.requirement_id AND r.site_id = h.site_id
      WHERE h.requirement_id = p_row.requirement_id AND h.file = p_row.file
        AND h.transferred_version = p_row.version
        AND h.prior_lifecycle->'version' = to_jsonb(p_row.version - 1)
        AND h.created_at = p_row.updated_at
        AND h.prior_lifecycle->>'state' IN ('platform_review', 'correction_required')
        AND h.prior_lifecycle - ARRAY['state','version','updated_at']
          = to_jsonb(p_row) - ARRAY['state','version','updated_at']
    ) OR EXISTS (
      SELECT 1 FROM public.requirement_migration_retirements h
      JOIN public.requirements r ON r.id = h.requirement_id AND r.site_id = h.site_id
      WHERE h.requirement_id = p_row.requirement_id AND h.file = p_row.file
        AND h.transferred_version = p_row.version
        AND h.prior_lifecycle->'version' = to_jsonb(p_row.version - 1)
        AND h.created_at = p_row.updated_at
        AND h.prior_lifecycle->>'state' IN ('platform_review', 'correction_required')
        AND h.prior_lifecycle - ARRAY['state','version','updated_at']
          = to_jsonb(p_row) - ARRAY['state','version','updated_at']
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.guard_migration_execution_handoff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (OLD.state = 'transferred' OR EXISTS (
    SELECT 1 FROM public.requirement_migration_execution_handoffs h
    WHERE h.requirement_id = OLD.requirement_id AND h.file = OLD.file
  ) OR EXISTS (
    SELECT 1 FROM public.requirement_migration_retirements h
    WHERE h.requirement_id = OLD.requirement_id AND h.file = OLD.file
  )) THEN
    IF TG_OP <> 'UPDATE' OR OLD.state = 'transferred' OR NEW.state <> 'transferred' THEN
      RAISE EXCEPTION 'Transferred migration lifecycle is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.state = 'transferred' THEN
    IF TG_OP <> 'UPDATE' OR NOT public.migration_execution_handoff_matches(NEW)
      OR NOT (EXISTS (
        SELECT 1 FROM public.requirement_migration_execution_handoffs h
        WHERE h.requirement_id = NEW.requirement_id AND h.file = NEW.file
          AND h.prior_lifecycle = to_jsonb(OLD)
      ) OR EXISTS (
        SELECT 1 FROM public.requirement_migration_retirements h
        WHERE h.requirement_id = NEW.requirement_id AND h.file = NEW.file
          AND h.prior_lifecycle = to_jsonb(OLD)
      )) THEN
      RAISE EXCEPTION 'Transferred migration requires its matching immutable receipt' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.migration_execution_handoff_matches(public.requirement_migration_lifecycle),
  public.guard_migration_execution_handoff() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.retire_requirement_migration_hold(
  p_requirement_id uuid, p_file text, p_expected_version integer,
  p_expected_execution_generation integer, p_instance_id uuid, p_request_id uuid,
  p_operator_id text, p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.requirements%ROWTYPE;
  i public.remote_instances%ROWTYPE;
  l public.requirement_migration_lifecycle%ROWTYPE;
  saved public.requirement_migration_retirements%ROWTYPE;
  diagnostic jsonb;
  generation text;
  observed timestamptz;
BEGIN
  IF p_requirement_id IS NULL OR p_instance_id IS NULL OR p_request_id IS NULL
    OR p_file IS NULL OR octet_length(p_file) > 512
    OR p_file !~ '^(migrations|supabase/migrations|src/db/migrations|platform)/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$'
    OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 2147483646
    OR p_expected_execution_generation IS NULL OR p_expected_execution_generation NOT BETWEEN 0 AND 2147483646
    OR p_operator_id IS NULL OR char_length(btrim(p_operator_id)) NOT BETWEEN 1 AND 200
    OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Invalid migration retirement input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retirement requirement missing' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO saved FROM public.requirement_migration_retirements WHERE id = p_request_id;
  IF FOUND THEN
    IF saved.requirement_id IS DISTINCT FROM p_requirement_id OR saved.file IS DISTINCT FROM p_file
      OR saved.instance_id IS DISTINCT FROM p_instance_id OR saved.operator_id IS DISTINCT FROM p_operator_id
      OR saved.reason IS DISTINCT FROM p_reason OR saved.transferred_version <> p_expected_version + 1
      OR saved.execution_generation <> p_expected_execution_generation THEN
      RAISE EXCEPTION 'Retirement request identity conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('receipt_id',saved.id,'state','transferred','resumed',false,'already_recorded',true);
  END IF;
  IF r.cron_lock_active IS DISTINCT FROM false OR r.cron_lock_expires_at > clock_timestamp()
    OR COALESCE(r.status, '') NOT IN ('blocked','paused') THEN
    RAISE EXCEPTION 'Retirement requires an idle blocked or paused requirement' USING ERRCODE = '40001';
  END IF;
  generation := CASE WHEN r.metadata ? 'requirement_execution_generation'
    THEN r.metadata->>'requirement_execution_generation' ELSE '0' END;
  IF jsonb_typeof(r.metadata) IS DISTINCT FROM 'object' OR generation IS NULL
    OR generation !~ '^(0|[1-9][0-9]{0,9})$' THEN
    RAISE EXCEPTION 'Invalid retirement execution generation' USING ERRCODE = '22023';
  END IF;
  IF generation::bigint <> p_expected_execution_generation
    OR r.metadata->>'runner_instance_id' IS DISTINCT FROM p_instance_id::text THEN
    RAISE EXCEPTION 'Stale retirement generation or owner' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO i FROM public.remote_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND OR i.site_id IS DISTINCT FROM r.site_id OR i.user_id IS DISTINCT FROM r.user_id THEN
    RAISE EXCEPTION 'Retirement owner scope mismatch' USING ERRCODE = '40001';
  END IF;
  -- Archived/error owners may have their obsolete authority retired, but this
  -- operation never unarchives, resumes, replaces or assigns an owner.
  SELECT * INTO l FROM public.requirement_migration_lifecycle
    WHERE requirement_id = r.id AND file = p_file FOR UPDATE;
  IF NOT FOUND OR l.version <> p_expected_version THEN
    RAISE EXCEPTION 'Stale retirement lifecycle version' USING ERRCODE = '40001';
  END IF;
  IF l.state NOT IN ('platform_review','correction_required') THEN
    RAISE EXCEPTION 'Active review, validation or transferred history cannot be retired' USING ERRCODE = '23514';
  END IF;
  IF r.metadata ? 'execution_hold' AND (
    r.metadata#>>'{execution_hold,kind}' IS DISTINCT FROM 'migration_platform_review'
    OR r.metadata#>>'{execution_hold,file}' IS DISTINCT FROM p_file
  ) THEN
    RAISE EXCEPTION 'Unrelated execution hold prevents retirement' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.requirement_migration_diagnostics WHERE requirement_id = r.id ORDER BY file FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_diagnostics WHERE requirement_id = r.id
    AND state IN ('running','followup_reviewing')) OR EXISTS (
    SELECT 1 FROM public.requirement_migration_reconciliations c WHERE c.requirement_id = r.id
      AND NOT EXISTS (SELECT 1 FROM public.requirement_migration_reconciliation_resumes s WHERE s.receipt_id = c.id)
  ) THEN
    RAISE EXCEPTION 'Active diagnosis or unfinished reconciliation prevents retirement' USING ERRCODE = '23514';
  END IF;
  SELECT to_jsonb(d) INTO diagnostic FROM public.requirement_migration_diagnostics d
    WHERE d.requirement_id = r.id AND d.file = p_file;
  observed := clock_timestamp();
  INSERT INTO public.requirement_migration_retirements
    (id,requirement_id,file,site_id,instance_id,operator_id,reason,execution_generation,
      transferred_version,prior_lifecycle,prior_diagnostic,prior_requirement_metadata,created_at)
    VALUES (p_request_id,r.id,p_file,r.site_id,i.id,p_operator_id,p_reason,p_expected_execution_generation,
      l.version + 1,to_jsonb(l),diagnostic,r.metadata,observed);
  UPDATE public.requirement_migration_lifecycle SET state = 'transferred', version = l.version + 1,
    updated_at = observed WHERE requirement_id = r.id AND file = p_file;
  UPDATE public.requirements SET metadata = metadata - 'execution_hold' WHERE id = r.id
    AND metadata#>>'{execution_hold,kind}' = 'migration_platform_review'
    AND metadata#>>'{execution_hold,file}' = p_file;
  INSERT INTO public.instance_logs(instance_id,site_id,log_type,level,message,details)
    VALUES (i.id,r.site_id,'system','info',
      'Legacy migration hold retired by operator. No SQL was applied or validated; execution has not resumed.',
      jsonb_build_object('event','migration_legacy_retirement','receipt_id',p_request_id,
        'requirement_id',r.id,'file',p_file,'state','transferred','resumed',false));
  RETURN jsonb_build_object('receipt_id',p_request_id,'state','transferred','resumed',false,'already_recorded',false);
END;
$$;
REVOKE ALL ON FUNCTION public.retire_requirement_migration_hold(uuid,text,integer,integer,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retire_requirement_migration_hold(uuid,text,integer,integer,uuid,uuid,text,text)
  TO service_role;
COMMIT;