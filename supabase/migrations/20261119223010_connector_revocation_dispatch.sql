BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.connectors ADD COLUMN revocation_dispatched boolean NOT NULL DEFAULT false;
-- Historical pending writes have no proof that dispatch did not occur.
UPDATE public.connectors SET revocation_dispatched = true WHERE revocation_pending;
GRANT SELECT (revocation_dispatched) ON public.connectors TO authenticated;

CREATE FUNCTION public.connector_claim_revocation(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer,
  p_credential_revision text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer; v_connector public.connectors%ROWTYPE;
BEGIN
  v_revision := public.connector_lock_for_manager(p_site_id,p_connector_id,p_actor_id,p_expected_revision);
  SELECT * INTO v_connector FROM public.connectors WHERE id=p_connector_id AND site_id=p_site_id;
  IF NOT v_connector.revocation_pending OR v_connector.enabled OR v_connector.revocation_dispatched
    OR v_connector.provider_status='REVOKED' THEN
    RAISE EXCEPTION 'Connector revocation cannot be dispatched' USING ERRCODE='40001';
  END IF;
  IF p_credential_revision IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.site_connector_providers p WHERE p.id=v_connector.provider_id
      AND p.site_id=p_site_id AND p.status='active' AND p.credential_revision=p_credential_revision
  ) THEN RAISE EXCEPTION 'Connector credentials changed' USING ERRCODE='40001'; END IF;
  UPDATE public.connectors SET revocation_dispatched=true,revision=v_revision+1,updated_at=now()
    WHERE id=p_connector_id AND site_id=p_site_id RETURNING * INTO v_connector;
  INSERT INTO public.connector_audit_events(site_id,connector_id,actor_id,event_type,revision)
    VALUES(p_site_id,p_connector_id,p_actor_id,'provider_state_updated',v_revision+1);
  RETURN to_jsonb(v_connector);
END;
$$;
REVOKE ALL ON FUNCTION public.connector_claim_revocation(uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.connector_claim_revocation(uuid,uuid,uuid,integer,text) TO service_role;

COMMIT;