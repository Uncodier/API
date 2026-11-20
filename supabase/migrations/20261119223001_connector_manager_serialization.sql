BEGIN;
SET LOCAL lock_timeout = '5s';

-- Serialize admission with updates/deletions of the actor's authority rows.
-- This lock is held through the grant/policy/state transaction, including waits
-- for existing grant rows, so actor removal cannot commit before a pending grant.
CREATE OR REPLACE FUNCTION public.connector_lock_for_manager(
  p_site_id uuid, p_connector_id uuid, p_actor_id uuid, p_expected_revision integer
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_revision integer;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Connector service role required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.sites WHERE id=p_site_id FOR SHARE;
  PERFORM 1 FROM public.site_ownership WHERE site_id=p_site_id AND user_id=p_actor_id FOR SHARE;
  PERFORM 1 FROM public.site_members WHERE site_id=p_site_id AND user_id=p_actor_id ORDER BY id FOR SHARE;
  SELECT c.revision INTO v_revision FROM public.connectors c
    WHERE c.id=p_connector_id AND c.site_id=p_site_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.connector_effective_site_access(p_site_id,p_actor_id) a WHERE a.can_manage
  ) THEN RAISE EXCEPTION 'Connector management denied' USING ERRCODE='42501'; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<>v_revision THEN
    RAISE EXCEPTION 'Connector revision conflict' USING ERRCODE='40001';
  END IF;
  RETURN v_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_lock_for_manager(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;

COMMIT;