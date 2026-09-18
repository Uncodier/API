-- Rollback:
-- DROP INDEX IF EXISTS public.instance_plans_one_active_per_instance_idx;

-- Preserve the newest active plan and retire older ambiguous rows before
-- enforcing the invariant. The stable id tie-breaker makes this deterministic.
WITH ranked_active_plans AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY instance_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS active_rank
  FROM public.instance_plans
  WHERE status IN ('pending', 'in_progress', 'active', 'paused')
    AND NULLIF(metadata->>'requirement_id', '') IS NOT NULL
)
UPDATE public.instance_plans AS plan
SET
  status = 'cancelled',
  updated_at = timezone('utc', now())
FROM ranked_active_plans AS ranked
WHERE plan.id = ranked.id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS instance_plans_one_active_per_instance_idx
  ON public.instance_plans (instance_id)
  WHERE status IN ('pending', 'in_progress', 'active', 'paused')
    AND NULLIF(metadata->>'requirement_id', '') IS NOT NULL;
