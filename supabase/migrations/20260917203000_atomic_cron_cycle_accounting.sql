-- Rollback:
-- DROP FUNCTION IF EXISTS public.record_requirement_cron_cycle_outcome(uuid, text, timestamptz, text, integer, uuid);
-- Then drop increment_requirement_metadata_counter, patch_requirement_metadata_keys, and public.requirement_cron_cycle_outcomes.

CREATE TABLE IF NOT EXISTS public.requirement_cron_cycle_outcomes (
  requirement_id uuid NOT NULL
    REFERENCES public.requirements(id) ON DELETE CASCADE,
  cycle_id text NOT NULL,
  cycle_started_at timestamptz NOT NULL,
  execution_generation integer NOT NULL DEFAULT 0
    CONSTRAINT requirement_cron_cycle_outcomes_execution_generation_check
    CHECK (execution_generation >= 0),
  outcome text NOT NULL CHECK (
    outcome IN (
      'progress',
      'product_no_progress',
      'product_failure',
      'infrastructure_wait',
      'infrastructure_retry',
      'infrastructure_exhausted',
      'scheduler_cooldown',
      'remediation_handoff',
      'paused',
      'idle'
    )
  ),
  runner_instance_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (requirement_id, cycle_id),
  CHECK (char_length(cycle_id) BETWEEN 1 AND 200)
);
ALTER TABLE public.requirement_cron_cycle_outcomes
  ADD COLUMN IF NOT EXISTS execution_generation integer;
UPDATE public.requirement_cron_cycle_outcomes
SET execution_generation = 0
WHERE execution_generation IS NULL;
ALTER TABLE public.requirement_cron_cycle_outcomes
  ALTER COLUMN execution_generation SET DEFAULT 0;
ALTER TABLE public.requirement_cron_cycle_outcomes
  ALTER COLUMN execution_generation SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid =
      'public.requirement_cron_cycle_outcomes'::regclass
      AND conname =
        'requirement_cron_cycle_outcomes_execution_generation_check'
  ) THEN
    ALTER TABLE public.requirement_cron_cycle_outcomes
      ADD CONSTRAINT
        requirement_cron_cycle_outcomes_execution_generation_check
      CHECK (execution_generation >= 0);
  END IF;
END;
$$;
DROP INDEX IF EXISTS public.requirement_cron_cycle_outcomes_order_idx;
CREATE INDEX requirement_cron_cycle_outcomes_order_idx
  ON public.requirement_cron_cycle_outcomes (
    requirement_id,
    execution_generation,
    cycle_started_at DESC,
    cycle_id DESC
  );

ALTER TABLE public.requirement_cron_cycle_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS requirement_cron_cycle_outcomes_service_role
  ON public.requirement_cron_cycle_outcomes;
CREATE POLICY requirement_cron_cycle_outcomes_service_role
  ON public.requirement_cron_cycle_outcomes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.requirement_cron_cycle_outcomes
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.requirement_cron_cycle_outcomes
  TO service_role;

CREATE OR REPLACE FUNCTION public.patch_requirement_metadata_keys(
  p_requirement_id uuid,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_remove_keys text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metadata jsonb;
BEGIN
  UPDATE public.requirements
  SET
    metadata =
      (
        CASE
          WHEN jsonb_typeof(metadata) = 'object' THEN metadata
          ELSE '{}'::jsonb
        END
        - COALESCE(p_remove_keys, '{}'::text[])
      )
      || CASE
        WHEN jsonb_typeof(p_patch) = 'object' THEN p_patch
        ELSE '{}'::jsonb
      END,
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id
  RETURNING metadata INTO v_metadata;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Requirement % not found', p_requirement_id;
  END IF;

  RETURN v_metadata;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_requirement_metadata_counter(
  p_requirement_id uuid,
  p_key text,
  p_increment integer DEFAULT 1,
  p_initial_value integer DEFAULT 0
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metadata jsonb;
  v_current integer;
  v_next integer;
BEGIN
  IF NULLIF(btrim(p_key), '') IS NULL OR p_key !~ '^[a-zA-Z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid metadata counter key: %', p_key;
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(metadata) = 'object' THEN metadata
    ELSE '{}'::jsonb
  END
  INTO v_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Requirement % not found', p_requirement_id;
  END IF;

  v_current := CASE
    WHEN COALESCE(v_metadata->>p_key, '') ~ '^-?[0-9]{1,9}$'
      THEN (v_metadata->>p_key)::integer
    ELSE p_initial_value
  END;
  v_next := v_current + p_increment;

  UPDATE public.requirements
  SET
    metadata = jsonb_set(v_metadata, ARRAY[p_key], to_jsonb(v_next), true),
    updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  RETURN v_next;
END;
$$;

-- Remove unguarded overloads before installing the generation-aware RPC.
DROP FUNCTION IF EXISTS public.record_requirement_cron_cycle_outcome(uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public.record_requirement_cron_cycle_outcome(uuid, text, timestamptz, text, uuid);
CREATE OR REPLACE FUNCTION public.record_requirement_cron_cycle_outcome(
  p_requirement_id uuid,
  p_cycle_id text,
  p_cycle_started_at timestamptz,
  p_outcome text,
  p_expected_execution_generation integer,
  p_runner_instance_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metadata jsonb;
  v_inserted boolean := false;
  v_existing_outcome text;
  v_latest_cycle_id text;
  v_latest_outcome text;
  v_latest_started_at timestamptz;
  v_latest_runner_instance_id uuid;
  v_last_progress_at timestamptz;
  v_last_progress_cycle_id text;
  v_last_product_at timestamptz;
  v_last_product_cycle_id text;
  v_cron_attempts integer := 0;
  v_no_progress_cycles integer := 0;
  v_infrastructure_failure_cycles integer := 0;
  v_allowed_outcomes constant text[] := ARRAY[
    'progress',
    'product_no_progress',
    'product_failure',
    'infrastructure_wait',
    'infrastructure_retry',
    'infrastructure_exhausted',
    'scheduler_cooldown',
    'remediation_handoff',
    'paused',
    'idle'
  ];
BEGIN
  IF NULLIF(btrim(p_cycle_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_cycle_id is required';
  END IF;
  IF char_length(p_cycle_id) > 200 THEN
    RAISE EXCEPTION 'p_cycle_id exceeds 200 characters';
  END IF;
  IF p_cycle_started_at IS NULL THEN
    RAISE EXCEPTION 'p_cycle_started_at is required';
  END IF;
  IF p_cycle_started_at > timezone('utc', now()) + interval '5 minutes' THEN
    RAISE EXCEPTION 'p_cycle_started_at cannot be in the future';
  END IF;
  IF NOT (p_outcome = ANY(v_allowed_outcomes)) THEN
    RAISE EXCEPTION 'Unsupported cron cycle outcome: %', p_outcome;
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(metadata) = 'object' THEN metadata
    ELSE '{}'::jsonb
  END
  INTO v_metadata
  FROM public.requirements
  WHERE id = p_requirement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Requirement % not found', p_requirement_id;
  END IF;
  IF (
    CASE
      WHEN COALESCE(
        v_metadata->>'requirement_execution_generation',
        ''
      ) ~ '^[0-9]{1,9}$'
        THEN (v_metadata->>'requirement_execution_generation')::integer
      ELSE 0
    END
  ) IS DISTINCT FROM p_expected_execution_generation THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'is_latest', false,
      'recorded_outcome', p_outcome,
      'metadata', v_metadata,
      'cron_attempts', 0,
      'no_progress_cycles', 0,
      'infrastructure_failure_cycles', 0
    );
  END IF;

  INSERT INTO public.requirement_cron_cycle_outcomes (
    requirement_id,
    cycle_id,
    cycle_started_at,
    execution_generation,
    outcome,
    runner_instance_id
  )
  VALUES (
    p_requirement_id,
    p_cycle_id,
    p_cycle_started_at,
    p_expected_execution_generation,
    p_outcome,
    p_runner_instance_id
  )
  ON CONFLICT (requirement_id, cycle_id) DO NOTHING
  RETURNING true INTO v_inserted;

  IF v_inserted IS DISTINCT FROM true THEN
    SELECT outcome
    INTO v_existing_outcome
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND cycle_id = p_cycle_id;

    SELECT cycle_id
    INTO v_latest_cycle_id
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
    ORDER BY cycle_started_at DESC, cycle_id DESC
    LIMIT 1;

    RETURN jsonb_build_object(
      'accepted', false,
      'is_latest', p_cycle_id = v_latest_cycle_id,
      'recorded_outcome', v_existing_outcome,
      'metadata', v_metadata,
      'cron_attempts', COALESCE(
        CASE
          WHEN COALESCE(v_metadata->>'cron_attempts', '') ~ '^[0-9]{1,9}$'
            THEN (v_metadata->>'cron_attempts')::integer
        END,
        0
      ),
      'no_progress_cycles', COALESCE(
        CASE
          WHEN COALESCE(v_metadata->>'no_progress_cycles', '') ~ '^[0-9]{1,9}$'
            THEN (v_metadata->>'no_progress_cycles')::integer
        END,
        0
      ),
      'infrastructure_failure_cycles', COALESCE(
        CASE
          WHEN COALESCE(
            v_metadata->>'cron_infrastructure_failure_cycles',
            ''
          ) ~ '^[0-9]{1,9}$'
            THEN (
              v_metadata->>'cron_infrastructure_failure_cycles'
            )::integer
        END,
        0
      )
    );
  END IF;

  SELECT
    cycle_id,
    outcome,
    cycle_started_at,
    runner_instance_id
  INTO
    v_latest_cycle_id,
    v_latest_outcome,
    v_latest_started_at,
    v_latest_runner_instance_id
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;

  SELECT cycle_started_at, cycle_id
  INTO v_last_progress_at, v_last_progress_cycle_id
  FROM public.requirement_cron_cycle_outcomes
  WHERE requirement_id = p_requirement_id
    AND execution_generation = p_expected_execution_generation
    AND outcome = 'progress'
  ORDER BY cycle_started_at DESC, cycle_id DESC
  LIMIT 1;

  IF p_outcome IN ('progress', 'product_no_progress', 'product_failure') THEN
    SELECT
      count(*) FILTER (
        WHERE outcome IN ('product_no_progress', 'product_failure')
      )::integer,
      count(*) FILTER (
        WHERE outcome = 'product_no_progress'
      )::integer
    INTO v_cron_attempts, v_no_progress_cycles
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND (
        v_last_progress_at IS NULL
        OR (cycle_started_at, cycle_id) >
          (v_last_progress_at, v_last_progress_cycle_id)
      );

    v_metadata := v_metadata || jsonb_build_object(
      'cron_attempts', COALESCE(v_cron_attempts, 0),
      'no_progress_cycles', COALESCE(v_no_progress_cycles, 0)
    );
  END IF;

  IF p_outcome IN (
    'progress',
    'product_no_progress',
    'product_failure',
    'infrastructure_retry'
  ) THEN
    SELECT cycle_started_at, cycle_id
    INTO v_last_product_at, v_last_product_cycle_id
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND outcome IN (
        'progress',
        'product_no_progress',
        'product_failure'
      )
    ORDER BY cycle_started_at DESC, cycle_id DESC
    LIMIT 1;

    SELECT count(*)::integer
    INTO v_infrastructure_failure_cycles
    FROM public.requirement_cron_cycle_outcomes
    WHERE requirement_id = p_requirement_id
      AND execution_generation = p_expected_execution_generation
      AND outcome = 'infrastructure_retry'
      AND (
        v_last_product_at IS NULL
        OR (cycle_started_at, cycle_id) >
          (v_last_product_at, v_last_product_cycle_id)
      );

    v_metadata := v_metadata || jsonb_build_object(
      'cron_infrastructure_failure_cycles',
      COALESCE(v_infrastructure_failure_cycles, 0)
    );
  END IF;

  v_metadata := v_metadata || jsonb_build_object(
    'cron_last_cycle_id', v_latest_cycle_id,
    'cron_last_cycle_outcome', v_latest_outcome,
    'cron_last_cycle_at', v_latest_started_at
  );
  IF v_last_progress_cycle_id IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object(
      'cron_last_progress_cycle_id', v_last_progress_cycle_id
    );
  END IF;
  IF v_latest_runner_instance_id IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object(
      'runner_instance_id', v_latest_runner_instance_id
    );
  END IF;

  UPDATE public.requirements
  SET metadata = v_metadata, updated_at = timezone('utc', now())
  WHERE id = p_requirement_id;

  RETURN jsonb_build_object(
    'accepted', true,
    'is_latest', p_cycle_id = v_latest_cycle_id,
    'recorded_outcome', p_outcome,
    'metadata', v_metadata,
    'cron_attempts', COALESCE(
      CASE
        WHEN COALESCE(v_metadata->>'cron_attempts', '') ~ '^[0-9]{1,9}$'
          THEN (v_metadata->>'cron_attempts')::integer
      END,
      0
    ),
    'no_progress_cycles', COALESCE(
      CASE
        WHEN COALESCE(v_metadata->>'no_progress_cycles', '') ~ '^[0-9]{1,9}$'
          THEN (v_metadata->>'no_progress_cycles')::integer
      END,
      0
    ),
    'infrastructure_failure_cycles', COALESCE(
      CASE
        WHEN COALESCE(
          v_metadata->>'cron_infrastructure_failure_cycles',
          ''
        ) ~ '^[0-9]{1,9}$'
          THEN (
            v_metadata->>'cron_infrastructure_failure_cycles'
          )::integer
      END,
      0
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.patch_requirement_metadata_keys(uuid, jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_requirement_metadata_counter(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_requirement_cron_cycle_outcome(uuid, text, timestamptz, text, integer, uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'record_requirement_cron_cycle_outcome'
      AND p.prosecdef
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      v_function
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.patch_requirement_metadata_keys(uuid, jsonb, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_requirement_metadata_counter(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_requirement_cron_cycle_outcome(uuid, text, timestamptz, text, integer, uuid) TO service_role;
