-- Rollback:
-- DROP INDEX IF EXISTS public.instance_logs_user_action_requirement_created_idx;

CREATE INDEX IF NOT EXISTS instance_logs_user_action_requirement_created_idx
  ON public.instance_logs (
    instance_id,
    ((details ->> 'requirement_id')),
    created_at DESC,
    id DESC
  )
  WHERE log_type = 'user_action';
