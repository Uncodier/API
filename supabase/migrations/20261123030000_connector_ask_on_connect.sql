BEGIN;
SET LOCAL lock_timeout = '5s';

-- Only the notice-aware server START sets this constant on a fresh OAuth attempt.
-- Old writers, in-flight attempts and the hosted Management PAT path stay off.
ALTER TABLE public.site_connector_auth_attempts ADD COLUMN ask_on_connect boolean NOT NULL DEFAULT false;
-- The actor-explicit access resolver is owner-only. No authenticated caller can
-- create an attempt or acquire service authority via a JWT field.
CREATE FUNCTION connector_result_private.guard_ask_start() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ask_on_connect AND (current_setting('role',true) IS DISTINCT FROM 'service_role'
      OR NEW.status <> 'pending' OR NEW.provider_account_id IS NOT NULL OR NEW.supabase_project_ref IS NOT NULL
      OR NOT EXISTS (SELECT FROM public.connector_effective_site_access(NEW.site_id,NEW.user_id) a WHERE a.can_manage)) THEN
      RAISE EXCEPTION 'Verified manager onboarding required' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.ask_on_connect IS DISTINCT FROM OLD.ask_on_connect THEN
    RAISE EXCEPTION 'Onboarding intent is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_ask_start BEFORE INSERT OR UPDATE OF ask_on_connect ON public.site_connector_auth_attempts
  FOR EACH ROW EXECUTE FUNCTION connector_result_private.guard_ask_start();

-- NULL is no pending intent, including on every historical revision. Connector
-- identity, creator and project are immutable; the credential revision is not.
-- The private CAS row survives deletion/revocation of a proof or enrollment.
ALTER TABLE connector_result_private.direct_revisions ADD COLUMN setup_credential_revision text COLLATE "C"
  CHECK (setup_credential_revision IS NULL OR (direct_revision=1 AND setup_credential_revision ~ '^(platform:)?[a-f0-9]{64}$'));
CREATE INDEX connector_ask_completed_attempt_idx ON public.site_connector_auth_attempts(connector_id)
  WHERE ask_on_connect AND status='completed';

-- Both supported finalizers emit this owner-written event only on first creation,
-- after associating the exact attempt, never on callback replay, sync, raw
-- account INSERT, policy upsert or legacy project binding. Do not replace their
-- bodies: installations can have different legacy catalog-read defaults.
CREATE FUNCTION connector_result_private.capture_ask_setup() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  INSERT INTO connector_result_private.direct_revisions(connector_id,direct_revision,setup_credential_revision)
  SELECT c.id,1,a.credential_revision FROM public.site_connector_auth_attempts a
    JOIN public.connectors c ON (c.id,c.site_id,c.created_by,c.provider_id,c.provider_account_id,c.toolkit_slug,c.auth_config_id)=
      (a.connector_id,a.site_id,a.user_id,a.provider_id,a.provider_account_id,a.toolkit_slug,a.auth_config_id)
    JOIN public.site_connector_providers p ON (p.id,p.site_id,p.project_id,p.credential_revision)=
      (c.provider_id,c.site_id,c.provider_project_id,a.credential_revision)
    WHERE a.ask_on_connect AND a.status='completed' AND a.supabase_project_ref IS NULL
      AND a.credential_revision COLLATE "C" ~ '^(platform:)?[a-f0-9]{64}$'
      AND (c.id,c.site_id,c.created_by,c.revision)=(NEW.connector_id,NEW.site_id,NEW.actor_id,NEW.revision)
      AND c.enabled AND c.provider_status='ACTIVE' AND c.verified_at IS NOT NULL AND c.provider_account_id<>'instant_account'
      AND NOT c.revocation_pending AND NOT c.revocation_dispatched AND p.status='active' AND p.provider_user_id=c.site_id::text
      AND EXISTS (SELECT FROM public.connector_effective_site_access(c.site_id,c.created_by) m WHERE m.can_manage)
    ON CONFLICT (connector_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER capture_ask_setup AFTER INSERT ON public.connector_audit_events FOR EACH ROW
  WHEN (NEW.event_type='auth_completed' AND NEW.revision=1) EXECUTE FUNCTION connector_result_private.capture_ask_setup();

-- Every proof epoch change and every successful direct manager CAS (including
-- disabled -> disabled on the legacy RPC) spends initial intent irreversibly.
CREATE FUNCTION connector_result_private.consume_ask_setup() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.setup_credential_revision := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER consume_ask_setup BEFORE UPDATE OF direct_revision ON connector_result_private.direct_revisions
  FOR EACH ROW EXECUTE FUNCTION connector_result_private.consume_ask_setup();

-- Revocation while waiting must remain terminal even if the same local account
-- is made active again. Ordinary grant/host/tool edits are *not* authority loss:
-- the saved policy still gates each admission and must never be reset on setup.
CREATE FUNCTION connector_result_private.cancel_account_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE connector_result_private.direct_revisions SET direct_revision=direct_revision+1
    WHERE connector_id=NEW.id AND setup_credential_revision IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER cancel_account_setup AFTER UPDATE ON public.connectors FOR EACH ROW
  WHEN (OLD.enabled AND (NOT NEW.enabled OR NEW.verified_at IS NULL OR NEW.provider_status<>'ACTIVE'
    OR NEW.revocation_pending OR NEW.revocation_dispatched OR NOT
      (NEW.granted_scopes @> OLD.granted_scopes AND NEW.granted_scopes <@ OLD.granted_scopes)))
  EXECUTE FUNCTION connector_result_private.cancel_account_setup();

CREATE FUNCTION connector_result_private.cancel_provider_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE connector_result_private.direct_revisions d SET direct_revision=d.direct_revision+1
    FROM public.connectors c WHERE c.id=d.connector_id AND c.site_id=NEW.site_id AND c.provider_id=NEW.id
      AND d.setup_credential_revision IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER cancel_provider_setup AFTER UPDATE ON public.site_connector_providers FOR EACH ROW
  WHEN (OLD.credential_revision IS DISTINCT FROM NEW.credential_revision OR (OLD.status='active' AND NEW.status<>'active'))
  EXECUTE FUNCTION connector_result_private.cancel_provider_setup();

CREATE OR REPLACE FUNCTION connector_result_private.direct_proof_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE manager uuid; saved_revision integer; epoch_revision integer; setup_candidate boolean := false;
BEGIN
  IF TG_OP='INSERT' THEN
    -- Only a fresh current proof can be inserted, with or without onboarding.
    -- Lock in manager order (authority rows, connector, direct revision), not
    -- while holding the CAS row. A pending grant cannot race actor removal or an
    -- earlier account disable. The final predicate below runs *after* these waits.
    SELECT c.created_by INTO manager FROM connector_result_private.direct_revisions d
      JOIN public.connectors c ON c.id=d.connector_id
      WHERE (c.id,c.site_id)=(NEW.connector_id,NEW.site_id) AND d.setup_credential_revision=NEW.credential_revision;
    setup_candidate := FOUND;
    IF setup_candidate THEN
      PERFORM FROM public.sites WHERE id=NEW.site_id FOR SHARE;
      PERFORM FROM public.site_ownership WHERE (site_id,user_id)=(NEW.site_id,manager) FOR SHARE;
      PERFORM FROM public.site_members WHERE (site_id,user_id)=(NEW.site_id,manager) ORDER BY id FOR SHARE;
      SELECT c.revision INTO saved_revision FROM public.connectors c WHERE c.id=NEW.connector_id FOR SHARE;
      -- Serialize with a transport revision change even if it is later restored.
      PERFORM FROM public.site_connector_providers p WHERE p.id=NEW.provider_id FOR SHARE;
    END IF;
    IF NOT EXISTS (SELECT FROM connector_result_private.direct_bindings b WHERE b.id=NEW.id AND b.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'Exact current provider and resource binding required' USING ERRCODE='23514';
    END IF;
  END IF;

  -- Identical epoch invalidation to the prior trigger, including parent cascade
  -- behavior. A manager CAS that won while we waited cannot be overwritten.
  INSERT INTO connector_result_private.direct_revisions AS d(connector_id,direct_revision)
    SELECT c.id,2 FROM public.connectors c WHERE c.id=coalesce(NEW.connector_id,OLD.connector_id)
    ON CONFLICT (connector_id) DO UPDATE SET direct_revision=d.direct_revision+1
    RETURNING direct_revision INTO epoch_revision;
  IF setup_candidate AND epoch_revision=2 AND NEW.expires_at>clock_timestamp() AND EXISTS (
    SELECT FROM public.connector_effective_site_access(NEW.site_id,manager) a WHERE a.can_manage) THEN
    INSERT INTO connector_result_private.direct_enrollments(connector_id,site_id,attestation_id,enabled_by)
      VALUES (NEW.connector_id,NEW.site_id,NEW.id,manager);
    INSERT INTO connector_result_private.direct_policy_events(connector_id,direct_revision,connector_revision,actor_id,enabled)
      VALUES (NEW.connector_id,epoch_revision,saved_revision,manager,true);
  END IF;
  RETURN NULL;
END $$;

-- Separate manager RPCs: the released API strictly validates the old five-key
-- DTO. Reuse the current manager check and exact binding, not account RLS read
-- visibility (which includes non-managers). Never publish a raw project ref to UI.
CREATE FUNCTION public.connector_ask_policy_status(p_site_id uuid,p_actor_id uuid,p_connector_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.connector_direct_policy(p_site_id,p_actor_id,p_connector_id) ||
    jsonb_build_object('setup_pending',EXISTS (SELECT FROM connector_result_private.direct_revisions d
      WHERE d.connector_id=p_connector_id AND d.setup_credential_revision IS NOT NULL),
      'bound_supabase_ref',(SELECT c.supabase_project_ref FROM public.connectors c
        WHERE (c.id,c.site_id)=(p_connector_id,p_site_id) AND c.toolkit_slug='supabase'));
$$;
CREATE FUNCTION public.connector_set_ask_policy(p_site_id uuid,p_actor_id uuid,p_connector_id uuid,
  p_expected_revision integer,p_expected_direct_revision integer,p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.connector_set_direct_policy(p_site_id,p_actor_id,p_connector_id,p_expected_revision,p_expected_direct_revision,p_enabled);
  RETURN public.connector_ask_policy_status(p_site_id,p_actor_id,p_connector_id);
END $$;
REVOKE ALL ON FUNCTION connector_result_private.guard_ask_start(), connector_result_private.capture_ask_setup(),
  connector_result_private.consume_ask_setup(), connector_result_private.cancel_account_setup(), connector_result_private.cancel_provider_setup(),
  public.connector_ask_policy_status(uuid,uuid,uuid), public.connector_set_ask_policy(uuid,uuid,uuid,integer,integer,boolean)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_ask_policy_status(uuid,uuid,uuid),
  public.connector_set_ask_policy(uuid,uuid,uuid,integer,integer,boolean) TO service_role;
COMMIT;