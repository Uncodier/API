-- Makinari requirement DB, not Apps/tenant DB. Deploy SQL before host callers.
-- Only new support receipts require a host circuit-break proof. Exact historical
-- replay, authoring guards, grants, budgets, statuses and delivery CAS are retained.
BEGIN;

DO $migration$
DECLARE
  v_function regprocedure := to_regprocedure(
    'public.record_harness_diagnostic_decision(uuid,uuid,uuid,bigint,timestamptz,uuid,text,text,text,jsonb)'
  );
  v_definition text;
  v_source text;
  v_normalized text;
  v_old text[] := ARRAY[
    $old$ELSE ARRAY['evidence_log_ids', 'verification', 'impact', 'requested_action', 'attempted_alternatives'] END;$old$,
    $old$IF v_key IN ('evidence_log_ids', 'acceptance_mapping', 'attempted_alternatives') THEN CONTINUE; END IF;$old$,
    $old$  ELSIF p_decision = 'escalate_support' THEN
    IF jsonb_typeof(p_payload->'attempted_alternatives') IS DISTINCT FROM 'array' THEN$old$
  ];
  v_new text[] := ARRAY[
    $new$ELSE ARRAY['evidence_log_ids', 'verification', 'impact', 'requested_action', 'attempted_alternatives', 'circuit_breaker'] END;$new$,
    $new$IF v_key IN ('evidence_log_ids', 'acceptance_mapping', 'attempted_alternatives', 'circuit_breaker') THEN CONTINUE; END IF;$new$,
    $new$  ELSIF p_decision = 'escalate_support' THEN
    -- Host-only structural proof; policy eligibility is evaluated by trusted TS,
    -- never inferred from reason, requested_action or attempted_alternatives.
    DECLARE
      cb jsonb := p_payload->'circuit_breaker';
      entry jsonb;
      field text;
      snapshot_key text;
      expected_keys text[];
      generation_text text;
      stamp timestamptz;
      expected_snapshot jsonb;
      actual_snapshot jsonb;
      snapshot_limit integer;
    BEGIN
      IF v_requirement.status IS DISTINCT FROM 'blocked' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'harness_support_requires_blocked';
      END IF;
      expected_keys := ARRAY['version', 'execution_generation', 'backlog_revision',
        'requirement_updated_at', 'no_runnable_work', 'no_pending_recovery',
        'exhaustion', 'blocked_item_ids', 'plan_versions', 'migration_versions', 'diagnostic_versions'];
      IF jsonb_typeof(cb) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker';
      END IF;
      IF NOT (cb ?& expected_keys) OR cb - expected_keys <> '{}'::jsonb
        OR cb->'version' IS DISTINCT FROM '1'::jsonb
        OR cb->'no_runnable_work' IS DISTINCT FROM 'true'::jsonb
        OR cb->'no_pending_recovery' IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker';
      END IF;
      FOREACH field IN ARRAY ARRAY['execution_generation', 'backlog_revision'] LOOP
        IF jsonb_typeof(cb->field) IS DISTINCT FROM 'number'
          OR (cb->>field) !~ '^(0|[1-9][0-9]{0,18})$' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_counter';
        END IF;
        IF (cb->>field)::numeric > (CASE WHEN field = 'execution_generation'
          THEN 2147483647::numeric ELSE 9223372036854775807::numeric END) THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_counter';
        END IF;
      END LOOP;
      -- Same strict metadata decoder as migration lifecycle/diagnostic RPCs.
      generation_text := CASE WHEN v_requirement.metadata ? 'requirement_execution_generation'
        THEN v_requirement.metadata->>'requirement_execution_generation' ELSE '0' END;
      IF generation_text IS NULL OR generation_text !~ '^(0|[1-9][0-9]{0,9})$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_execution_generation';
      END IF;
      IF generation_text::bigint > 2147483647 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_execution_generation';
      END IF;
      IF jsonb_typeof(cb->'requirement_updated_at') IS DISTINCT FROM 'string'
        OR char_length(cb->>'requirement_updated_at') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_timestamp';
      END IF;
      BEGIN
        stamp := (cb->>'requirement_updated_at')::timestamptz;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_timestamp';
      END;
      IF NOT isfinite(stamp) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_timestamp';
      END IF;
      IF (cb->>'execution_generation')::bigint <> generation_text::bigint
        OR (cb->>'backlog_revision')::bigint <> v_revision
        OR stamp IS DISTINCT FROM p_expected_updated_at THEN
        RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'harness_support_stale_proof';
      END IF;
      FOREACH field IN ARRAY ARRAY['exhaustion', 'blocked_item_ids', 'plan_versions', 'migration_versions', 'diagnostic_versions'] LOOP
        IF jsonb_typeof(cb->field) IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_array';
        END IF;
        IF jsonb_array_length(cb->field) > (CASE WHEN field = 'plan_versions' THEN 50
          WHEN field = 'blocked_item_ids' THEN 200 ELSE 100 END)
          OR (field = 'exhaustion' AND jsonb_array_length(cb->field) = 0) THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_array';
        END IF;
      END LOOP;
      FOR entry IN SELECT value FROM jsonb_array_elements(cb->'blocked_item_ids') LOOP
        IF jsonb_typeof(entry) IS DISTINCT FROM 'string' OR (entry #>> '{}') !~ '[^[:space:]]'
          OR char_length(entry #>> '{}') > 512 THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_item';
        END IF;
      END LOOP;
      FOR entry IN SELECT value FROM jsonb_array_elements(cb->'exhaustion') LOOP
        expected_keys := ARRAY['kind', 'target_id', 'used', 'limit', 'receipt_ids'];
        IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_exhaustion';
        END IF;
        IF NOT (entry ?& expected_keys) OR entry - expected_keys <> '{}'::jsonb
          OR jsonb_typeof(entry->'kind') IS DISTINCT FROM 'string'
          OR entry->>'kind' NOT IN ('repair_attempts', 'product_attempts', 'verification_attempts',
            'infrastructure_attempts', 'no_progress_cycles', 'migration_recovery')
          OR jsonb_typeof(entry->'target_id') IS DISTINCT FROM 'string'
          OR (entry->>'target_id') !~ '[^[:space:]]' OR char_length(entry->>'target_id') > 512
          OR jsonb_typeof(entry->'receipt_ids') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_exhaustion';
        END IF;
        FOREACH field IN ARRAY ARRAY['used', 'limit'] LOOP
          IF jsonb_typeof(entry->field) IS DISTINCT FROM 'number'
            OR (entry->>field) !~ '^(0|[1-9][0-9]{0,9})$' THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_exhaustion';
          END IF;
          IF (entry->>field)::bigint > 2147483647 THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_exhaustion';
          END IF;
        END LOOP;
        IF (entry->>'limit')::bigint < 1 OR (entry->>'used')::bigint < (entry->>'limit')::bigint
          OR jsonb_array_length(entry->'receipt_ids') > 100 OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(entry->'receipt_ids') AS receipt(value)
            WHERE jsonb_typeof(value) IS DISTINCT FROM 'string' OR (value #>> '{}') !~ '[^[:space:]]'
              OR char_length(value #>> '{}') > 512
          ) THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_exhaustion';
        END IF;
      END LOOP;

      -- Plan linkage lives in JSON metadata, not a requirement FK. Row locks
      -- alone cannot fence newly inserted/relinked plans. NOWAIT fails closed on
      -- competing plan writers instead of waiting while holding the requirement.
      LOCK TABLE public.instance_plans IN SHARE MODE NOWAIT;
      -- Active legacy item-linked plans cannot be represented by the explicit
      -- requirement snapshot. Refuse ambiguous recovery, never infer exhaustion.
      IF EXISTS (
        SELECT 1 FROM public.instance_plans AS legacy
        WHERE legacy.site_id = p_site_id AND legacy.status IN ('pending', 'in_progress', 'active', 'paused')
          AND NULLIF(legacy.metadata->>'requirement_id', '') IS NULL
          AND COALESCE(legacy.metadata->>'workflow_template', 'false') <> 'true'
          AND (legacy.instance_id::text IN (p_instance_id::text, v_requirement.metadata->>'runner_instance_id',
            v_requirement.metadata->>'assistant_origin_instance_id') OR EXISTS (
              SELECT 1 FROM public.instance_plans AS linked WHERE linked.site_id = p_site_id
                AND linked.metadata->>'requirement_id' = p_requirement_id::text AND linked.instance_id = legacy.instance_id
            ))
          AND (jsonb_typeof(legacy.steps) IS DISTINCT FROM 'array' OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(legacy.steps) = 'array'
              THEN legacy.steps ELSE '[]'::jsonb END) AS step(value)
            JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(v_requirement.backlog->'items') = 'array'
              THEN v_requirement.backlog->'items' ELSE '[]'::jsonb END) AS item(value)
              ON item.value->>'id' IN (step.value->>'backlog_item_id', step.value#>>'{metadata,backlog_item_id}')
          ))
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'harness_support_legacy_plan_ambiguous';
      END IF;
      -- Requirement -> all lifecycle rows -> all diagnostic rows is the existing
      -- writer lock order; the requirement lock also serializes absent-row claims.
      FOREACH snapshot_key IN ARRAY ARRAY['plan_versions', 'migration_versions', 'diagnostic_versions'] LOOP
        snapshot_limit := CASE WHEN snapshot_key = 'plan_versions' THEN 50 ELSE 100 END;
        expected_keys := CASE snapshot_key
          WHEN 'plan_versions' THEN ARRAY['id', 'updated_at']
          WHEN 'migration_versions' THEN ARRAY['file', 'version', 'state', 'updated_at']
          ELSE ARRAY['file', 'token', 'state', 'updated_at'] END;
        FOR entry IN SELECT value FROM jsonb_array_elements(cb->snapshot_key) LOOP
          IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_snapshot';
          END IF;
          IF NOT (entry ?& expected_keys) OR entry - expected_keys <> '{}'::jsonb THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_snapshot';
          END IF;
          FOREACH field IN ARRAY expected_keys LOOP
            IF field = 'version' THEN
              IF jsonb_typeof(entry->field) IS DISTINCT FROM 'number'
                OR (entry->>field) !~ '^[1-9][0-9]{0,9}$' THEN
                RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_snapshot';
              END IF;
              IF (entry->>field)::bigint > 2147483647 THEN
                RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_snapshot';
              END IF;
            ELSIF jsonb_typeof(entry->field) IS DISTINCT FROM 'string'
              OR (entry->>field) !~ '[^[:space:]]'
              OR char_length(entry->>field) > (CASE WHEN field = 'file' THEN 512 ELSE 100 END) THEN
              RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_snapshot';
            END IF;
            IF field IN ('id', 'token') AND (entry->>field) !~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
              RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_snapshot';
            END IF;
          END LOOP;
          BEGIN
            stamp := (entry->>'updated_at')::timestamptz;
          EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_timestamp';
          END;
          IF NOT isfinite(stamp) THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_harness_circuit_breaker_timestamp';
          END IF;
        END LOOP;
        -- Normalize timestamps/UUIDs, not JSON spelling or array order. Exact
        -- array equality then also rejects duplicate, missing and invented rows.
        IF snapshot_key = 'plan_versions' THEN
          SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) INTO expected_snapshot
            FROM jsonb_to_recordset(cb->snapshot_key) AS s(id uuid, updated_at timestamptz);
          SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) INTO actual_snapshot FROM (
            SELECT plan.id, plan.updated_at FROM public.instance_plans AS plan
            WHERE plan.site_id = p_site_id AND plan.metadata->>'requirement_id' = p_requirement_id::text
            -- Include workflow_template and every status/instance; no omission.
            ORDER BY plan.id LIMIT 51 FOR UPDATE
          ) AS s;
        ELSIF snapshot_key = 'migration_versions' THEN
          SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.file), '[]'::jsonb) INTO expected_snapshot
            FROM jsonb_to_recordset(cb->snapshot_key) AS s(file text, version integer, state text, updated_at timestamptz);
          SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.file), '[]'::jsonb) INTO actual_snapshot FROM (
            SELECT m.file, m.version, m.state, m.updated_at FROM public.requirement_migration_lifecycle AS m
            WHERE m.requirement_id = p_requirement_id ORDER BY m.file LIMIT 101 FOR UPDATE
          ) AS s;
        ELSE
          SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.file), '[]'::jsonb) INTO expected_snapshot
            FROM jsonb_to_recordset(cb->snapshot_key) AS s(file text, token uuid, state text, updated_at timestamptz);
          SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.file), '[]'::jsonb) INTO actual_snapshot FROM (
            SELECT d.file, d.token, d.state, d.updated_at FROM public.requirement_migration_diagnostics AS d
            WHERE d.requirement_id = p_requirement_id ORDER BY d.file LIMIT 101 FOR UPDATE
          ) AS s;
        END IF;
        IF jsonb_array_length(actual_snapshot) > snapshot_limit OR actual_snapshot IS DISTINCT FROM expected_snapshot THEN
          RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'harness_support_stale_snapshot';
        END IF;
      END LOOP;
    END;
    IF jsonb_typeof(p_payload->'attempted_alternatives') IS DISTINCT FROM 'array' THEN$new$
  ];
  i integer;
  n integer;
  v_patched integer := 0;
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'Apply harness diagnostic decisions migration 20261001220000 first' USING ERRCODE = '42883';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc WHERE oid = v_function;
  v_definition := pg_get_functiondef(v_function);
  v_normalized := v_source;
  FOR i IN 1..array_length(v_old, 1) LOOP
    n := (length(v_normalized) - length(replace(v_normalized, v_new[i], ''))) / length(v_new[i]);
    IF n = 1 THEN
      v_normalized := replace(v_normalized, v_new[i], v_old[i]);
      v_patched := v_patched + 1;
    ELSIF n <> 0 THEN
      RAISE EXCEPTION 'Unexpected harness diagnostic decision definition; inspect circuit-break patch anchors';
    END IF;
    IF (length(v_normalized) - length(replace(v_normalized, v_old[i], ''))) / length(v_old[i]) <> 1 THEN
      RAISE EXCEPTION 'Unexpected harness diagnostic decision definition; inspect circuit-break patch anchors';
    END IF;
  END LOOP;
  -- Exact prosrc after 20261003020000 (including its PT409 guard). This is a
  -- drift checksum, not a credential. Reverse-normalization permits exact replay
  -- of this migration, but rejects partial patches and unrelated body drift.
  IF v_patched NOT IN (0, 3) OR md5(v_normalized) <> '0fd243803117fd0a4b77d864d2563c39' THEN
    RAISE EXCEPTION 'Unexpected harness diagnostic decision definition; apply 20261003020000 and inspect source drift';
  END IF;
  IF v_patched = 3 THEN RETURN; END IF;
  FOR i IN 1..array_length(v_old, 1) LOOP
    v_definition := replace(v_definition, v_old[i], v_new[i]);
  END LOOP;
  -- Retains function identity, ownership, SECURITY DEFINER, search_path and ACLs.
  EXECUTE v_definition;
END;
$migration$;

COMMIT;