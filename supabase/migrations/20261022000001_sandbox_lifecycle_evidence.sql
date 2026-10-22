BEGIN;
SET LOCAL lock_timeout = '5s';

-- No automatic expiry: an in-flight provider stop may outlive a lease/timeout.
-- A lost response needs control-plane inspection before an operator releases it.
ALTER TABLE public.harness_sessions ADD COLUMN sandbox_cleanup_token uuid,
  ADD COLUMN sandbox_cleanup_resource text, ADD COLUMN sandbox_cleanup_started_at timestamptz;
ALTER TABLE public.harness_sessions ADD CONSTRAINT harness_cleanup_pair CHECK
  ((sandbox_cleanup_token IS NULL) = (sandbox_cleanup_resource IS NULL)
   AND (sandbox_cleanup_token IS NULL) = (sandbox_cleanup_started_at IS NULL));

CREATE FUNCTION public.guard_harness_sandbox_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.snapshot#>>'{request,requirementId}' IS NOT NULL THEN
    PERFORM 1 FROM public.requirements WHERE id::text=NEW.snapshot#>>'{request,requirementId}' FOR SHARE;
    IF NEW.snapshot->>'status' IN ('queued','running') AND EXISTS (
      SELECT 1 FROM public.harness_sessions s WHERE s.id<>NEW.id AND s.sandbox_cleanup_token IS NOT NULL
        AND s.site_id=NEW.site_id AND s.snapshot#>>'{request,requirementId}'=NEW.snapshot#>>'{request,requirementId}') THEN
      RAISE EXCEPTION 'Sandbox cleanup requires reconciliation';
    END IF;
  END IF;
  -- Another occurrence cannot attach/dispatch against a resource being deleted.
  IF NEW.snapshot#>>'{workspace,id}' IS NOT NULL THEN
    PERFORM 1 FROM public.sandbox_billing_resources
      WHERE sandbox_name=NEW.snapshot#>>'{workspace,id}' FOR UPDATE;
  END IF;
  IF NEW.snapshot#>>'{workspace,id}' IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.harness_sessions WHERE sandbox_cleanup_token IS NOT NULL
      AND sandbox_cleanup_resource=NEW.snapshot#>>'{workspace,id}' AND id<>NEW.id) THEN
    RAISE EXCEPTION 'Sandbox cleanup requires reconciliation';
  END IF;
  IF TG_OP='UPDATE' AND OLD.sandbox_cleanup_token IS NOT NULL AND NEW.sandbox_cleanup_token IS NOT NULL AND
    (NEW.snapshot->>'status' IN ('queued','running') AND NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner) THEN
    RAISE EXCEPTION 'Sandbox cleanup requires reconciliation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_sandbox_cleanup_guard BEFORE INSERT OR UPDATE ON public.harness_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_harness_sandbox_cleanup();

CREATE FUNCTION public.begin_harness_sandbox_cleanup(p_id uuid,p_site_id uuid,p_owner text,
  p_resource text,p_token uuid,p_bootstrap boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.harness_sessions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR r.sandbox_cleanup_token IS NOT NULL THEN RETURN false; END IF;
  -- Serializes against register_sandbox_billing (which locks this same row).
  PERFORM 1 FROM public.sandbox_billing_resources WHERE sandbox_name=p_resource FOR UPDATE;
  IF p_owner IS NULL THEN
    PERFORM 1 FROM public.requirements WHERE id::text=r.snapshot#>>'{request,requirementId}' FOR UPDATE;
    -- Housekeeping may discover canonical h-session resources, but only from
    -- trusted same-tenant requirement sessions with no resumable references.
    IF p_bootstrap OR p_resource IS DISTINCT FROM 'h-'||p_id::text
      OR r.snapshot->>'status' NOT IN ('completed','cancelled','failed')
      OR r.lease_expires_at > clock_timestamp()
      OR NOT EXISTS (SELECT 1 FROM public.sandbox_billing_resources b JOIN public.requirements q
        ON q.id=b.owner_id AND q.site_id=b.site_id WHERE b.sandbox_name=p_resource
        AND b.site_id=p_site_id AND b.owner_kind='requirement'
        AND q.id::text=r.snapshot#>>'{request,requirementId}' AND q.status IN ('done','cancelled','canceled'))
      OR EXISTS (SELECT 1 FROM public.harness_sessions s WHERE s.snapshot#>>'{workspace,id}'=p_resource
        AND (s.site_id<>p_site_id OR s.snapshot#>>'{request,requirementId}' IS DISTINCT FROM r.snapshot#>>'{request,requirementId}'
          OR s.snapshot->>'status' NOT IN ('completed','cancelled','failed') OR s.lease_expires_at>clock_timestamp()))
      OR EXISTS (SELECT 1 FROM public.harness_sessions s WHERE s.site_id=p_site_id
        AND s.snapshot#>>'{request,requirementId}'=r.snapshot#>>'{request,requirementId}'
        AND (s.snapshot->>'status' NOT IN ('completed','cancelled','failed') OR s.lease_expires_at>clock_timestamp()))
      OR EXISTS (SELECT 1 FROM public.requirement_status WHERE active_sandbox_id=p_resource)
      OR EXISTS (SELECT 1 FROM public.instance_plans WHERE metadata->>'active_sandbox_id'=p_resource) THEN RETURN false; END IF;
  ELSIF r.lease_owner IS DISTINCT FROM p_owner OR r.lease_expires_at <= clock_timestamp()
    OR r.lease_expires_at IS NULL THEN RETURN false;
  ELSIF p_bootstrap THEN
    IF p_resource IS DISTINCT FROM 'h-'||p_id::text OR r.snapshot ? 'workspace'
      OR r.snapshot->>'status' NOT IN ('running','waiting','paused','failed') THEN RETURN false; END IF;
  ELSE
    IF r.snapshot->>'status' NOT IN ('waiting','paused','completed','cancelled','failed')
      OR r.snapshot#>>'{workspace,id}' IS DISTINCT FROM p_resource THEN RETURN false; END IF;
  END IF;
  UPDATE public.harness_sessions SET sandbox_cleanup_token=p_token,
    sandbox_cleanup_resource=p_resource,sandbox_cleanup_started_at=clock_timestamp() WHERE id=p_id;
  RETURN true;
END;
$$;
-- register_sandbox_billing performs an UPDATE before admitting dispatch/adoption.
CREATE FUNCTION public.guard_sandbox_cleanup_registration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.harness_sessions WHERE sandbox_cleanup_token IS NOT NULL
    AND sandbox_cleanup_resource=NEW.sandbox_name)
    AND NEW.deletion_requested_at IS NOT DISTINCT FROM OLD.deletion_requested_at
    AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'Sandbox cleanup requires reconciliation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sandbox_cleanup_registration_guard BEFORE UPDATE OF deletion_requested_at,retired_at ON public.sandbox_billing_resources
  FOR EACH ROW EXECUTE FUNCTION public.guard_sandbox_cleanup_registration();
CREATE FUNCTION public.guard_requirement_sandbox_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('done','cancelled','canceled') AND EXISTS (
    SELECT 1 FROM public.harness_sessions WHERE sandbox_cleanup_token IS NOT NULL AND site_id=NEW.site_id
      AND snapshot#>>'{request,requirementId}'=NEW.id::text) THEN
    RAISE EXCEPTION 'Sandbox cleanup requires reconciliation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_sandbox_cleanup_guard BEFORE UPDATE OF status ON public.requirements
  FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_sandbox_cleanup();
CREATE FUNCTION public.assert_harness_sandbox_cleanup(p_id uuid,p_site_id uuid,p_token uuid,p_resource text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id
    AND sandbox_cleanup_token=p_token AND sandbox_cleanup_resource=p_resource);
$$;
CREATE FUNCTION public.finish_harness_sandbox_cleanup(p_id uuid,p_site_id uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.harness_sessions SET sandbox_cleanup_token=NULL,sandbox_cleanup_resource=NULL,
    sandbox_cleanup_started_at=NULL WHERE id=p_id AND site_id=p_site_id AND sandbox_cleanup_token=p_token;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_harness_sandbox_cleanup(),public.guard_sandbox_cleanup_registration(),public.guard_requirement_sandbox_cleanup(),
  public.begin_harness_sandbox_cleanup(uuid,uuid,text,text,uuid,boolean),
  public.assert_harness_sandbox_cleanup(uuid,uuid,uuid,text),
  public.finish_harness_sandbox_cleanup(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_harness_sandbox_cleanup(uuid,uuid,text,text,uuid,boolean),
  public.assert_harness_sandbox_cleanup(uuid,uuid,uuid,text),
  public.finish_harness_sandbox_cleanup(uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;