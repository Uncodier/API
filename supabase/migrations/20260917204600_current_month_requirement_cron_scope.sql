-- Rollback: restore claim_requirement_cron_candidates from
-- 20260917204500_atomic_requirement_cron_capacity.sql.

CREATE OR REPLACE FUNCTION public.claim_requirement_cron_candidates(
  p_max_concurrent integer,
  p_ttl_seconds integer DEFAULT 7200,
  p_excluded_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_month_start timestamptz := (
    pg_catalog.date_trunc('month', v_now AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC'
  );
  v_active integer;
  v_slots integer;
  v_requirement public.requirements%ROWTYPE;
  v_run_id text;
  v_expires_at timestamptz;
  v_stale_cutoff timestamptz := v_now - interval '30 minutes';
BEGIN
  IF p_max_concurrent IS NULL
    OR p_max_concurrent < 1
    OR p_max_concurrent > 100
  THEN
    RAISE EXCEPTION 'Maximum concurrent requirement runs must be between 1 and 100';
  END IF;
  IF p_ttl_seconds IS NULL
    OR p_ttl_seconds < 60
    OR p_ttl_seconds > 86400
  THEN
    RAISE EXCEPTION 'Requirement lock TTL must be between 60 and 86400 seconds';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('requirement-cron-global-capacity', 0)
  );

  UPDATE public.requirements AS requirement
  SET
    cron_lock_expires_at = NULL,
    cron_lock_run_id = NULL,
    cron_lock_active = false
  WHERE requirement.cron_lock_expires_at > v_now
    AND (
      COALESCE(requirement.status, '') NOT IN ('backlog', 'in-progress')
      OR EXISTS (
        SELECT 1
        FROM public.remote_instances AS instance
        WHERE instance.id::text =
          requirement.metadata->>'runner_instance_id'
          AND instance.status = 'paused'
      )
      OR COALESCE((
        SELECT plan.status
        FROM public.instance_plans AS plan
        WHERE plan.instance_id::text =
          requirement.metadata->>'runner_instance_id'
          AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
        ORDER BY plan.created_at DESC, plan.id DESC
        LIMIT 1
      ), '') = 'paused'
      OR (
        requirement.cron_lock_expires_at < v_now + pg_catalog.make_interval(
          secs => GREATEST(p_ttl_seconds - 1800, 0)
        )
        AND GREATEST(
          COALESCE(requirement.updated_at, '-infinity'::timestamptz),
          COALESCE((
            SELECT max(status.updated_at)
            FROM public.requirement_status AS status
            WHERE status.requirement_id = requirement.id
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(plan.updated_at)
            FROM public.instance_plans AS plan
            WHERE plan.metadata->>'requirement_id' = requirement.id::text
              OR plan.instance_id::text =
                requirement.metadata->>'runner_instance_id'
          ), '-infinity'::timestamptz)
        ) < v_stale_cutoff
      )
    );

  SELECT count(*)::integer
  INTO v_active
  FROM public.requirements
  WHERE cron_lock_expires_at > v_now
    AND cron_lock_active = true;

  v_slots := GREATEST(0, p_max_concurrent - v_active);
  IF v_slots = 0 THEN
    RETURN NEXT jsonb_build_object(
      'state', 'capacity_full',
      'active_runs', v_active
    );
    RETURN;
  END IF;

  v_expires_at := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  FOR v_requirement IN
    SELECT requirement.*
    FROM public.requirements AS requirement
    WHERE requirement.created_at >= v_month_start
      AND requirement.updated_at >= v_month_start
      AND (
        requirement.status IN ('backlog', 'in-progress')
        OR (
          requirement.status = 'blocked'
          AND requirement.cron IS NOT NULL
        )
        OR (
          requirement.status IN ('on-review', 'done', 'cancelled')
          AND requirement.cron IS NOT NULL
        )
      )
      AND (
        requirement.cron_lock_expires_at IS NULL
        OR requirement.cron_lock_expires_at < v_now
      )
      AND NOT (
        requirement.id = ANY(COALESCE(p_excluded_ids, '{}'::uuid[]))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.remote_instances AS instance
        WHERE instance.id::text =
          requirement.metadata->>'runner_instance_id'
          AND instance.status = 'paused'
      )
      AND COALESCE((
        SELECT plan.status
        FROM public.instance_plans AS plan
        WHERE plan.instance_id::text =
          requirement.metadata->>'runner_instance_id'
          AND plan.status IN ('pending', 'in_progress', 'active', 'paused')
        ORDER BY plan.created_at DESC, plan.id DESC
        LIMIT 1
      ), '') <> 'paused'
    ORDER BY requirement.updated_at ASC NULLS FIRST, requirement.id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  LOOP
    v_run_id := 'cron-' || pg_catalog.gen_random_uuid()::text;

    UPDATE public.requirements
    SET
      cron_lock_expires_at = v_expires_at,
      cron_lock_run_id = v_run_id,
      cron_lock_active = false
    WHERE id = v_requirement.id;

    RETURN NEXT jsonb_build_object(
      'state', 'claimed',
      'requirement', to_jsonb(v_requirement),
      'run_id', v_run_id,
      'expires_at', v_expires_at
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_requirement_cron_candidates(
  integer,
  integer,
  uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_requirement_cron_candidates(
  integer,
  integer,
  uuid[]
) TO service_role;
