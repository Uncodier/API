BEGIN;

CREATE INDEX provider_webhook_events_zavu_inbound_binding_idx
  ON private.provider_webhook_events (zavu_binding_hash)
  WHERE event_type = 'message.inbound' AND zavu_binding_hash IS NOT NULL
    AND provider IN ('zavu', 'zavu-inbound-message-v2');

-- The binding is inserted only after signature verification. A failed or
-- processing workflow does not revoke the authenticity of the inbound event.
CREATE FUNCTION public.has_signed_zavu_inbound_binding(p_binding_hash text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_binding_hash IS NOT NULL AND p_binding_hash ~ '^[0-9a-f]{64}$' AND EXISTS (
    SELECT 1 FROM private.provider_webhook_events
    WHERE event_type = 'message.inbound' AND zavu_binding_hash IS NOT NULL
      AND provider IN ('zavu', 'zavu-inbound-message-v2')
      AND zavu_binding_hash = p_binding_hash
  );
$$;

REVOKE ALL ON FUNCTION public.has_signed_zavu_inbound_binding(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_signed_zavu_inbound_binding(text) TO service_role;
COMMIT;