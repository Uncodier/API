-- Install atomically before admitting v2 traffic. Old inbound workers get a
-- retryable admission failure; drain them before cutover (and before rollback).
-- Do not remove this fence, clear receipts, or backfill unattributed rows.
BEGIN;
ALTER TABLE private.provider_webhook_events ADD COLUMN zavu_binding_hash text;

CREATE FUNCTION private.guard_zavu_inbound_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- BEFORE INSERT also runs on the legacy claimant's ON CONFLICT path.
    IF NEW.provider IN ('zavu', 'zavu-inbound-message-v2') AND NEW.event_type = 'message.inbound'
       AND NEW.zavu_binding_hash IS NULL THEN
      RAISE EXCEPTION 'Bound Zavu inbound admission required';
    END IF;
  ELSIF NEW.zavu_binding_hash IS DISTINCT FROM OLD.zavu_binding_hash OR
    ((OLD.zavu_binding_hash IS NOT NULL OR (OLD.provider = 'zavu' AND OLD.event_type = 'message.inbound'))
     AND (NEW.provider, NEW.event_id, NEW.event_type) IS DISTINCT FROM (OLD.provider, OLD.event_id, OLD.event_type)) THEN
    -- A lifecycle event with a colliding explicit ID cannot claim a failed turn.
    RAISE EXCEPTION 'Cannot change Zavu inbound receipt identity';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_zavu_inbound_claim() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_zavu_inbound_claim BEFORE INSERT OR UPDATE OF provider, event_id, event_type, zavu_binding_hash
  ON private.provider_webhook_events FOR EACH ROW EXECUTE FUNCTION private.guard_zavu_inbound_claim();

CREATE FUNCTION public.claim_zavu_inbound_webhook(
  p_event_id text, p_binding_hash text, p_claim_token uuid, p_fallback_message_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_provider text := CASE WHEN p_fallback_message_id IS NULL THEN 'zavu' ELSE 'zavu-inbound-message-v2' END;
  v_now timestamptz := clock_timestamp();
  v_expiry timestamptz := v_now + interval '5 minutes';
  v_row private.provider_webhook_events%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR btrim(p_event_id) = '' OR p_binding_hash IS NULL OR p_binding_hash !~ '^[0-9a-f]{64}$'
     OR p_claim_token IS NULL THEN RAISE EXCEPTION 'Invalid inbound receipt identity'; END IF;
  IF p_fallback_message_id IS NOT NULL THEN
    IF btrim(p_fallback_message_id) = '' OR p_event_id !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid fallback receipt identity';
    END IF;
    -- d69ad7dc used the bare messageId; b97813ee prefixed it with type.
    -- Neither old row has provenance. Never call the mutating legacy claim
    -- RPC to probe them; even a completed row is not a proven duplicate.
    IF EXISTS (SELECT FROM private.provider_webhook_events WHERE provider = 'zavu'
       AND event_id IN (p_fallback_message_id, 'message.inbound:' || p_fallback_message_id)
       AND zavu_binding_hash IS NULL) THEN
      RETURN jsonb_build_object('state','reconcile');
    END IF;
  END IF;
  INSERT INTO private.provider_webhook_events(provider,event_id,event_type,status,claim_token,
    attempt_count,claimed_at,claim_expires_at,zavu_binding_hash)
  VALUES (v_provider,p_event_id,'message.inbound','processing',p_claim_token,1,v_now,v_expiry,p_binding_hash)
  ON CONFLICT (provider,event_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('state','claimed','claim_expires_at',v_expiry,'reconcile_only',false);
  END IF;
  SELECT * INTO STRICT v_row FROM private.provider_webhook_events
    WHERE provider = v_provider AND event_id = p_event_id FOR UPDATE;
  IF v_row.event_type <> 'message.inbound' OR (v_row.zavu_binding_hash IS NOT NULL
      AND v_row.zavu_binding_hash <> p_binding_hash) THEN RETURN jsonb_build_object('state','reconcile'); END IF;
  -- Explicit IDs and signed-body digests retain their old namespace, completed
  -- ACK and active lease behavior. We cannot safely reopen an unbound failure.
  IF v_row.status = 'completed' THEN RETURN jsonb_build_object('state','completed'); END IF;
  IF v_row.status = 'processing' AND v_row.claim_expires_at > v_now THEN RETURN jsonb_build_object('state','busy'); END IF;
  IF v_row.zavu_binding_hash IS NULL OR v_row.status NOT IN ('processing','failed') THEN
    RETURN jsonb_build_object('state','reconcile');
  END IF;
  UPDATE private.provider_webhook_events SET status = 'processing', claim_token = p_claim_token,
    attempt_count = attempt_count + 1, claimed_at = v_now, claim_expires_at = v_expiry,
    completed_at = NULL, last_error = NULL, updated_at = v_now WHERE provider = v_provider AND event_id = p_event_id;
  RETURN jsonb_build_object('state','claimed','claim_expires_at',v_expiry,'reconcile_only',true);
END $$;
REVOKE ALL ON FUNCTION public.claim_zavu_inbound_webhook(text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_zavu_inbound_webhook(text,text,uuid,text) TO service_role;
COMMIT;
