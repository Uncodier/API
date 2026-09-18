-- Rollback:
-- DROP FUNCTION IF EXISTS public.update_instance_plan_step_status_atomic(uuid, text, text, text, integer);
-- DROP FUNCTION IF EXISTS public.clear_instance_plan_step_infrastructure_state(uuid, text, text, integer);
-- DROP FUNCTION IF EXISTS public.record_instance_plan_step_infrastructure_failure(uuid, text, text, text, jsonb, integer, integer, boolean);
-- DROP TABLE IF EXISTS public.instance_plan_step_infrastructure_events;
CREATE TABLE IF NOT EXISTS public.instance_plan_step_infrastructure_events (
  plan_id uuid NOT NULL
    REFERENCES public.instance_plans(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (plan_id, step_id, event_id),
  CHECK (char_length(step_id) BETWEEN 1 AND 200),
  CHECK (char_length(event_id) BETWEEN 1 AND 300)
);
ALTER TABLE public.instance_plan_step_infrastructure_events
  DROP CONSTRAINT IF EXISTS
    instance_plan_step_infrastructure_events_event_type_check;
ALTER TABLE public.instance_plan_step_infrastructure_events
  ADD CONSTRAINT instance_plan_step_infrastructure_events_event_type_check
  CHECK (
    event_type IN (
      'failure',
      'success_clear',
      'deployment_recovery',
      'step_patch'
    )
  );
ALTER TABLE public.instance_plan_step_infrastructure_events
  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instance_plan_step_infrastructure_events_service_role
  ON public.instance_plan_step_infrastructure_events;
CREATE POLICY instance_plan_step_infrastructure_events_service_role
  ON public.instance_plan_step_infrastructure_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
REVOKE ALL ON TABLE public.instance_plan_step_infrastructure_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.instance_plan_step_infrastructure_events
  TO service_role;
CREATE OR REPLACE FUNCTION public.record_instance_plan_step_infrastructure_failure(
  p_plan_id uuid, p_step_id text, p_event_id text,
  p_error_message text, p_wait jsonb DEFAULT '{}'::jsonb,
  p_max_retries integer DEFAULT 4, p_expected_generation integer DEFAULT 0,
  p_allow_retryable_failed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_steps jsonb; v_step jsonb; v_step_index integer;
  v_status text; v_generation integer;
  v_current_count integer; v_next_count integer;
  v_circuit_open boolean; v_retry_at timestamptz;
BEGIN
  IF NULLIF(btrim(p_step_id), '') IS NULL
    OR NULLIF(btrim(p_event_id), '') IS NULL
  THEN
    RAISE EXCEPTION 'Step id and event id are required';
  END IF;
  IF p_max_retries < 1 OR p_max_retries > 100 THEN
    RAISE EXCEPTION 'p_max_retries must be between 1 and 100';
  END IF;
  SELECT CASE
    WHEN jsonb_typeof(steps) = 'array' THEN steps
    ELSE '[]'::jsonb
  END
  INTO v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'missing', 'infra_count', 0, 'circuit_open', false
    );
  END IF;
  SELECT entry.value, (entry.ordinality - 1)::integer
  INTO v_step, v_step_index
  FROM jsonb_array_elements(v_steps)
    WITH ORDINALITY AS entry(value, ordinality)
  WHERE entry.value->>'id' = p_step_id
  LIMIT 1;
  IF v_step IS NULL THEN
    RETURN jsonb_build_object(
      'state', 'missing', 'infra_count', 0, 'circuit_open', false
    );
  END IF;
  v_generation := CASE
    WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  IF EXISTS (
    SELECT 1
    FROM public.instance_plan_step_infrastructure_events
    WHERE plan_id = p_plan_id
      AND step_id = p_step_id
      AND event_id = p_event_id
  ) THEN
    IF v_generation::bigint IS DISTINCT FROM
      p_expected_generation::bigint + 1
    THEN
      RETURN jsonb_build_object(
        'state', 'stale', 'infra_count', 0,
        'circuit_open', false, 'generation', v_generation
      );
    END IF;
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'infra_count', LEAST(
        CASE
          WHEN COALESCE(v_step->>'infra_retry_count', '') ~ '^[0-9]{1,9}$'
            THEN (v_step->>'infra_retry_count')::integer
          ELSE 0
        END,
        p_max_retries
      ),
      'circuit_open',
        COALESCE(v_step->>'infrastructure_circuit_open', '') = 'true',
      'retry_at', v_step->>'infra_retry_after',
      'generation', v_generation
    );
  END IF;
  IF v_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'infra_count',
        CASE WHEN COALESCE(v_step->>'infra_retry_count', '') ~ '^[0-9]{1,9}$'
          THEN (v_step->>'infra_retry_count')::integer ELSE 0 END,
      'circuit_open',
        COALESCE(v_step->>'infrastructure_circuit_open', '') = 'true',
      'generation', v_generation
    );
  END IF;
  v_status := v_step->>'status';
  IF v_status IN ('completed', 'cancelled')
    OR (v_status = 'failed' AND NOT p_allow_retryable_failed)
  THEN
    RETURN jsonb_build_object(
      'state', 'terminal',
      'infra_count',
        CASE WHEN COALESCE(v_step->>'infra_retry_count', '') ~ '^[0-9]{1,9}$'
          THEN (v_step->>'infra_retry_count')::integer ELSE 0 END,
      'circuit_open', false,
      'generation', v_generation
    );
  END IF;
  v_current_count := CASE
    WHEN COALESCE(v_step->>'infra_retry_count', '') ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infra_retry_count')::integer
    ELSE 0
  END;
  v_next_count := LEAST(v_current_count + 1, p_max_retries);
  v_circuit_open := v_next_count >= p_max_retries;
  v_retry_at := CASE
    WHEN v_circuit_open THEN NULL
    ELSE timezone('utc', now()) +
      LEAST(
        interval '1 minute' * power(2, GREATEST(0, v_next_count - 1)),
        interval '15 minutes'
      )
  END;
  v_step := v_step || jsonb_build_object(
    'infra_retry_count', v_next_count,
    'infra_retry_after', CASE
      WHEN v_retry_at IS NULL THEN NULL
      ELSE to_jsonb(v_retry_at)
    END,
    'infrastructure_error',
      COALESCE(NULLIF(p_error_message, ''), 'Infrastructure unavailable'),
    'infrastructure_waiting', true,
    'infrastructure_kind', COALESCE(p_wait->>'kind', 'gate'),
    'infrastructure_failure_provenance',
      COALESCE(p_wait->>'provenance', 'cron_infrastructure'),
    'infrastructure_correlation', COALESCE(p_wait->'correlation', 'null'::jsonb),
    'infrastructure_state', CASE
      WHEN v_circuit_open THEN 'intervention_required'
      ELSE 'backoff'
    END,
    'infrastructure_circuit_open', v_circuit_open,
    'infrastructure_intervention_required', v_circuit_open,
    'infrastructure_product_retry_count',
      CASE
        WHEN jsonb_typeof(
          v_step->'infrastructure_product_retry_count'
        ) = 'number'
        THEN v_step->'infrastructure_product_retry_count'
        ELSE to_jsonb(CASE
          WHEN COALESCE(v_step->>'retry_count', '') ~ '^[0-9]{1,9}$'
            THEN (v_step->>'retry_count')::integer
          ELSE 0
        END)
      END,
    'infrastructure_generation', v_generation + 1,
    'infrastructure_last_event_id', p_event_id
  );
  v_steps := jsonb_set(
    v_steps,
    ARRAY[v_step_index::text],
    v_step,
    false
  );

  UPDATE public.instance_plans
  SET steps = v_steps, updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  INSERT INTO public.instance_plan_step_infrastructure_events (
    plan_id,
    step_id,
    event_id,
    event_type,
    details
  )
  VALUES (
    p_plan_id,
    p_step_id,
    p_event_id,
    'failure',
    jsonb_build_object(
      'infra_count', v_next_count,
      'circuit_open', v_circuit_open,
      'generation', v_generation + 1,
      'wait', COALESCE(p_wait, '{}'::jsonb)
    )
  );

  RETURN jsonb_build_object(
    'state', 'applied',
    'infra_count', v_next_count,
    'circuit_open', v_circuit_open,
    'retry_at', v_retry_at,
    'generation', v_generation + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_instance_plan_step_infrastructure_state(
  p_plan_id uuid, p_step_id text,
  p_event_id text,
  p_expected_generation integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_steps jsonb; v_step jsonb; v_step_index integer;
  v_generation integer; v_event_generation integer;
BEGIN
  SELECT CASE
    WHEN jsonb_typeof(steps) = 'array' THEN steps
    ELSE '[]'::jsonb
  END
  INTO v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'cleared', false);
  END IF;

  SELECT entry.value, (entry.ordinality - 1)::integer
  INTO v_step, v_step_index
  FROM jsonb_array_elements(v_steps)
    WITH ORDINALITY AS entry(value, ordinality)
  WHERE entry.value->>'id' = p_step_id
  LIMIT 1;
  IF v_step IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'cleared', false);
  END IF;

  v_generation := CASE
    WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  SELECT CASE
    WHEN COALESCE(details->>'generation', '') ~ '^[0-9]{1,9}$'
      THEN (details->>'generation')::integer
    ELSE 0
  END
  INTO v_event_generation
  FROM public.instance_plan_step_infrastructure_events
    WHERE plan_id = p_plan_id
      AND step_id = p_step_id
      AND event_id = p_event_id;
  IF FOUND THEN
    IF v_event_generation IS DISTINCT FROM v_generation
      OR v_event_generation::bigint IS DISTINCT FROM
        p_expected_generation::bigint + 1
    THEN
      RETURN jsonb_build_object(
        'state', 'stale', 'cleared', false, 'generation', v_generation
      );
    END IF;
    RETURN jsonb_build_object(
      'state', 'duplicate', 'cleared', true,
      'generation', v_event_generation
    );
  END IF;

  IF v_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'cleared', false,
      'generation', v_generation
    );
  END IF;

  v_step := v_step || jsonb_build_object(
    'infra_retry_count', 0,
    'infra_retry_after', NULL,
    'infrastructure_error', NULL,
    'infrastructure_waiting', false,
    'infrastructure_kind', NULL,
    'infrastructure_failure_provenance', NULL,
    'infrastructure_correlation', NULL,
    'infrastructure_state', NULL,
    'infrastructure_circuit_open', false,
    'infrastructure_intervention_required', false,
    'infrastructure_product_retry_count', NULL,
    'infrastructure_generation', v_generation + 1,
    'infrastructure_last_event_id', p_event_id
  );
  v_steps := jsonb_set(
    v_steps,
    ARRAY[v_step_index::text],
    v_step,
    false
  );

  UPDATE public.instance_plans
  SET steps = v_steps, updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  INSERT INTO public.instance_plan_step_infrastructure_events (
    plan_id,
    step_id,
    event_id,
    event_type,
    details
  )
  VALUES (
    p_plan_id,
    p_step_id,
    p_event_id,
    'success_clear',
    jsonb_build_object('generation', v_generation + 1)
  );

  RETURN jsonb_build_object(
    'state', 'applied',
    'cleared', true,
    'generation', v_generation + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_instance_plan_step_status_atomic(
  p_plan_id uuid, p_step_id text,
  p_status text,
  p_error_message text DEFAULT NULL,
  p_expected_generation integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_steps jsonb; v_step jsonb; v_step_index integer;
  v_current_status text; v_generation integer;
BEGIN
  IF p_status NOT IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Unsupported plan step status: %', p_status;
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(steps) = 'array' THEN steps
    ELSE '[]'::jsonb
  END
  INTO v_steps
  FROM public.instance_plans
  WHERE id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'persisted', false);
  END IF;

  SELECT entry.value, (entry.ordinality - 1)::integer
  INTO v_step, v_step_index
  FROM jsonb_array_elements(v_steps)
    WITH ORDINALITY AS entry(value, ordinality)
  WHERE entry.value->>'id' = p_step_id
  LIMIT 1;
  IF v_step IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'persisted', false);
  END IF;

  v_generation := CASE
    WHEN COALESCE(v_step->>'infrastructure_generation', '') ~ '^[0-9]{1,9}$'
      THEN (v_step->>'infrastructure_generation')::integer
    ELSE 0
  END;
  v_current_status := v_step->>'status';
  IF v_current_status = p_status
    AND p_status IN ('completed', 'failed', 'cancelled')
    AND (
      v_generation IS NOT DISTINCT FROM p_expected_generation
      OR v_generation::bigint IS NOT DISTINCT FROM
        p_expected_generation::bigint + 1
    )
  THEN
    RETURN jsonb_build_object(
      'state', 'duplicate',
      'persisted', true,
      'generation', v_generation
    );
  END IF;
  IF v_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object(
      'state', 'stale',
      'persisted', false,
      'generation', v_generation
    );
  END IF;

  IF v_current_status IN ('completed', 'cancelled')
    AND v_current_status <> p_status
  THEN
    RETURN jsonb_build_object(
      'state', 'terminal',
      'persisted', false,
      'generation', v_generation
    );
  END IF;
  v_step := v_step || jsonb_build_object(
    'status', p_status,
    'infrastructure_generation', v_generation + 1
  );
  IF p_status = 'in_progress' THEN
    v_step := v_step || jsonb_build_object(
      'started_at',
      COALESCE(v_step->'started_at', to_jsonb(timezone('utc', now())))
    );
  ELSIF p_status IN ('completed', 'failed', 'cancelled') THEN
    v_step := v_step || jsonb_build_object(
      'completed_at', timezone('utc', now())
    );
    IF p_status = 'failed' THEN
      v_step := v_step || jsonb_build_object(
        'retry_count', CASE
          WHEN COALESCE(v_step->>'retry_count', '') ~ '^[0-9]{1,9}$'
            THEN (v_step->>'retry_count')::integer + 1
          ELSE 1
        END,
        'error_message', COALESCE(p_error_message, v_step->>'error_message')
      );
    ELSIF p_status = 'completed' THEN
      v_step := v_step || jsonb_build_object('error_message', NULL);
    END IF;
  END IF;

  v_steps := jsonb_set(
    v_steps,
    ARRAY[v_step_index::text],
    v_step,
    false
  );
  UPDATE public.instance_plans
  SET steps = v_steps, updated_at = timezone('utc', now())
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'state', 'applied',
    'persisted', true,
    'generation', v_generation + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_instance_plan_step_infrastructure_failure(uuid, text, text, text, jsonb, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_instance_plan_step_infrastructure_state(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_instance_plan_step_status_atomic(uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_instance_plan_step_infrastructure_failure(uuid, text, text, text, jsonb, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_instance_plan_step_infrastructure_state(uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_instance_plan_step_status_atomic(uuid, text, text, text, integer) TO service_role;
