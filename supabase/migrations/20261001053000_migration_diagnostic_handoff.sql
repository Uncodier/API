-- Target: Makinari requirements, NOT the Apps/tenant database.
-- One independent diagnosis per (requirement_id, file), not five repair rounds:
-- lifecycle attempts 0..5 remain the historical scheduling/review budget.
-- No backfill, hold release, requirement resume, generation/checksum reset, or
-- changes to transition_requirement_migration / its status guard are made here.
--
-- Service-only RPC contract (all return JSON rows; invalid/stale writes throw):
-- claim_migration_diagnostic: current active cron owner + lifecycle version CAS;
-- inserts once, returns NULL if a receipt already exists, never steals running.
-- complete_migration_diagnostic: exact token/generation/checksum/spec scope;
-- bounded result envelope only. TS MUST independently validate detailed evidence
-- and product choices. Exact completed-result replay is idempotent while the
-- original lifecycle scope still holds; a different result is never accepted.
-- assign_migration_diagnostic_followup: call ONLY after TS persists the plan
-- assignment; ready -> assigned (exact-scope assigned replay is idempotent).
-- This is a bounded handoff identity, NOT SQL approval or plan persistence.
-- begin_migration_diagnostic_review: application has no cron run ID; verifies
-- current generation/runnability + lifecycle version CAS. Consumes assigned once
-- for changed SQL and the exact original spec, retaining attempts=5. Returns the
-- standard lifecycle row. Prior/supplied review approval is discarded: a fresh
-- central reviewer and the existing validation path are still mandatory.
-- followup_reviewing is permanently consumed, including when the ordinary RPC
-- returns to correction_required/platform_review. It is not an expiring lease.
BEGIN;

CREATE TABLE public.requirement_migration_diagnostics (
  requirement_id uuid NOT NULL,
  file text NOT NULL,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  execution_generation integer NOT NULL CHECK (execution_generation >= 0),
  state text NOT NULL CHECK (state IN (
    'running', 'followup_ready', 'followup_assigned', 'followup_reviewing', 'exhausted'
  )),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  specification_checksum text NOT NULL CHECK (specification_checksum ~ '^[a-f0-9]{64}$'),
  result jsonb CHECK (result IS NULL OR (
    jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (requirement_id, file),
  FOREIGN KEY (requirement_id, file)
    REFERENCES public.requirement_migration_lifecycle(requirement_id, file)
);

ALTER TABLE public.requirement_migration_diagnostics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.requirement_migration_diagnostics FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.requirement_migration_diagnostics TO service_role;
CREATE POLICY requirement_migration_diagnostics_service_read
  ON public.requirement_migration_diagnostics FOR SELECT TO service_role USING (true);

-- Private lock/scope helper, not an alternate service entry point. Lock order is
-- always requirement -> lifecycle -> diagnostic (including absent-row claims).
CREATE FUNCTION public.lock_requirement_migration_diagnostic_scope(
  p_requirement_id uuid, p_file text, p_execution_generation integer,
  p_run_id text, p_require_cron_owner boolean
)
RETURNS public.requirement_migration_lifecycle
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_requirement public.requirements%ROWTYPE;
  v_lifecycle public.requirement_migration_lifecycle%ROWTYPE;
  v_generation_text text;
  v_generation integer;
BEGIN
  IF p_requirement_id IS NULL OR p_file IS NULL OR octet_length(p_file) > 512
    OR p_file !~ '^(migrations|supabase/migrations|src/db/migrations|platform)/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$'
    OR p_execution_generation IS NULL OR p_execution_generation < 0
    OR p_require_cron_owner IS NULL
    OR (p_require_cron_owner AND NULLIF(btrim(p_run_id), '') IS NULL)
  THEN
    RAISE EXCEPTION 'Invalid migration diagnostic scope' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_requirement FROM public.requirements
    WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration requirement does not exist' USING ERRCODE = 'P0002';
  END IF;
  -- Same strict generation decoding as the ordinary lifecycle transition.
  IF v_requirement.metadata IS NOT NULL AND jsonb_typeof(v_requirement.metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid requirement execution generation' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_requirement.metadata ? 'requirement_execution_generation', false) THEN
    v_generation_text := v_requirement.metadata->>'requirement_execution_generation';
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
  IF v_generation IS DISTINCT FROM p_execution_generation THEN
    RAISE EXCEPTION 'Stale requirement execution generation' USING ERRCODE = '40001';
  END IF;
  IF COALESCE(v_requirement.status, '') NOT IN ('backlog', 'in-progress')
    OR EXISTS (SELECT 1 FROM public.remote_instances AS instance
      WHERE instance.id::text = v_requirement.metadata->>'runner_instance_id'
        AND (instance.status IN ('paused', 'stopped', 'stopping') OR instance.is_archived IS TRUE))
    OR COALESCE((SELECT plan.status FROM public.instance_plans AS plan
      WHERE plan.instance_id::text = v_requirement.metadata->>'runner_instance_id'
        AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
      ORDER BY plan.created_at DESC, plan.id DESC LIMIT 1), '') = 'paused'
  THEN
    RAISE EXCEPTION 'Migration diagnostic requirement is not runnable' USING ERRCODE = '40001';
  END IF;
  IF p_require_cron_owner AND (
    public.assert_requirement_cron_execution_owner(
      p_requirement_id, p_run_id, p_execution_generation, false, false
    )->'current' IS DISTINCT FROM 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'Stale migration diagnostic execution owner' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_lifecycle FROM public.requirement_migration_lifecycle
    WHERE requirement_id = p_requirement_id AND file = p_file FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration lifecycle does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF v_lifecycle.state <> 'correction_required' OR v_lifecycle.attempts <> 5 THEN
    RAISE EXCEPTION 'Migration diagnostic requires exhausted historical budget in correction_required' USING ERRCODE = '23514';
  END IF;
  RETURN v_lifecycle;
END;
$function$;
REVOKE ALL ON FUNCTION public.lock_requirement_migration_diagnostic_scope(uuid, text, integer, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_migration_diagnostic(
  p_requirement_id uuid, p_file text, p_expected_version integer,
  p_execution_generation integer, p_run_id text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_lifecycle public.requirement_migration_lifecycle%ROWTYPE;
  v_result public.requirement_migration_diagnostics%ROWTYPE;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 1 OR p_expected_version >= 2147483647 THEN
    RAISE EXCEPTION 'Invalid migration lifecycle version' USING ERRCODE = '22023';
  END IF;
  v_lifecycle := public.lock_requirement_migration_diagnostic_scope(
    p_requirement_id, p_file, p_execution_generation, p_run_id, true);
  IF v_lifecycle.version <> p_expected_version THEN
    RAISE EXCEPTION 'Migration lifecycle version conflict' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.requirement_migration_diagnostics (
    requirement_id, file, execution_generation, state, checksum, specification_checksum
  ) VALUES (
    p_requirement_id, p_file, p_execution_generation, 'running', v_lifecycle.checksum, v_lifecycle.specification_checksum
  ) ON CONFLICT (requirement_id, file) DO NOTHING RETURNING * INTO v_result;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_result);
END;
$function$;

CREATE FUNCTION public.complete_migration_diagnostic(
  p_requirement_id uuid, p_file text, p_token uuid,
  p_execution_generation integer, p_run_id text, p_result jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_lifecycle public.requirement_migration_lifecycle%ROWTYPE;
  v_diagnostic public.requirement_migration_diagnostics%ROWTYPE;
  v_decision text;
BEGIN
  IF p_token IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR octet_length(p_result::text) > 65536
    OR jsonb_typeof(p_result->'decision') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_result->'evidence') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Invalid migration diagnostic result' USING ERRCODE = '22023';
  END IF;
  v_decision := p_result->>'decision';
  IF v_decision NOT IN ('repair_candidate', 'missing_capability', 'needs_product_decision', 'constraint_conflict', 'unresolved')
    OR (v_decision <> 'unresolved' AND jsonb_array_length(p_result->'evidence') = 0)
    OR (v_decision = 'repair_candidate' AND EXISTS (
      SELECT 1 FROM unnest(ARRAY['hypothesis', 'instruction', 'verification']) AS fields(key)
      WHERE jsonb_typeof(p_result->key) IS DISTINCT FROM 'string' OR (p_result->>key) !~ '[^[:space:]]'
    ))
    OR (v_decision <> 'repair_candidate' AND (
      jsonb_typeof(p_result->'reason') IS DISTINCT FROM 'string' OR (p_result->>'reason') !~ '[^[:space:]]'
    ))
  THEN
    RAISE EXCEPTION 'Invalid migration diagnostic result' USING ERRCODE = '22023';
  END IF;
  v_lifecycle := public.lock_requirement_migration_diagnostic_scope(
    p_requirement_id, p_file, p_execution_generation, p_run_id, true);
  SELECT * INTO v_diagnostic FROM public.requirement_migration_diagnostics
    WHERE requirement_id = p_requirement_id AND file = p_file FOR UPDATE;
  IF NOT FOUND OR v_diagnostic.token IS DISTINCT FROM p_token
    OR v_diagnostic.execution_generation IS DISTINCT FROM p_execution_generation
    OR v_diagnostic.checksum IS DISTINCT FROM v_lifecycle.checksum
    OR v_diagnostic.specification_checksum IS DISTINCT FROM v_lifecycle.specification_checksum
  THEN
    RAISE EXCEPTION 'Migration diagnostic scope conflict' USING ERRCODE = '40001';
  END IF;
  IF v_diagnostic.state <> 'running' THEN
    IF v_diagnostic.state IN ('followup_ready', 'followup_assigned', 'exhausted')
      AND v_diagnostic.result = p_result THEN RETURN to_jsonb(v_diagnostic); END IF;
    RAISE EXCEPTION 'Migration diagnostic result already consumed' USING ERRCODE = '40001';
  END IF;
  UPDATE public.requirement_migration_diagnostics SET
    state = CASE WHEN v_decision = 'repair_candidate' THEN 'followup_ready' ELSE 'exhausted' END,
    result = p_result, updated_at = clock_timestamp()
    WHERE requirement_id = p_requirement_id AND file = p_file RETURNING * INTO v_diagnostic;
  RETURN to_jsonb(v_diagnostic);
END;
$function$;

CREATE FUNCTION public.assign_migration_diagnostic_followup(
  p_requirement_id uuid, p_file text, p_token uuid,
  p_execution_generation integer, p_run_id text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_lifecycle public.requirement_migration_lifecycle%ROWTYPE;
  v_diagnostic public.requirement_migration_diagnostics%ROWTYPE;
BEGIN
  IF p_token IS NULL THEN
    RAISE EXCEPTION 'Invalid migration diagnostic token' USING ERRCODE = '22023';
  END IF;
  v_lifecycle := public.lock_requirement_migration_diagnostic_scope(
    p_requirement_id, p_file, p_execution_generation, p_run_id, true);
  SELECT * INTO v_diagnostic FROM public.requirement_migration_diagnostics
    WHERE requirement_id = p_requirement_id AND file = p_file FOR UPDATE;
  IF NOT FOUND OR v_diagnostic.token IS DISTINCT FROM p_token
    OR v_diagnostic.execution_generation IS DISTINCT FROM p_execution_generation
    OR v_diagnostic.checksum IS DISTINCT FROM v_lifecycle.checksum
    OR v_diagnostic.specification_checksum IS DISTINCT FROM v_lifecycle.specification_checksum
    OR v_diagnostic.state NOT IN ('followup_ready', 'followup_assigned')
  THEN
    RAISE EXCEPTION 'Migration diagnostic followup scope conflict' USING ERRCODE = '40001';
  END IF;
  IF v_diagnostic.state = 'followup_assigned' THEN RETURN to_jsonb(v_diagnostic); END IF;
  UPDATE public.requirement_migration_diagnostics SET state = 'followup_assigned', updated_at = clock_timestamp()
    WHERE requirement_id = p_requirement_id AND file = p_file RETURNING * INTO v_diagnostic;
  RETURN to_jsonb(v_diagnostic);
END;
$function$;

CREATE FUNCTION public.begin_migration_diagnostic_review(
  p_requirement_id uuid, p_file text, p_expected_version integer,
  p_execution_generation integer, p_value jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_previous public.requirement_migration_lifecycle%ROWTYPE;
  v_result public.requirement_migration_lifecycle%ROWTYPE;
  v_diagnostic public.requirement_migration_diagnostics%ROWTYPE;
  v_original_sql text;
BEGIN
  -- Explicit bounded counterpart of the original lifecycle validation, not a
  -- relaxation of its +1 reviewing rule. Only assigned followup can retain 5.
  IF p_expected_version IS NULL OR p_expected_version < 1 OR p_expected_version >= 2147483647
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
  IF p_value->>'state' <> 'reviewing' OR p_value->>'attempts' <> '5'
    OR (p_value->>'checksum') !~ '^[a-f0-9]{64}$'
    OR (p_value->>'specification_checksum') !~ '^[a-f0-9]{64}$'
    OR octet_length(p_value->>'original_sql') > 65536 OR char_length(p_value->>'reason') > 2048
  THEN
    RAISE EXCEPTION 'Invalid migration lifecycle value' USING ERRCODE = '22023';
  END IF;
  v_previous := public.lock_requirement_migration_diagnostic_scope(
    p_requirement_id, p_file, p_execution_generation, NULL, false);
  IF v_previous.version <> p_expected_version THEN
    RAISE EXCEPTION 'Migration lifecycle version conflict' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_diagnostic FROM public.requirement_migration_diagnostics
    WHERE requirement_id = p_requirement_id AND file = p_file FOR UPDATE;
  IF NOT FOUND OR v_diagnostic.state <> 'followup_assigned'
    OR v_diagnostic.execution_generation IS DISTINCT FROM p_execution_generation
    OR v_diagnostic.specification_checksum IS DISTINCT FROM v_previous.specification_checksum
  THEN
    RAISE EXCEPTION 'Migration diagnostic followup is not assigned in this scope' USING ERRCODE = '40001';
  END IF;
  IF p_value->>'specification_checksum' IS DISTINCT FROM v_previous.specification_checksum THEN
    RAISE EXCEPTION 'Migration specification checksum is immutable' USING ERRCODE = '23514';
  END IF;
  IF p_value->>'checksum' = v_diagnostic.checksum THEN
    RAISE EXCEPTION 'Migration diagnostic followup must materialize changed SQL' USING ERRCODE = '23514';
  END IF;
  v_original_sql := v_previous.original_sql;
  IF p_value ? 'original_sql' THEN
    IF p_value->>'original_sql' IS DISTINCT FROM v_previous.original_sql THEN
      RAISE EXCEPTION 'Original migration SQL is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  UPDATE public.requirement_migration_lifecycle SET
    version = v_previous.version + 1, state = 'reviewing', checksum = p_value->>'checksum',
    original_sql = v_original_sql, reason = p_value->>'reason', review = NULL,
    attempts = 5, updated_at = clock_timestamp()
    WHERE requirement_id = p_requirement_id AND file = p_file RETURNING * INTO v_result;
  UPDATE public.requirement_migration_diagnostics SET state = 'followup_reviewing', updated_at = clock_timestamp()
    WHERE requirement_id = p_requirement_id AND file = p_file;
  RETURN to_jsonb(v_result);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_migration_diagnostic(uuid, text, integer, integer, text),
  public.complete_migration_diagnostic(uuid, text, uuid, integer, text, jsonb),
  public.assign_migration_diagnostic_followup(uuid, text, uuid, integer, text),
  public.begin_migration_diagnostic_review(uuid, text, integer, integer, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_migration_diagnostic(uuid, text, integer, integer, text),
  public.complete_migration_diagnostic(uuid, text, uuid, integer, text, jsonb),
  public.assign_migration_diagnostic_followup(uuid, text, uuid, integer, text),
  public.begin_migration_diagnostic_review(uuid, text, integer, integer, jsonb)
  TO service_role;

-- Settle only the still-owned diagnostic's runner/plan together with its hold.
-- This avoids leaving an idle instance running after the requirement becomes
-- non-runnable. Never undo an explicit pause or touch another generation/owner.
CREATE FUNCTION public.hold_migration_diagnostic(
  p_requirement_id uuid, p_file text, p_expected_version integer,
  p_execution_generation integer, p_run_id text, p_plan_id uuid, p_step_id text,
  p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_row public.requirement_migration_lifecycle%ROWTYPE;
  v_diag public.requirement_migration_diagnostics%ROWTYPE;
  v_plan public.instance_plans%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 1 OR p_plan_id IS NULL
    OR NULLIF(btrim(p_step_id), '') IS NULL OR NULLIF(btrim(p_reason), '') IS NULL
    OR char_length(p_reason) > 2048 THEN
    RAISE EXCEPTION 'Invalid diagnostic hold' USING ERRCODE = '22023';
  END IF;
  v_row := public.lock_requirement_migration_diagnostic_scope(
    p_requirement_id, p_file, p_execution_generation, p_run_id, true);
  IF v_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'Migration lifecycle version conflict' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_diag FROM public.requirement_migration_diagnostics
    WHERE requirement_id=p_requirement_id AND file=p_file FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No independent diagnosis' USING ERRCODE = '40001'; END IF;
  SELECT * INTO v_plan FROM public.instance_plans WHERE id=p_plan_id FOR UPDATE;
  IF NOT FOUND OR v_plan.metadata->>'requirement_id' IS DISTINCT FROM p_requirement_id::text
    OR v_plan.instance_id::text IS DISTINCT FROM
      (SELECT metadata->>'runner_instance_id' FROM public.requirements WHERE id=p_requirement_id)
    OR v_plan.status NOT IN ('pending','in_progress','active','completed','failed')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan.steps) s WHERE s->>'id'=p_step_id)
  THEN RAISE EXCEPTION 'Diagnostic plan scope changed' USING ERRCODE = '40001'; END IF;
  v_result := public.transition_requirement_migration(p_requirement_id, p_file, p_expected_version,
    p_execution_generation, jsonb_build_object('state','platform_review','checksum',v_row.checksum,
      'specification_checksum',v_row.specification_checksum,'original_sql',v_row.original_sql,
      'reason',p_reason,'review',jsonb_build_object('diagnostic_id',v_diag.token,'diagnosis',v_diag.result),
      'attempts',v_row.attempts));
  UPDATE public.instance_plans SET status='blocked', updated_at=clock_timestamp(),
    steps=(SELECT jsonb_agg(CASE WHEN s->>'id'=p_step_id AND s->>'status' NOT IN ('completed','cancelled')
      THEN s || jsonb_build_object('status','blocked','error_message',p_reason) ELSE s END ORDER BY n)
      FROM jsonb_array_elements(v_plan.steps) WITH ORDINALITY e(s,n))
    WHERE id=p_plan_id;
  UPDATE public.remote_instances SET status='pending', updated_at=clock_timestamp()
    WHERE id=v_plan.instance_id AND status='running';
  INSERT INTO public.requirement_status(site_id,instance_id,requirement_id,stage,message)
    SELECT site_id,v_plan.instance_id,id,'blocked',p_reason FROM public.requirements WHERE id=p_requirement_id;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.hold_migration_diagnostic(uuid,text,integer,integer,text,uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hold_migration_diagnostic(uuid,text,integer,integer,text,uuid,text,text) TO service_role;

COMMIT;

-- Rollback requires disabling diagnostic callers and reconciling receipts first;
-- dropping the table would discard the durable one-diagnosis allowance boundary.