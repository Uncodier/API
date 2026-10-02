-- Target: Makinari. Forward-only convergence of an observed unrecorded draft.
-- On fresh databases apply 20261002010000 first. Do not fabricate resume evidence.
-- Used draft receipts without evidence require manual reconciliation instead.
BEGIN;
LOCK TABLE public.requirement_migration_reconciliation_resumes IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.requirement_migration_reconciliation_resumes ADD COLUMN IF NOT EXISTS evidence jsonb;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.requirement_migration_reconciliation_resumes WHERE evidence IS NULL) THEN
    RAISE EXCEPTION 'Draft resume receipts need manual evidence reconciliation; do not fabricate evidence';
  END IF;
END $$;
ALTER TABLE public.requirement_migration_reconciliation_resumes ALTER COLUMN evidence SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.requirement_migration_reconciliation_resumes'::regclass
    AND conname='requirement_migration_reconciliation_resumes_evidence_check') THEN
    ALTER TABLE public.requirement_migration_reconciliation_resumes
      ADD CONSTRAINT requirement_migration_reconciliation_resumes_evidence_check CHECK (jsonb_typeof(evidence) = 'object');
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.resume_reconciled_requirement_migration(uuid,uuid);

CREATE OR REPLACE FUNCTION public.lock_migration_reconciliation_scope(
  p_requirement_id uuid, p_file text, p_instance_id uuid, p_plan_id uuid,
  p_step_id text, p_generation integer, p_backlog_revision bigint
)
RETURNS public.requirements LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.requirements%ROWTYPE;
  i public.remote_instances%ROWTYPE;
  p public.instance_plans%ROWTYPE;
  s jsonb;
  b jsonb;
  v_item_id text;
  v_generation text;
BEGIN
  SELECT * INTO r FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation requirement missing' USING ERRCODE = 'P0002'; END IF;
  IF r.status IS DISTINCT FROM 'blocked' OR r.cron_lock_active IS DISTINCT FROM false
    OR r.cron_lock_expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Reconciliation requires an idle blocked requirement' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(r.metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid reconciliation metadata' USING ERRCODE = '22023';
  END IF;
  v_generation := COALESCE(r.metadata->>'requirement_execution_generation', '0');
  IF (r.metadata ? 'requirement_execution_generation' AND r.metadata->'requirement_execution_generation' = 'null'::jsonb)
    OR v_generation !~ '^(0|[1-9][0-9]{0,9})$' THEN
    RAISE EXCEPTION 'Invalid reconciliation generation' USING ERRCODE = '22023';
  END IF;
  IF v_generation::bigint IS DISTINCT FROM p_generation::bigint
    OR r.backlog_revision IS DISTINCT FROM p_backlog_revision THEN
    RAISE EXCEPTION 'Stale reconciliation generation or backlog' USING ERRCODE = '40001';
  END IF;
  IF r.metadata->>'runner_instance_id' IS DISTINCT FROM p_instance_id::text THEN
    RAISE EXCEPTION 'Reconciliation owner changed' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.requirement_migration_lifecycle WHERE requirement_id = r.id ORDER BY file FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_diagnostics WHERE requirement_id = r.id AND file = p_file) THEN
    RAISE EXCEPTION 'Migration diagnosis already exists' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_lifecycle
    WHERE requirement_id = r.id AND file <> p_file AND state <> 'validated') THEN
    RAISE EXCEPTION 'Requirement has another unresolved migration' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO i FROM public.remote_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND OR i.site_id IS DISTINCT FROM r.site_id OR i.is_archived IS TRUE
    OR COALESCE(i.status, '') NOT IN ('pending', 'running') THEN
    RAISE EXCEPTION 'Reconciliation instance is not eligible' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.instance_plans
    WHERE instance_id = i.id OR metadata->>'requirement_id' = r.id::text ORDER BY id FOR UPDATE;
  SELECT * INTO p FROM public.instance_plans WHERE id = p_plan_id;
  IF NOT FOUND OR p.instance_id IS DISTINCT FROM i.id OR p.site_id IS DISTINCT FROM r.site_id
    OR p.metadata->>'requirement_id' IS DISTINCT FROM r.id::text
    OR COALESCE(p.metadata->>'workflow_template', 'false') <> 'false'
    OR COALESCE(p.status, '') NOT IN ('pending', 'in_progress', 'active')
    OR jsonb_typeof(p.steps) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Reconciliation plan is not eligible' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.instance_plans AS other
    WHERE other.id <> p.id AND (other.instance_id = i.id OR other.metadata->>'requirement_id' = r.id::text)
      AND COALESCE(other.metadata->>'workflow_template', 'false') <> 'true'
      AND (COALESCE(other.status, '') NOT IN ('completed', 'cancelled', 'failed')
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(other.steps) = 'array'
          THEN other.steps ELSE '[{}]'::jsonb END) AS step
          WHERE COALESCE(step->>'status', '') NOT IN ('completed', 'cancelled', 'failed')))) THEN
    RAISE EXCEPTION 'Competing reconciliation plan' USING ERRCODE = '40001';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p.steps) AS step WHERE step->>'id' = p_step_id) <> 1 THEN
    RAISE EXCEPTION 'Reconciliation step missing or ambiguous' USING ERRCODE = '23514';
  END IF;
  SELECT step INTO s FROM jsonb_array_elements(p.steps) AS step WHERE step->>'id' = p_step_id;
  IF s->>'status' IS DISTINCT FROM 'pending' OR s->'requires_sandbox' IS DISTINCT FROM 'true'::jsonb
    OR p.steps->-1->>'id' IS DISTINCT FROM p_step_id
    OR (s ? 'metadata' AND jsonb_typeof(s->'metadata') IS DISTINCT FROM 'object')
    OR COALESCE(s->'metadata', '{}'::jsonb) ?| ARRAY['migration_correction_key','migration_diagnostic_token',
      'migration_diagnostic_file','migration_correction_run_id','migration_correction_files','repair_run','repair_source_step_id']
    OR COALESCE(s->'infrastructure_circuit_open', 'false'::jsonb) <> 'false'::jsonb
    OR COALESCE(s->'infrastructure_waiting', 'false'::jsonb) <> 'false'::jsonb
    OR COALESCE(s->'infrastructure_intervention_required', 'false'::jsonb) <> 'false'::jsonb
    OR COALESCE(s->>'infrastructure_state', 'ready') NOT IN ('ready', 'healthy')
    OR NULLIF(s->>'infra_retry_after', '') IS NOT NULL
    OR COALESCE(s->>'infra_retry_count', '0') !~ '^[0-3]$'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.steps) AS step
      WHERE step->>'id' IS DISTINCT FROM p_step_id AND COALESCE(step->>'status', '') NOT IN ('completed', 'cancelled')) THEN
    RAISE EXCEPTION 'Reconciliation step is not pending and runnable' USING ERRCODE = '23514';
  END IF;
  v_item_id := COALESCE(s#>>'{metadata,backlog_item_id}', s->>'backlog_item_id');
  IF NULLIF(v_item_id, '') IS NULL OR (s ? 'backlog_item_id' AND s#>>'{metadata,backlog_item_id}' IS NOT NULL
      AND s->>'backlog_item_id' IS DISTINCT FROM s#>>'{metadata,backlog_item_id}')
    OR jsonb_typeof(r.backlog->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Reconciliation backlog binding invalid' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(r.backlog->'items') AS item WHERE item->>'id' = v_item_id) <> 1 THEN
    RAISE EXCEPTION 'Reconciliation backlog item missing or ambiguous' USING ERRCODE = '23514';
  END IF;
  SELECT item INTO b FROM jsonb_array_elements(r.backlog->'items') AS item WHERE item->>'id' = v_item_id;
  IF COALESCE(b->>'status', '') NOT IN ('pending', 'in_progress')
    OR COALESCE(b->'blocked_by', '[]'::jsonb) <> '[]'::jsonb
    OR COALESCE(b#>'{review_quarantine,active}', 'false'::jsonb) <> 'false'::jsonb
    OR COALESCE(b->'plan_cancellation_pending', 'null'::jsonb) <> 'null'::jsonb
    OR COALESCE(b->>'attempts', '') !~ '^[0-9]{1,9}$'
    OR jsonb_typeof(COALESCE(b->'depends_on', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Reconciliation backlog item is not runnable' USING ERRCODE = '23514';
  END IF;
  -- Conservative defaults from requirement-flows (core 4, ornamental 2);
  -- operators must also honor stricter deployment limits. No budget is reset.
  IF (b->>'attempts')::integer >= (CASE WHEN b->>'tier' = 'ornamental' THEN 2 ELSE 4 END)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(b->'depends_on', '[]'::jsonb)) AS dep(id)
      WHERE (SELECT count(*) FROM jsonb_array_elements(r.backlog->'items') AS item
        WHERE item->>'id' = dep.id AND item->>'status' = 'done') <> 1) THEN
    RAISE EXCEPTION 'Reconciliation backlog budget or dependencies blocked' USING ERRCODE = '23514';
  END IF;
  RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_migration_reconciliation_scope(uuid,text,uuid,uuid,text,integer,bigint)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reconcile_requirement_migration(
  p_requirement_id uuid, p_file text, p_expected_version integer,
  p_expected_execution_generation integer, p_expected_updated_at timestamptz,
  p_expected_backlog_revision bigint, p_instance_id uuid, p_plan_id uuid,
  p_step_id text, p_request_id uuid, p_operator_id text, p_reason text, p_evidence jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  r public.requirements%ROWTYPE;
  old_row public.requirement_migration_lifecycle%ROWTYPE;
  new_row public.requirement_migration_lifecycle%ROWTYPE;
  saved public.requirement_migration_reconciliations%ROWTYPE;
  v_request jsonb;
  v_keys text[] := ARRAY['apps_project_ref','tenant_id','schema','observed_at','sql_checksum',
    'receipt_found','sandbox_name','specification_checksum'];
  v_key text;
  v_hash text;
  v_observed timestamptz;
  v_now timestamptz;
BEGIN
  IF p_requirement_id IS NULL OR p_instance_id IS NULL OR p_plan_id IS NULL OR p_request_id IS NULL
    OR p_file IS NULL OR octet_length(p_file) > 512
    OR p_file !~ '^migrations/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$'
    OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 2147483646
    OR p_expected_execution_generation IS NULL OR p_expected_execution_generation NOT BETWEEN 0 AND 2147483646
    OR p_expected_updated_at IS NULL OR NOT isfinite(p_expected_updated_at)
    OR p_expected_backlog_revision IS NULL OR p_expected_backlog_revision < 0
    OR p_step_id IS NULL OR p_step_id !~ '[^[:space:]]' OR char_length(p_step_id) > 200
    OR p_operator_id IS NULL OR p_operator_id !~ '[^[:space:]]' OR char_length(p_operator_id) > 200
    OR p_reason IS NULL OR p_reason !~ '[^[:space:]]' OR char_length(p_reason) > 2000
    OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' OR octet_length(p_evidence::text) > 4096 THEN
    RAISE EXCEPTION 'Invalid migration reconciliation input' USING ERRCODE = '22023';
  END IF;
  v_request := jsonb_build_object('requirement_id', p_requirement_id, 'file', p_file,
    'expected_version', p_expected_version, 'expected_execution_generation', p_expected_execution_generation,
    'expected_updated_at', p_expected_updated_at, 'expected_backlog_revision', p_expected_backlog_revision,
    'instance_id', p_instance_id, 'plan_id', p_plan_id, 'step_id', p_step_id,
    'request_id', p_request_id, 'operator_id', p_operator_id, 'reason', p_reason, 'evidence', p_evidence);
  -- Serialize absence checks, CAS and transitions. Replays are historical reads,
  -- not renewed evidence or an instruction to mutate whatever is current now.
  PERFORM 1 FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  SELECT * INTO saved FROM public.requirement_migration_reconciliations WHERE id = p_request_id;
  IF FOUND THEN
    IF saved.request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Reconciliation request conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('receipt_id', saved.id, 'lifecycle', saved.lifecycle, 'resumed', false);
  END IF;
  IF EXISTS (SELECT 1 FROM public.requirement_migration_reconciliations
    WHERE requirement_id = p_requirement_id AND file = p_file) THEN
    RAISE EXCEPTION 'Migration was already reconciled' USING ERRCODE = '23505';
  END IF;
  r := public.lock_migration_reconciliation_scope(p_requirement_id, p_file, p_instance_id,
    p_plan_id, p_step_id, p_expected_execution_generation, p_expected_backlog_revision);
  IF r.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Stale reconciliation requirement' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO old_row FROM public.requirement_migration_lifecycle
    WHERE requirement_id = r.id AND file = p_file;
  IF NOT FOUND OR old_row.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Stale reconciliation lifecycle' USING ERRCODE = '40001';
  END IF;
  IF old_row.state <> 'platform_review' OR old_row.attempts <> 5
    OR old_row.reason <> 'A pending migration has no requirement-bound implementation plan; technical review is required.'
    OR (old_row.review IS NOT NULL AND (jsonb_typeof(old_row.review) IS DISTINCT FROM 'object'
      OR old_row.review->>'decision' IS DISTINCT FROM 'request_changes'
      OR (old_row.review ? 'reason' AND jsonb_typeof(old_row.review->'reason') IS DISTINCT FROM 'string')
      OR (old_row.review - ARRAY['decision','reason']) <> '{}'::jsonb)) THEN
    RAISE EXCEPTION 'Migration is not the legacy missing-plan hold' USING ERRCODE = '23514';
  END IF;
  IF r.instructions IS NULL OR r.instructions !~ '[^[:space:]]' OR octet_length(r.instructions) > 65536 THEN
    RAISE EXCEPTION 'Canonical specification missing' USING ERRCODE = '23514';
  END IF;
  v_hash := encode(sha256(convert_to(r.instructions, 'UTF8')), 'hex');
  IF v_hash = old_row.specification_checksum THEN
    RAISE EXCEPTION 'Reconciliation requires a changed specification' USING ERRCODE = '23514';
  END IF;
  -- Do not let the existing hold-visibility trigger erase a different hold.
  IF (r.metadata ? 'execution_hold' AND NOT (
      r.metadata#>>'{execution_hold,kind}' IS NOT DISTINCT FROM 'migration_platform_review'
      AND r.metadata#>>'{execution_hold,file}' IS NOT DISTINCT FROM p_file))
    OR NULLIF(r.metadata->>'cron_blocker_provenance', '') IS NOT NULL THEN
    RAISE EXCEPTION 'Requirement has another execution hold' USING ERRCODE = '23514';
  END IF;
  IF NOT (p_evidence ?& v_keys) OR (p_evidence - v_keys) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid reconciliation evidence keys' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF v_key <> 'receipt_found' AND jsonb_typeof(p_evidence->v_key) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid reconciliation evidence type' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_evidence->>'apps_project_ref' !~ '^[a-z]{20}$'
    OR p_evidence->>'tenant_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_evidence->>'schema' !~ '^app_[a-f0-9]{24}$'
    OR p_evidence->>'schema' IS DISTINCT FROM 'app_' || left(replace(r.id::text, '-', ''), 24)
    OR p_evidence->'receipt_found' IS DISTINCT FROM 'false'::jsonb
    OR p_evidence->>'sql_checksum' IS DISTINCT FROM old_row.checksum
    OR p_evidence->>'specification_checksum' IS DISTINCT FROM v_hash
    OR p_evidence->>'sandbox_name' IS DISTINCT FROM 'req-' || left(r.id::text, 8) || '-' || left(p_instance_id::text, 8)
    OR p_evidence->>'observed_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
    RAISE EXCEPTION 'Reconciliation evidence scope mismatch' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_observed := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid reconciliation observation time' USING ERRCODE = '22023';
  END;
  v_now := clock_timestamp();
  IF NOT isfinite(v_observed) OR v_observed < v_now - interval '5 minutes' OR v_observed > v_now + interval '30 seconds' THEN
    RAISE EXCEPTION 'Stale reconciliation evidence' USING ERRCODE = '40001';
  END IF;
  new_row := old_row;
  new_row.specification_checksum := v_hash;
  new_row.state := 'correction_required';
  new_row.review := NULL;
  new_row.version := old_row.version + 1;
  new_row.reason := 'Operator reconciled the legacy missing-plan specification binding. Fresh independent diagnosis, security review and validation remain mandatory; budgets are unchanged.';
  new_row.updated_at := v_now;
  -- Archive the complete original row BEFORE rebinding. Frozen response is also
  -- append-only; a retry never returns a later reviewer/validation transition.
  INSERT INTO public.requirement_migration_reconciliations
    (id,requirement_id,file,site_id,instance_id,plan_id,step_id,operator_id,reason,
      execution_generation,backlog_revision,prior_lifecycle,specification_checksum,specification,evidence,request,lifecycle)
    VALUES (p_request_id,r.id,p_file,r.site_id,p_instance_id,p_plan_id,p_step_id,p_operator_id,p_reason,
      p_expected_execution_generation,p_expected_backlog_revision,to_jsonb(old_row),v_hash,r.instructions,p_evidence,v_request,to_jsonb(new_row))
    RETURNING * INTO saved;
  UPDATE public.requirement_migration_lifecycle SET specification_checksum = new_row.specification_checksum,
    state = new_row.state, review = NULL, version = new_row.version, reason = new_row.reason, updated_at = new_row.updated_at
    WHERE requirement_id = r.id AND file = p_file RETURNING * INTO old_row;
  IF to_jsonb(old_row) IS DISTINCT FROM to_jsonb(new_row) THEN
    RAISE EXCEPTION 'Reconciliation transition changed unexpectedly' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.instance_logs(instance_id,site_id,log_type,level,message,details)
    VALUES (p_instance_id,r.site_id,'system','info','Migration specification reconciled; execution remains blocked.',
      jsonb_build_object('event','migration_operator_reconciliation','receipt_id',p_request_id,
        'requirement_id',r.id,'plan_id',p_plan_id,'step_id',p_step_id,'file',p_file,
        'receipt_found',false,'observed_at',v_observed,'sql_checksum',old_row.checksum,
        'specification_checksum',v_hash,'prior_specification_checksum',saved.prior_lifecycle->>'specification_checksum'));
  INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,message)
    VALUES (r.id,r.site_id,p_instance_id,'blocked',
      'Migration specification reconciled. Execution remains blocked until an explicit checked resume; fresh security review and validation are required.');
  RETURN jsonb_build_object('receipt_id',p_request_id,'lifecycle',to_jsonb(new_row),'resumed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_requirement_migration(uuid,text,integer,integer,timestamptz,bigint,uuid,uuid,text,uuid,text,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_requirement_migration(uuid,text,integer,integer,timestamptz,bigint,uuid,uuid,text,uuid,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.resume_reconciled_requirement_migration(p_requirement_id uuid, p_receipt_id uuid, p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  saved public.requirement_migration_reconciliations%ROWTYPE;
  resumed public.requirement_migration_reconciliation_resumes%ROWTYPE;
  r public.requirements%ROWTYPE;
  life public.requirement_migration_lifecycle%ROWTYPE;
  v_observed timestamptz;
  v_now timestamptz;
BEGIN
  IF p_requirement_id IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Invalid reconciliation resume input' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.requirements WHERE id = p_requirement_id FOR UPDATE;
  SELECT * INTO saved FROM public.requirement_migration_reconciliations
    WHERE id = p_receipt_id AND requirement_id = p_requirement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation receipt missing' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO resumed FROM public.requirement_migration_reconciliation_resumes WHERE receipt_id = saved.id;
  IF FOUND THEN
    RETURN jsonb_build_object('receipt_id',saved.id,'resumed',true,'execution_generation',resumed.execution_generation);
  END IF;
  r := public.lock_migration_reconciliation_scope(saved.requirement_id,saved.file,saved.instance_id,
    saved.plan_id,saved.step_id,saved.execution_generation,saved.backlog_revision);
  SELECT * INTO life FROM public.requirement_migration_lifecycle WHERE requirement_id = r.id AND file = saved.file;
  IF NOT FOUND OR to_jsonb(life) IS DISTINCT FROM saved.lifecycle
    OR life.state <> 'correction_required' OR life.attempts <> 5 OR life.review IS NOT NULL
    OR r.site_id IS DISTINCT FROM saved.site_id OR r.instructions IS DISTINCT FROM saved.specification
    OR encode(sha256(convert_to(r.instructions, 'UTF8')), 'hex') IS DISTINCT FROM saved.specification_checksum THEN
    RAISE EXCEPTION 'Reconciliation scope changed before resume' USING ERRCODE = '40001';
  END IF;
  -- All identity/hash/absence fields must exactly match the validated original
  -- attestation. Only the fresh observation timestamp may differ. DB still
  -- trusts service_role for remote facts; no Apps call is made from this RPC.
  IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
    OR octet_length(p_evidence::text) > 4096
    OR (p_evidence - 'observed_at') IS DISTINCT FROM (saved.evidence - 'observed_at')
    OR jsonb_typeof(p_evidence->'observed_at') IS DISTINCT FROM 'string'
    OR p_evidence->>'observed_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
    RAISE EXCEPTION 'Resume evidence scope mismatch' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_observed := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid resume observation time' USING ERRCODE = '22023';
  END;
  v_now := clock_timestamp();
  IF NOT isfinite(v_observed) OR v_observed < v_now - interval '5 minutes' OR v_observed > v_now + interval '30 seconds' THEN
    RAISE EXCEPTION 'Stale resume evidence' USING ERRCODE = '40001';
  END IF;
  IF r.metadata ? 'execution_hold' OR NULLIF(r.metadata->>'cron_blocker_provenance', '') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.requirement_migration_lifecycle
      WHERE requirement_id = r.id AND file <> saved.file AND state <> 'validated')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(r.backlog->'items') AS item
      -- Ordinary downstream dependency waits are not a requirement-wide hold.
      -- Keep those unchanged; direct/user/platform blockers and quarantine deny.
      WHERE jsonb_typeof(COALESCE(item->'blocked_by','[]'::jsonb)) <> 'array'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item->'blocked_by') = 'array'
          THEN item->'blocked_by' ELSE '[]'::jsonb END) AS blocker
          WHERE blocker->>'category' IS DISTINCT FROM 'dependency'
            OR COALESCE(blocker->>'resolution_actor','') NOT IN ('executor','verifier')
            OR COALESCE(blocker->'user_action_required','false'::jsonb) <> 'false'::jsonb)
        OR COALESCE(item#>'{review_quarantine,active}','false'::jsonb) <> 'false'::jsonb
        OR COALESCE(item->'plan_cancellation_pending','null'::jsonb) <> 'null'::jsonb
        OR item->>'status' IN ('blocked','needs_review')) THEN
    RAISE EXCEPTION 'Requirement has another unresolved hold' USING ERRCODE = '23514';
  END IF;
  -- Insert before status UPDATE for the durable pending-reconciliation guard;
  -- any update/visibility/audit failure rolls this receipt back as well.
  INSERT INTO public.requirement_migration_reconciliation_resumes(receipt_id,requirement_id,execution_generation,evidence)
    VALUES (saved.id,r.id,saved.execution_generation + 1,p_evidence) RETURNING * INTO resumed;
  UPDATE public.requirements SET status = 'in-progress',
    metadata = jsonb_set(metadata, '{requirement_execution_generation}', to_jsonb(saved.execution_generation + 1)),
    updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond') WHERE id = r.id;
  INSERT INTO public.instance_logs(instance_id,site_id,log_type,level,message,details)
    VALUES (saved.instance_id,r.site_id,'system','info','Reconciled migration execution resumed without resetting budgets.',
      jsonb_build_object('event','migration_operator_reconciliation_resume','receipt_id',saved.id,
        'requirement_id',r.id,'execution_generation',resumed.execution_generation,
        'receipt_found',false,'observed_at',v_observed));
  INSERT INTO public.requirement_status(requirement_id,site_id,instance_id,stage,message)
    VALUES (r.id,r.site_id,saved.instance_id,'in-progress',
      'Execution resumed after audited migration reconciliation. Fresh independent diagnosis, security review and validation remain required.');
  RETURN jsonb_build_object('receipt_id',saved.id,'resumed',true,'execution_generation',resumed.execution_generation);
END;
$$;
REVOKE ALL ON FUNCTION public.resume_reconciled_requirement_migration(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_reconciled_requirement_migration(uuid,uuid,jsonb) TO service_role;

COMMIT;
