-- Rollback:
-- DROP INDEX IF EXISTS public.voice_call_deliveries_one_active_recipient_idx;

CREATE UNIQUE INDEX IF NOT EXISTS voice_call_deliveries_one_active_recipient_idx
ON public.voice_call_deliveries (recipient_phone)
WHERE status IN (
  'placing',
  'placement_unknown',
  'queued',
  'ringing',
  'in_progress'
);
