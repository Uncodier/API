-- Run each statement in autocommit: concurrent index builds preserve message writes.

-- Match the PostgREST ->/->> equality expressions in pinned-delivery-events.
-- Do not filter by role, source or receipt kind: other messages can make a
-- receipt ambiguous. Use full expression indexes so ANALYZE collects the
-- expression statistics needed to cost the OR under LIMIT 2. Hash indexes
-- support exact equality (heap recheck) without imposing a btree key-size
-- limit on historical or future arbitrary JSON field values.
CREATE INDEX CONCURRENTLY messages_zavu_provider_idx ON public.messages USING hash
  ((custom_data->>'provider_message_id'));
CREATE INDEX CONCURRENTLY messages_zavu_text_provider_idx ON public.messages USING hash
  ((custom_data->'pinned_text_delivery'->>'provider_message_id'));
CREATE INDEX CONCURRENTLY messages_zavu_media_provider_idx ON public.messages USING hash
  ((custom_data->'native_media_delivery'->>'provider_message_id'));
CREATE INDEX CONCURRENTLY messages_zavu_template_provider_idx ON public.messages USING hash
  ((custom_data->'template_delivery'->>'provider_message_id'));
CREATE INDEX CONCURRENTLY messages_zavu_audio_provider_idx ON public.messages USING hash
  ((custom_data->'audio_delivery'->>'provider_message_id'));
CREATE INDEX CONCURRENTLY messages_zavu_text_attempt_idx ON public.messages USING hash
  ((custom_data->'pinned_text_delivery'->>'id'));
CREATE INDEX CONCURRENTLY messages_zavu_media_attempt_idx ON public.messages USING hash
  ((custom_data->'native_media_delivery'->>'id'));

-- Do not wait for autoanalyze after creating the expression indexes.
ANALYZE public.messages;
