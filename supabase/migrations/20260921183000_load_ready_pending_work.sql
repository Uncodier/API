-- Rollback:
-- DROP FUNCTION IF EXISTS public.load_ready_pending_work(integer);

CREATE OR REPLACE FUNCTION public.load_ready_pending_work(
  p_limit integer DEFAULT 200
)
RETURNS SETOF public.instance_pending_work
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidate_ids AS (
    SELECT DISTINCT ON (pending.instance_id)
      pending.id,
      pending.instance_id,
      pending.created_at
    FROM public.instance_pending_work AS pending
    WHERE pending.status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM public.instance_logs AS log
        WHERE log.instance_id = pending.instance_id
          AND log.log_type = 'user_action'
          AND log.details->>'status' = 'running'
      )
    ORDER BY
      pending.instance_id,
      CASE WHEN pending.status = 'claimed' THEN 0 ELSE 1 END,
      pending.created_at ASC
  ),
  locked AS (
    SELECT pending.id
    FROM public.instance_pending_work AS pending
    JOIN candidate_ids AS candidate ON candidate.id = pending.id
    ORDER BY candidate.created_at ASC
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE OF pending SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.instance_pending_work AS pending
    SET
      status = 'claimed',
      claimed_at = timezone('utc', now())
    FROM locked
    WHERE pending.id = locked.id
    RETURNING pending.*
  )
  SELECT * FROM claimed;
$$;

REVOKE ALL ON FUNCTION public.load_ready_pending_work(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_ready_pending_work(integer)
  TO service_role;
