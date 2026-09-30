-- Target: Makinari (requirements), NOT the Apps/tenant database.
-- Apply before enabling lifecycle callers. Missing persistence must fail closed.
BEGIN;

CREATE TABLE public.requirement_migration_lifecycle (
  requirement_id uuid NOT NULL REFERENCES public.requirements(id),
  file text NOT NULL CHECK (
    octet_length(file) <= 512 AND
    file ~ '^(migrations|supabase/migrations|src/db/migrations|platform)/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$'
  ),
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN (
    'correction_required', 'reviewing', 'validation_pending', 'validated', 'platform_review'
  )),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  specification_checksum text NOT NULL CHECK (specification_checksum ~ '^[a-f0-9]{64}$'),
  original_sql text CHECK (octet_length(original_sql) <= 65536),
  reason text NOT NULL CHECK (char_length(reason) <= 2048),
  review jsonb,
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 5),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (requirement_id, file)
);

ALTER TABLE public.requirement_migration_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.requirement_migration_lifecycle FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.requirement_migration_lifecycle TO service_role;
CREATE POLICY requirement_migration_lifecycle_service_read
  ON public.requirement_migration_lifecycle FOR SELECT TO service_role USING (true);

CREATE FUNCTION public.transition_requirement_migration(
  p_requirement_id uuid,
  p_file text,
  p_expected_version integer,
  p_expected_execution_generation integer,
  p_value jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_metadata jsonb;
  v_generation_text text;
  v_generation integer;
  v_previous public.requirement_migration_lifecycle%ROWTYPE;
  v_result public.requirement_migration_lifecycle%ROWTYPE;
  v_exists boolean;
  v_state text;
  v_checksum text;
  v_specification_checksum text;
  v_original_sql text;
  v_reason text;
  v_review jsonb;
  v_attempts integer;
BEGIN
  IF p_requirement_id IS NULL OR p_file IS NULL OR octet_length(p_file) > 512
    OR p_file !~ '^(migrations|supabase/migrations|src/db/migrations|platform)/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$'
    OR p_expected_version IS NULL OR p_expected_version < 0 OR p_expected_version >= 2147483647
    OR p_expected_execution_generation IS NULL OR p_expected_execution_generation < 0
    OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'Invalid migration lifecycle input' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_value->'state') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_value->'checksum') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_value->'specification_checksum') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_value->'reason') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_value->'attempts') IS DISTINCT FROM 'number'
    OR (p_value ? 'original_sql' AND jsonb_typeof(p_value->'original_sql') NOT IN ('string', 'null'))
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) AS fields(key)
      WHERE key NOT IN ('state', 'checksum', 'specification_checksum', 'original_sql', 'reason', 'review', 'attempts'))
  THEN
    RAISE EXCEPTION 'Invalid migration lifecycle value' USING ERRCODE = '22023';
  END IF;

  v_state := p_value->>'state';
  v_checksum := p_value->>'checksum';
  v_specification_checksum := p_value->>'specification_checksum';
  v_original_sql := p_value->>'original_sql';
  v_reason := p_value->>'reason';
  IF v_state NOT IN ('correction_required', 'reviewing', 'validation_pending', 'validated', 'platform_review')
    OR v_checksum !~ '^[a-f0-9]{64}$' OR v_specification_checksum !~ '^[a-f0-9]{64}$'
    OR octet_length(v_original_sql) > 65536 OR char_length(v_reason) > 2048
    OR (p_value->>'attempts') !~ '^[0-5]$'
  THEN
    RAISE EXCEPTION 'Invalid migration lifecycle value' USING ERRCODE = '22023';
  END IF;
  v_attempts := (p_value->>'attempts')::integer;

  -- This lock also serializes absent-row inserts and requirements status changes.
  -- Always acquire it BEFORE the lifecycle lock. No advisory/GUC bypass exists.
  SELECT metadata INTO v_metadata FROM public.requirements
    WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration requirement does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF v_metadata IS NOT NULL AND jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid requirement execution generation' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_metadata ? 'requirement_execution_generation', false) THEN
    v_generation_text := v_metadata->>'requirement_execution_generation';
    IF v_generation_text IS NULL OR v_generation_text !~ '^(0|[1-9][0-9]{0,9})$' THEN
      RAISE EXCEPTION 'Invalid requirement execution generation' USING ERRCODE = '22023';
    END IF;
    IF v_generation_text::bigint > 2147483647 THEN
      RAISE EXCEPTION 'Invalid requirement execution generation' USING ERRCODE = '22023';
    END IF;
    v_generation := v_generation_text::integer;
  ELSE
    v_generation := 0;
  END IF;
  IF v_generation IS DISTINCT FROM p_expected_execution_generation THEN
    RAISE EXCEPTION 'Stale requirement execution generation' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_previous FROM public.requirement_migration_lifecycle
    WHERE requirement_id = p_requirement_id AND file = p_file FOR UPDATE;
  v_exists := FOUND;
  IF (NOT v_exists AND p_expected_version <> 0)
    OR (v_exists AND v_previous.version <> p_expected_version)
  THEN
    RAISE EXCEPTION 'Migration lifecycle version conflict' USING ERRCODE = '40001';
  END IF;

  IF NOT v_exists THEN
    IF v_state NOT IN ('correction_required', 'reviewing', 'platform_review')
      OR (v_state = 'reviewing' AND v_attempts <> 1)
    THEN
      RAISE EXCEPTION 'Invalid initial migration lifecycle state' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- A reviewing row is a durable lease, not an expiring retry hint. An
    -- interrupted reviewer must be reconciled, not silently reacquired/reset.
    IF NOT (
      (v_previous.state = 'correction_required' AND v_state IN ('correction_required', 'reviewing', 'platform_review'))
      OR (v_previous.state = 'reviewing' AND v_state IN ('correction_required', 'validation_pending', 'platform_review'))
      -- A known atomic SQL rollback may be sent back for correction.
      OR (v_previous.state = 'validation_pending' AND v_state IN ('correction_required', 'validated', 'platform_review'))
      OR (v_previous.state = 'validated' AND v_state = 'platform_review')
      -- Only this service-role RPC can explicitly release a platform hold.
      -- Release does not reopen the requirement or skip fresh validation.
      OR (v_previous.state = 'platform_review' AND v_state IN ('platform_review', 'correction_required', 'validation_pending'))
    ) THEN
      RAISE EXCEPTION 'Invalid migration lifecycle transition' USING ERRCODE = '23514';
    END IF;
    IF v_attempts < v_previous.attempts
      OR (v_state = 'reviewing' AND v_attempts <> v_previous.attempts + 1)
    THEN
      RAISE EXCEPTION 'Migration review attempts cannot reset or reuse a lease' USING ERRCODE = '23514';
    END IF;
    IF v_specification_checksum IS DISTINCT FROM v_previous.specification_checksum THEN
      RAISE EXCEPTION 'Migration specification checksum is immutable' USING ERRCODE = '23514';
    END IF;
    IF v_checksum IS DISTINCT FROM v_previous.checksum AND NOT (
      v_previous.state = 'correction_required' AND v_state IN ('correction_required', 'reviewing')
    ) THEN
      RAISE EXCEPTION 'Reviewed migration checksum is immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT (p_value ? 'original_sql') THEN
      v_original_sql := v_previous.original_sql;
    ELSIF v_previous.original_sql IS NOT NULL AND v_original_sql IS DISTINCT FROM v_previous.original_sql THEN
      RAISE EXCEPTION 'Original migration SQL is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  v_review := CASE WHEN p_value ? 'review' THEN NULLIF(p_value->'review', 'null'::jsonb)
    ELSE v_previous.review END;

  IF v_exists THEN
    UPDATE public.requirement_migration_lifecycle SET
      version = v_previous.version + 1, state = v_state, checksum = v_checksum,
      specification_checksum = v_specification_checksum, original_sql = v_original_sql,
      reason = v_reason, review = v_review, attempts = v_attempts, updated_at = clock_timestamp()
    WHERE requirement_id = p_requirement_id AND file = p_file RETURNING * INTO v_result;
  ELSE
    INSERT INTO public.requirement_migration_lifecycle (
      requirement_id, file, version, state, checksum, specification_checksum,
      original_sql, reason, review, attempts
    ) VALUES (
      p_requirement_id, p_file, 1, v_state, v_checksum, v_specification_checksum,
      v_original_sql, v_reason, v_review, v_attempts
    ) RETURNING * INTO v_result;
  END IF;

  IF v_state = 'platform_review' THEN
    UPDATE public.requirements SET status = 'blocked' WHERE id = p_requirement_id;
  END IF;
  RETURN to_jsonb(v_result);
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_requirement_migration(uuid, text, integer, integer, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transition_requirement_migration(uuid, text, integer, integer, jsonb)
  TO service_role;

CREATE FUNCTION public.guard_requirement_migration_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  -- Only transitions are evaluated. Ordinary metadata/heartbeat updates and
  -- setting blocked are legal, including the atomic platform-review write.
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status = 'blocked' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_lifecycle
    WHERE requirement_id = NEW.id AND state = 'platform_review')
  THEN
    RAISE EXCEPTION 'Requirement is blocked by migration platform review' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('done', 'on-review') AND EXISTS (
    SELECT 1 FROM public.requirement_migration_lifecycle
    WHERE requirement_id = NEW.id AND state <> 'validated'
  ) THEN
    RAISE EXCEPTION 'Requirement has unvalidated migration lifecycle records' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_requirement_migration_status() FROM PUBLIC, anon, authenticated, service_role;

-- AFTER sees the final status even when another BEFORE trigger changed it on
-- a metadata-only UPDATE. Raising aborts the entire statement/outer RPC.
CREATE TRIGGER requirement_migration_status_guard
  AFTER UPDATE ON public.requirements
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.guard_requirement_migration_status();

COMMIT;

-- Rollback requires disabling lifecycle callers and reconciling outstanding
-- holds first; dropping the guard/table otherwise discards the safety boundary.