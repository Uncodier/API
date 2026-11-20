BEGIN;
SET LOCAL lock_timeout = '5s';

-- Internal actor-explicit resolver: never callable directly by browser roles.
CREATE FUNCTION public.connector_effective_site_access(p_site_id uuid, p_user_id uuid)
RETURNS TABLE(can_view boolean, can_manage boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site public.sites%ROWTYPE; v_member public.site_members%ROWTYPE;
  v_count integer; v_coowner boolean; v_manager boolean;
BEGIN
  can_view := false; can_manage := false;
  SELECT * INTO v_site FROM public.sites s WHERE s.id = p_site_id AND s.archived_at IS NULL;
  IF NOT FOUND OR p_user_id IS NULL THEN RETURN NEXT; RETURN; END IF;
  IF v_site.user_id = p_user_id THEN
    can_view := true; can_manage := true; RETURN NEXT; RETURN;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.site_ownership o
    WHERE o.site_id = p_site_id AND o.user_id = p_user_id) INTO v_coowner;
  SELECT count(*) INTO v_count FROM public.site_members m
    WHERE m.site_id = p_site_id AND m.user_id = p_user_id;
  IF v_count = 0 AND v_coowner THEN
    can_view := true; can_manage := true; RETURN NEXT; RETURN;
  END IF;
  IF v_count <> 1 THEN RETURN NEXT; RETURN; END IF;
  SELECT * INTO v_member FROM public.site_members m
    WHERE m.site_id = p_site_id AND m.user_id = p_user_id;
  IF v_member.status IS DISTINCT FROM 'active'
    OR public.site_member_has_effective_license(v_member.id) IS NOT TRUE
    OR v_member.role NOT IN ('owner','admin','collaborator','marketing')
  THEN RETURN NEXT; RETURN; END IF;
  v_manager := v_coowner OR v_member.role IN ('owner','admin');
  -- Match current unscoped location and screen rules: owners/admins are exempt.
  IF NOT v_manager AND (
    v_member.blocked_screens IS NULL OR 'connectors' = ANY(v_member.blocked_screens)
    OR EXISTS (SELECT 1 FROM public.site_member_location_restrictions r
      WHERE r.site_id = p_site_id AND r.site_member_id = v_member.id)
  ) THEN RETURN NEXT; RETURN; END IF;
  can_view := true; can_manage := v_manager; RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_effective_site_access(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.connector_site_access(p_site_id uuid, p_user_id uuid)
RETURNS TABLE(can_view boolean, can_manage boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Inspect the actual SQL role, not a caller-set JWT role field.
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
    AND (auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid()) THEN
    RETURN QUERY SELECT false, false; RETURN;
  END IF;
  RETURN QUERY SELECT a.can_view, a.can_manage
    FROM public.connector_effective_site_access(p_site_id, p_user_id) a;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_site_access(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.connector_site_access(uuid, uuid) TO authenticated, service_role;

CREATE FUNCTION public.connector_visible(p_site_id uuid, p_connector_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.connector_site_access(p_site_id, auth.uid()) a
    WHERE a.can_view AND EXISTS (SELECT 1 FROM public.connectors c
      WHERE c.id = p_connector_id AND c.site_id = p_site_id)
    AND (a.can_manage OR EXISTS (SELECT 1 FROM public.connector_members m
      WHERE m.site_id = p_site_id AND m.connector_id = p_connector_id
        AND m.user_id = auth.uid() AND m.can_view AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp()))));
$$;
REVOKE ALL ON FUNCTION public.connector_visible(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.connector_visible(uuid, uuid) TO authenticated;

CREATE FUNCTION public.connector_guard_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_project text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
    OR NEW.toolkit_slug IS DISTINCT FROM OLD.toolkit_slug
    OR NEW.auth_config_id IS DISTINCT FROM OLD.auth_config_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.provider_project_id IS DISTINCT FROM OLD.provider_project_id
  ) THEN RAISE EXCEPTION 'Connector identity is immutable' USING ERRCODE = '23514'; END IF;
  SELECT p.project_id INTO v_project FROM public.site_connector_providers p
    WHERE p.id = NEW.provider_id AND p.site_id = NEW.site_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector provider site mismatch' USING ERRCODE = '23503'; END IF;
  IF NEW.provider_project_id IS NOT NULL AND NEW.provider_project_id <> v_project THEN
    RAISE EXCEPTION 'Connector provider project mismatch' USING ERRCODE = '23503';
  END IF;
  NEW.provider_project_id := v_project;
  IF NEW.revocation_pending OR NEW.provider_status <> 'ACTIVE' THEN NEW.enabled := false; END IF;
  NEW.updated_at := now(); RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_guard_identity() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER connector_identity_guard BEFORE INSERT OR UPDATE ON public.connectors
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_identity();

CREATE FUNCTION public.connector_guard_provider_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.provider_user_id IS DISTINCT FROM OLD.provider_user_id THEN
    RAISE EXCEPTION 'Connector provider identity is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now(); RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_guard_provider_identity() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER connector_provider_identity_guard BEFORE UPDATE ON public.site_connector_providers
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_provider_identity();

CREATE FUNCTION public.connector_guard_member_target()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Revocation of a departed user is still allowed; granting requires current eligibility.
  IF NEW.revoked_at IS NULL AND (NEW.can_view OR NEW.can_use) AND NOT EXISTS (
    SELECT 1 FROM public.connector_effective_site_access(NEW.site_id, NEW.user_id) a WHERE a.can_view
  ) THEN RAISE EXCEPTION 'Connector member target denied' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = NEW.site_id AND s.user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.site_ownership o WHERE o.site_id = NEW.site_id AND o.user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.site_members m WHERE m.site_id = NEW.site_id AND m.user_id = NEW.user_id)
    AND NOT (TG_OP = 'UPDATE' AND NEW.user_id = OLD.user_id AND NEW.site_id = OLD.site_id
      AND (NEW.revoked_at IS NOT NULL OR (NOT NEW.can_view AND NOT NEW.can_use))) THEN
    RAISE EXCEPTION 'Connector member site mismatch' USING ERRCODE = '23503';
  END IF;
  NEW.updated_at := now(); RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_guard_member_target() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER connector_member_target_guard BEFORE INSERT OR UPDATE ON public.connector_members
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_member_target();

-- Provider account/auth-config identifiers, creator IDs and project identity stay private.
GRANT SELECT (id, site_id, provider_id, toolkit_slug, display_name, provider_status, enabled,
  revocation_pending, granted_scopes, revision, verified_at, created_at, updated_at)
  ON public.connectors TO authenticated;
CREATE POLICY connector_safe_read ON public.connectors FOR SELECT TO authenticated
  USING (public.connector_visible(site_id, id));
GRANT SELECT ON public.connector_members, public.connector_agents, public.connector_policies,
  public.connector_audit_events TO authenticated;
CREATE POLICY connector_member_read ON public.connector_members FOR SELECT TO authenticated
  USING (public.connector_visible(site_id, connector_id) AND (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.connector_site_access(site_id, auth.uid()) a WHERE a.can_manage)));
CREATE POLICY connector_agent_read ON public.connector_agents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.connector_site_access(site_id, auth.uid()) a WHERE a.can_manage));
CREATE POLICY connector_policy_read ON public.connector_policies FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.connector_site_access(site_id, auth.uid()) a WHERE a.can_manage));
CREATE POLICY connector_audit_read ON public.connector_audit_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.connector_site_access(site_id, auth.uid()) a WHERE a.can_manage));

COMMIT;