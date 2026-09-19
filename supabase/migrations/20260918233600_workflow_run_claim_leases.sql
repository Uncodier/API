-- Rollback:
-- DROP FUNCTION IF EXISTS public.finish_workflow_run_execution(uuid, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.renew_workflow_run_execution_claim(uuid, uuid, integer);
-- DROP FUNCTION IF EXISTS public.claim_workflow_run_execution(uuid, uuid, integer);
-- DROP INDEX IF EXISTS public.workflow_runs_active_claim_expiry_idx;
-- ALTER TABLE public.workflow_runs
--   DROP COLUMN IF EXISTS error_message,
--   DROP COLUMN IF EXISTS completed_at,
--   DROP COLUMN IF EXISTS claim_expires_at,
--   DROP COLUMN IF EXISTS claimed_at,
--   DROP COLUMN IF EXISTS claim_token;

ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS error_message text;

UPDATE public.workflow_runs
SET claim_expires_at = timezone('utc', now()) - interval '1 second'
WHERE status = 'in_progress'
  AND claim_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS workflow_runs_active_claim_expiry_idx
  ON public.workflow_runs (claim_expires_at)
  WHERE status = 'in_progress';

CREATE OR REPLACE FUNCTION public.claim_workflow_run_execution(
  p_run_plan_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 3600
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_expires_at timestamp with time zone;
BEGIN
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'Claim token is required';
  END IF;
  IF p_lease_seconds IS NULL
    OR p_lease_seconds < 60
    OR p_lease_seconds > 7200
  THEN
    RAISE EXCEPTION 'Lease seconds must be between 60 and 7200';
  END IF;

  v_expires_at :=
    timezone('utc', now()) + make_interval(secs => p_lease_seconds);

  UPDATE public.workflow_runs
  SET
    status = 'in_progress',
    claim_token = p_claim_token,
    claimed_at = timezone('utc', now()),
    claim_expires_at = v_expires_at,
    completed_at = NULL,
    error_message = NULL,
    updated_at = timezone('utc', now())
  WHERE run_plan_id = p_run_plan_id
    AND (
      status = 'pending'
      OR (
        status = 'in_progress'
        AND claim_expires_at <= timezone('utc', now())
      )
    )
  RETURNING claim_expires_at INTO v_expires_at;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'busy');
  END IF;
  RETURN jsonb_build_object(
    'state', 'claimed',
    'claim_expires_at', v_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_workflow_run_execution_claim(
  p_run_plan_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 3600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_lease_seconds IS NULL
    OR p_lease_seconds < 60
    OR p_lease_seconds > 7200
  THEN
    RAISE EXCEPTION 'Lease seconds must be between 60 and 7200';
  END IF;

  UPDATE public.workflow_runs
  SET
    claim_expires_at =
      timezone('utc', now()) + make_interval(secs => p_lease_seconds),
    updated_at = timezone('utc', now())
  WHERE run_plan_id = p_run_plan_id
    AND status = 'in_progress'
    AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_workflow_run_execution(
  p_run_plan_id uuid,
  p_claim_token uuid,
  p_status text,
  p_error_message text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('pending', 'completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid workflow run terminal status';
  END IF;

  UPDATE public.workflow_runs
  SET
    status = p_status,
    claim_token = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    completed_at = CASE
      WHEN p_status IN ('completed', 'failed', 'cancelled')
        THEN timezone('utc', now())
      ELSE NULL
    END,
    error_message = p_error_message,
    updated_at = timezone('utc', now())
  WHERE run_plan_id = p_run_plan_id
    AND status = 'in_progress'
    AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_workflow_run_execution(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_workflow_run_execution_claim(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_workflow_run_execution(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_workflow_run_execution(uuid, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_workflow_run_execution_claim(uuid, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_workflow_run_execution(uuid, uuid, text, text)
  TO service_role;
