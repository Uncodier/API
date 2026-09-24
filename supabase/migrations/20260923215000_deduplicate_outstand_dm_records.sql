-- Rollback:
-- DROP INDEX IF EXISTS public.messages_outstand_dm_id_uidx;
-- DROP INDEX IF EXISTS public.conversations_outstand_dm_id_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_outstand_dm_id_uidx
  ON public.conversations (
    site_id,
    (custom_data->>'outstand_conversation_id')
  )
  WHERE channel = 'instagram'
    AND custom_data->>'source' = 'outstand_dm'
    AND custom_data->>'outstand_conversation_id' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_outstand_dm_id_uidx
  ON public.messages (
    conversation_id,
    (custom_data->>'outstand_message_id')
  )
  WHERE custom_data->>'source' = 'outstand_dm'
    AND custom_data->>'outstand_message_id' IS NOT NULL;
