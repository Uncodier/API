-- The claim still locks and rechecks candidates in (updated_at, id) order.
-- Index a superset, not a second admission policy: live leases, scheduled IDs,
-- mapping/session recovery and tenant/billing eligibility remain RPC decisions.
CREATE INDEX CONCURRENTLY requirements_claim_candidates_idx
  ON public.requirements (updated_at, id)
  WHERE (created_at >= '2026-09-01 00:00:00+00'::timestamptz
      OR updated_at >= '2026-09-01 00:00:00+00'::timestamptz)
    AND NOT coalesce(metadata ? 'execution_hold', false)
    AND (status IN ('backlog','in-progress') OR status = 'blocked'
      OR (status IN ('done','on-review') AND cron IS NOT NULL));
