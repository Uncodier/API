-- Authoring/support receipts only: never completion, user action, review approval,
-- execution admission, hold release, budget reset, or notification delivery.
-- Adaptation may rewrite linked instructions only on wholly pending owned plans;
-- active, paused, mixed-state, or ambiguously associated plans are never rewritten.
BEGIN;

CREATE TABLE public.requirement_harness_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES public.requirements(id),
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id),
  site_id uuid NOT NULL,
  request_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve_backlog', 'adapt_backlog', 'escalate_support')),
  item_id text CHECK (item_id IS NULL OR char_length(item_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 4000),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  contract_snapshot jsonb NOT NULL CHECK (jsonb_typeof(contract_snapshot) = 'object'),
  status text NOT NULL CHECK (status IN ('applied', 'recorded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  email_state text NOT NULL DEFAULT 'unconfigured'
    CHECK (email_state IN ('pending', 'sending', 'sent', 'failed', 'unconfigured')),
  email_attempted_at timestamptz,
  email_error text CHECK (char_length(email_error) <= 2000),
  UNIQUE (requirement_id, request_id)
);
CREATE INDEX requirement_harness_support_snapshot_idx
  ON public.requirement_harness_decisions (requirement_id, item_id)
  WHERE decision = 'escalate_support';
ALTER TABLE public.requirement_harness_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY requirement_harness_decisions_service_read
  ON public.requirement_harness_decisions FOR SELECT TO service_role USING (true);
CREATE POLICY requirement_harness_decisions_service_delivery
  ON public.requirement_harness_decisions FOR UPDATE TO service_role USING (true) WITH CHECK (true);
-- Override default privileges too; no direct service INSERT/DELETE or authoring UPDATE.
REVOKE ALL ON public.requirement_harness_decisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.requirement_harness_decisions TO service_role;
GRANT UPDATE (email_state, email_attempted_at, email_error)
  ON public.requirement_harness_decisions TO service_role;
COMMENT ON COLUMN public.requirement_harness_decisions.email_state IS
  'Server delivery CAS pending/failed -> sending; never automatically reclaim sending (uncertain delivery).';

CREATE FUNCTION public.record_harness_diagnostic_decision(
  p_site_id uuid,
  p_requirement_id uuid,
  p_instance_id uuid,
  p_expected_backlog_revision bigint,
  p_expected_updated_at timestamptz,
  p_request_id uuid,
  p_decision text,
  p_item_id text,
  p_reason text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requirement public.requirements%ROWTYPE;
  v_instance public.remote_instances%ROWTYPE;
  v_receipt public.requirement_harness_decisions%ROWTYPE;
  v_log public.instance_logs%ROWTYPE;
  v_plan public.instance_plans%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
  v_owner boolean;
  v_plan_id uuid;
  v_next_steps jsonb;
  v_plan_instructions text;
  v_plans_updated integer := 0;
  v_steps_updated integer := 0;
  v_bound_steps integer;
  v_keys text[];
  v_key text;
  v_refs text[];
  v_text text;
  v_value jsonb;
  v_item jsonb;
  v_index bigint;
  v_count integer;
  v_revision bigint;
  v_snapshot jsonb;
  v_effects jsonb;
BEGIN
  IF p_site_id IS NULL OR p_requirement_id IS NULL OR p_instance_id IS NULL
    OR p_request_id IS NULL OR p_expected_backlog_revision IS NULL
    OR p_expected_backlog_revision < 0 OR p_expected_updated_at IS NULL
    OR NOT isfinite(p_expected_updated_at)
    OR p_decision IS NULL OR p_decision NOT IN ('approve_backlog', 'adapt_backlog', 'escalate_support')
    OR p_reason IS NULL OR p_reason !~ '[^[:space:]]' OR char_length(p_reason) > 4000
    OR (p_item_id IS NOT NULL AND (p_item_id !~ '[^[:space:]]' OR char_length(p_item_id) > 200))
    OR (p_decision <> 'escalate_support' AND p_item_id IS NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_arguments';
  END IF;

  -- Same lock as backlog CAS / cron ownership. Scope is supplied by the server,
  -- never inferred from model payload, evidence, or a historic plan alone.
  SELECT * INTO v_requirement FROM public.requirements
    WHERE id = p_requirement_id AND site_id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'harness_decision_scope_denied';
  END IF;
  SELECT * INTO v_instance FROM public.remote_instances
    WHERE id = p_instance_id AND site_id = p_site_id AND is_archived IS NOT TRUE FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'harness_decision_scope_denied';
  END IF;
  v_owner := COALESCE(v_requirement.metadata->>'runner_instance_id' = p_instance_id::text, false)
    OR COALESCE(v_requirement.metadata->>'assistant_origin_instance_id' = p_instance_id::text, false);
  IF NOT v_owner THEN
    IF p_decision <> 'escalate_support' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'harness_decision_owner_required';
    END IF;
    SELECT id INTO v_plan_id FROM public.instance_plans
      WHERE site_id = p_site_id AND instance_id = p_instance_id
        AND metadata->>'requirement_id' = p_requirement_id::text
      ORDER BY id LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'harness_decision_link_required';
    END IF;
  END IF;

  -- Exact semantic replay may outlive CAS tokens, cron leases, and item status.
  -- Never reapply it. Current tenant/instance/ownership authorization still holds.
  SELECT * INTO v_receipt FROM public.requirement_harness_decisions
    WHERE requirement_id = p_requirement_id AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.site_id IS DISTINCT FROM p_site_id OR v_receipt.instance_id IS DISTINCT FROM p_instance_id
      OR v_receipt.decision IS DISTINCT FROM p_decision OR v_receipt.item_id IS DISTINCT FROM p_item_id
      OR v_receipt.reason IS DISTINCT FROM p_reason OR v_receipt.payload IS DISTINCT FROM p_payload THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'harness_decision_request_conflict';
    END IF;
    RETURN jsonb_build_object('decision', to_jsonb(v_receipt), 'effects', v_receipt.contract_snapshot->'effects');
  END IF;
  v_revision := COALESCE(v_requirement.backlog_revision, 0);
  IF v_revision <> p_expected_backlog_revision
    OR v_requirement.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'harness_decision_stale_state';
  END IF;

  v_keys := CASE p_decision
    WHEN 'approve_backlog' THEN ARRAY['evidence_log_ids', 'verification']
    WHEN 'adapt_backlog' THEN ARRAY['evidence_log_ids', 'verification', 'implementation_instructions', 'equivalence_reason', 'acceptance_mapping']
    ELSE ARRAY['evidence_log_ids', 'verification', 'impact', 'requested_action', 'attempted_alternatives'] END;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text) > 65536
    OR NOT (p_payload ?& v_keys) OR p_payload - v_keys <> '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_payload_keys_or_size';
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF v_key IN ('evidence_log_ids', 'acceptance_mapping', 'attempted_alternatives') THEN CONTINUE; END IF;
    v_text := p_payload->>v_key;
    IF jsonb_typeof(p_payload->v_key) IS DISTINCT FROM 'string' OR v_text !~ '[^[:space:]]'
      OR char_length(v_text) > (CASE WHEN v_key = 'implementation_instructions' THEN 12000 ELSE 4000 END) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_text';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_payload->'evidence_log_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_evidence';
  END IF;
  -- Support may document inaccessible evidence; authoring must cite actual logs.
  IF jsonb_array_length(p_payload->'evidence_log_ids') > 20
    OR (p_decision <> 'escalate_support' AND jsonb_array_length(p_payload->'evidence_log_ids') = 0) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_evidence';
  END IF;
  FOR v_value IN SELECT value FROM jsonb_array_elements(p_payload->'evidence_log_ids') LOOP
    v_text := v_value #>> '{}';
    IF jsonb_typeof(v_value) <> 'string'
      OR v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_evidence_id';
    END IF;
    SELECT * INTO v_log FROM public.instance_logs
      WHERE id = v_text::uuid AND site_id = p_site_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'harness_decision_evidence_scope_denied';
    END IF;
    v_refs := ARRAY[v_log.details->>'requirement_id', v_log.details->>'requirementId',
      v_log.tool_args->>'requirement_id', v_log.tool_args->>'requirementId'];
    IF EXISTS (SELECT 1 FROM unnest(v_refs) AS ref(value)
        WHERE NULLIF(value, '') IS NOT NULL AND value <> p_requirement_id::text)
      OR (NOT COALESCE(p_requirement_id::text = ANY(v_refs), false)
        AND v_log.instance_id IS DISTINCT FROM p_instance_id) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'harness_decision_evidence_scope_denied';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT lower(value)) FROM jsonb_array_elements_text(p_payload->'evidence_log_ids'))
      <> jsonb_array_length(p_payload->'evidence_log_ids') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'duplicate_harness_decision_evidence';
  END IF;

  IF p_item_id IS NOT NULL THEN
    IF jsonb_typeof(v_requirement.backlog->'items') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'harness_decision_item_missing';
    END IF;
    SELECT count(*) INTO v_count FROM jsonb_array_elements(v_requirement.backlog->'items') AS item(value)
      WHERE value->>'id' = p_item_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'harness_decision_item_missing_or_ambiguous';
    END IF;
    SELECT value, ordinality - 1 INTO v_item, v_index
      FROM jsonb_array_elements(v_requirement.backlog->'items') WITH ORDINALITY AS item(value, ordinality)
      WHERE value->>'id' = p_item_id;
  END IF;
  IF p_decision <> 'escalate_support' THEN
    IF COALESCE(v_requirement.status, '') NOT IN ('backlog', 'pending', 'in-progress', 'blocked')
      OR COALESCE(v_item->>'status', '') NOT IN ('pending', 'in_progress')
      OR COALESCE(v_item#>>'{review_quarantine,active}', 'false') <> 'false' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'harness_decision_item_not_editable';
    END IF;
    -- Approval is only a receipt, not a backlog mutation or execution authority.
    IF p_decision = 'adapt_backlog' AND v_requirement.cron_lock_active IS TRUE
      AND v_requirement.cron_lock_expires_at > clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'harness_decision_cron_busy';
    END IF;
    IF v_instance.status IN ('paused', 'stopped', 'stopping') OR EXISTS (
      SELECT 1 FROM public.remote_instances AS owner WHERE owner.site_id = p_site_id
        AND owner.id::text IN (v_requirement.metadata->>'runner_instance_id', v_requirement.metadata->>'assistant_origin_instance_id')
        AND owner.status IN ('paused', 'stopped', 'stopping')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'harness_decision_instance_paused';
    END IF;
    -- A current turn on the calling instance is expected. A different bound
    -- owner's unfinished trusted turn is not permission to overwrite its work.
    IF EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (instance_id) details FROM public.instance_logs
        WHERE site_id = p_site_id AND instance_id <> p_instance_id
          AND instance_id::text IN (v_requirement.metadata->>'runner_instance_id', v_requirement.metadata->>'assistant_origin_instance_id')
          AND log_type = 'user_action' AND trusted_user_action IS TRUE
        ORDER BY instance_id, created_at DESC, id DESC
      ) AS latest WHERE COALESCE(details->>'status', '') NOT IN ('completed', 'failed')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'harness_decision_other_conversation_busy';
    END IF;
  END IF;

  IF p_decision = 'adapt_backlog' THEN
    IF jsonb_typeof(p_payload->'acceptance_mapping') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_item->'acceptance') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_acceptance_mapping';
    END IF;
    IF jsonb_array_length(p_payload->'acceptance_mapping') > 50
      OR jsonb_array_length(p_payload->'acceptance_mapping') <> jsonb_array_length(v_item->'acceptance') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'harness_decision_acceptance_mapping_mismatch';
    END IF;
    v_count := 0;
    FOR v_value IN SELECT value FROM jsonb_array_elements(p_payload->'acceptance_mapping') LOOP
      IF jsonb_typeof(v_value) IS DISTINCT FROM 'object'
        OR NOT (v_value ?& ARRAY['criterion', 'implementation', 'verification'])
        OR v_value - ARRAY['criterion', 'implementation', 'verification'] <> '{}'::jsonb
        OR v_value->'criterion' IS DISTINCT FROM v_item->'acceptance'->v_count THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'harness_decision_acceptance_mapping_mismatch';
      END IF;
      FOREACH v_key IN ARRAY ARRAY['criterion', 'implementation', 'verification'] LOOP
        IF jsonb_typeof(v_value->v_key) IS DISTINCT FROM 'string'
          OR (v_value->>v_key) !~ '[^[:space:]]' OR char_length(v_value->>v_key) > 4000 THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_acceptance_text';
        END IF;
      END LOOP;
      v_count := v_count + 1;
    END LOOP;
    v_plan_instructions := p_payload->>'implementation_instructions'
      || E'\n\nVerification:\n' || (p_payload->>'verification')
      || E'\n\nEquivalence to original acceptance:\n' || (p_payload->>'equivalence_reason')
      || E'\n\nAcceptance mapping (original criteria unchanged):\n' || (p_payload->'acceptance_mapping')::text;
    -- Lock each relevant plan before checking its current steps/status. Terminal
    -- and blocked plans stay untouched; no cancelled/failed step is resurrected.
    -- Legacy instance-only associations are found, but cannot authorize a rewrite.
    FOR v_plan IN SELECT plan.* FROM public.instance_plans AS plan
      WHERE plan.site_id = p_site_id AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
        AND (plan.metadata->>'requirement_id' = p_requirement_id::text OR (
          NULLIF(plan.metadata->>'requirement_id', '') IS NULL AND plan.instance_id::text IN
            (p_instance_id::text, v_requirement.metadata->>'runner_instance_id', v_requirement.metadata->>'assistant_origin_instance_id')))
        AND (plan.metadata->>'backlog_item_id' = p_item_id OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(plan.steps) = 'array' THEN plan.steps ELSE '[]'::jsonb END) AS step(value)
          WHERE value->>'backlog_item_id' = p_item_id OR value#>>'{metadata,backlog_item_id}' = p_item_id
        )) ORDER BY plan.id FOR UPDATE
    LOOP
      IF v_plan.status <> 'pending'
        OR v_plan.metadata->>'requirement_id' IS DISTINCT FROM p_requirement_id::text
        OR NOT COALESCE(v_plan.instance_id::text IN
          (v_requirement.metadata->>'runner_instance_id', v_requirement.metadata->>'assistant_origin_instance_id'), false)
        OR jsonb_typeof(v_plan.steps) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'harness_decision_bound_plan_busy';
      END IF;
      IF jsonb_array_length(v_plan.steps) = 0 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_plan.steps) AS step(value)
        WHERE value->>'status' IS DISTINCT FROM 'pending'
          OR (value->>'backlog_item_id' = p_item_id OR value#>>'{metadata,backlog_item_id}' = p_item_id) AND (
            (NULLIF(value->>'backlog_item_id', '') IS NOT NULL AND value->>'backlog_item_id' <> p_item_id)
            OR (NULLIF(value#>>'{metadata,backlog_item_id}', '') IS NOT NULL AND value#>>'{metadata,backlog_item_id}' <> p_item_id)
            OR jsonb_typeof(value->'metadata') NOT IN ('object', 'null'))
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'harness_decision_bound_plan_busy';
      END IF;
      PERFORM 1 FROM public.remote_instances AS owner
        WHERE owner.id = v_plan.instance_id AND owner.site_id = p_site_id AND owner.is_archived IS NOT TRUE
          AND owner.status NOT IN ('paused', 'stopped', 'stopping') FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'harness_decision_bound_plan_busy';
      END IF;
      SELECT count(*) INTO v_bound_steps FROM jsonb_array_elements(v_plan.steps) AS step(value)
        WHERE value->>'backlog_item_id' = p_item_id OR value#>>'{metadata,backlog_item_id}' = p_item_id;
      IF v_bound_steps = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'harness_decision_bound_plan_busy';
      END IF;
      SELECT jsonb_agg(CASE
        WHEN value->>'backlog_item_id' = p_item_id OR value#>>'{metadata,backlog_item_id}' = p_item_id
        THEN value || jsonb_build_object('instructions', v_plan_instructions, 'metadata',
          COALESCE(NULLIF(value->'metadata', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('harness_decision_id', v_id))
        ELSE value END ORDER BY ordinal) INTO v_next_steps
        FROM jsonb_array_elements(v_plan.steps) WITH ORDINALITY AS step(value, ordinal);
      UPDATE public.instance_plans SET steps = v_next_steps,
        updated_at = GREATEST(clock_timestamp(), v_plan.updated_at + interval '1 microsecond')
        WHERE id = v_plan.id;
      v_plans_updated := v_plans_updated + 1;
      v_steps_updated := v_steps_updated + v_bound_steps;
    END LOOP;
  ELSIF p_decision = 'escalate_support' THEN
    IF jsonb_typeof(p_payload->'attempted_alternatives') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_alternatives';
    END IF;
    IF jsonb_array_length(p_payload->'attempted_alternatives') NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_alternatives';
    END IF;
    FOR v_value IN SELECT value FROM jsonb_array_elements(p_payload->'attempted_alternatives') LOOP
      IF jsonb_typeof(v_value) <> 'string' OR (v_value #>> '{}') !~ '[^[:space:]]'
        OR char_length(v_value #>> '{}') > 2000 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_decision_alternative_text';
      END IF;
    END LOOP;
    -- The requirement lock serializes this check with every decision insert.
    -- A new model request ID cannot deliver the same snapshot ticket twice.
    -- Exact request replay already returned above, with its original receipt.
    IF EXISTS (SELECT 1 FROM public.requirement_harness_decisions AS previous
      WHERE previous.requirement_id = p_requirement_id AND previous.decision = 'escalate_support'
        AND previous.item_id IS NOT DISTINCT FROM p_item_id
        AND previous.contract_snapshot->'backlog_revision' = to_jsonb(v_revision)
        AND (previous.contract_snapshot->>'requirement_updated_at')::timestamptz = v_requirement.updated_at
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'harness_support_ticket_exists';
    END IF;
  END IF;

  v_effects := jsonb_build_object('backlog_changed', p_decision = 'adapt_backlog',
    'backlog_revision', v_revision + CASE WHEN p_decision = 'adapt_backlog' THEN 1 ELSE 0 END,
    'plans_updated', v_plans_updated, 'plan_steps_updated', v_steps_updated,
    'execution_started', false);
  v_snapshot := jsonb_build_object('acceptance', v_item->'acceptance',
    'acceptance_contract', v_item->'acceptance_contract', 'constraints', v_item->'constraints',
    'tier', v_item->'tier', 'scope_level', v_item->'scope_level', 'depends_on', v_item->'depends_on',
    'requirement_instructions', v_requirement.instructions, 'backlog_revision', v_revision,
    'requirement_updated_at', v_requirement.updated_at, 'effects', v_effects);
  IF p_decision = 'adapt_backlog' THEN
    UPDATE public.requirements SET backlog = jsonb_set(v_requirement.backlog,
      ARRAY['items', v_index::text, 'implementation_strategy'], jsonb_build_object(
        'decision_id', v_id, 'instructions', p_payload->'implementation_instructions',
        'verification', p_payload->'verification', 'equivalence_reason', p_payload->'equivalence_reason',
        'acceptance_mapping', p_payload->'acceptance_mapping', 'recorded_at', v_now)),
      backlog_revision = v_revision + 1,
      updated_at = GREATEST(clock_timestamp(), v_requirement.updated_at + interval '1 microsecond')
    WHERE id = p_requirement_id;
  END IF;
  INSERT INTO public.requirement_harness_decisions
    (id, requirement_id, instance_id, site_id, request_id, decision, item_id, reason,
      payload, contract_snapshot, status, created_at, email_state)
  VALUES (v_id, p_requirement_id, p_instance_id, p_site_id, p_request_id, p_decision, p_item_id,
    p_reason, p_payload, v_snapshot, CASE WHEN p_decision = 'adapt_backlog' THEN 'applied' ELSE 'recorded' END,
    v_now, CASE WHEN p_decision = 'escalate_support' THEN 'pending' ELSE 'unconfigured' END)
  RETURNING * INTO v_receipt;
  RETURN jsonb_build_object('decision', to_jsonb(v_receipt), 'effects', v_effects);
END;
$$;
REVOKE ALL ON FUNCTION public.record_harness_diagnostic_decision(uuid, uuid, uuid, bigint, timestamptz, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_harness_diagnostic_decision(uuid, uuid, uuid, bigint, timestamptz, uuid, text, text, text, jsonb)
  TO service_role;

COMMIT;