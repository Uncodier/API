-- Permit pre-response channel-message workflows without changing existing trigger kinds.
ALTER TABLE public.workflow_triggers
  DROP CONSTRAINT IF EXISTS workflow_triggers_kind_check;
ALTER TABLE public.workflow_triggers
  ADD CONSTRAINT workflow_triggers_kind_check
  CHECK (kind IN ('cron', 'db_event', 'webhook', 'manual', 'channel_message'));