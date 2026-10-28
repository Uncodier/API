BEGIN;
SET LOCAL lock_timeout = '5s';

-- Infrastructure ownership only: never creates/reopens a requirement or a plan.
CREATE TABLE public.assistant_workspaces (
  instance_id uuid PRIMARY KEY REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id),
  sandbox_name text NOT NULL CHECK (sandbox_name = 'a-' || instance_id::text),
  active_sandbox_name text,
  initialized boolean NOT NULL DEFAULT false,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.assistant_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_workspaces FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assistant_workspaces TO service_role;
CREATE POLICY assistant_workspaces_service ON public.assistant_workspaces FOR SELECT TO service_role USING (true);

CREATE FUNCTION public.claim_assistant_workspace(p_instance_id uuid, p_site_id uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.assistant_workspaces%ROWTYPE;
BEGIN
  IF p_token IS NULL OR NOT EXISTS (SELECT 1 FROM public.remote_instances
    WHERE id=p_instance_id AND site_id=p_site_id AND is_archived IS NOT TRUE) THEN
    RAISE EXCEPTION 'Assistant workspace scope unavailable';
  END IF;
  INSERT INTO public.assistant_workspaces(instance_id,site_id,sandbox_name)
    VALUES(p_instance_id,p_site_id,'a-' || p_instance_id::text) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.assistant_workspaces WHERE instance_id=p_instance_id FOR UPDATE;
  IF r.site_id <> p_site_id THEN RAISE EXCEPTION 'Assistant workspace site mismatch'; END IF;
  IF r.lease_token IS NOT NULL AND r.lease_token<>p_token AND r.lease_expires_at>clock_timestamp() THEN RETURN NULL; END IF;
  UPDATE public.assistant_workspaces SET lease_token=p_token,lease_expires_at=clock_timestamp()+interval '300 seconds',
    updated_at=clock_timestamp() WHERE instance_id=p_instance_id RETURNING * INTO r;
  RETURN to_jsonb(r);
END;
$$;

CREATE FUNCTION public.renew_assistant_workspace(p_instance_id uuid, p_site_id uuid, p_token uuid,
  p_initialized boolean DEFAULT false, p_resource text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_resource IS NOT NULL AND p_resource <> 'a-' || p_instance_id::text
    AND p_resource !~ '^ai-[0-9a-f]{40}$' THEN RAISE EXCEPTION 'Invalid assistant workspace resource'; END IF;
  UPDATE public.assistant_workspaces w SET lease_expires_at=clock_timestamp()+interval '300 seconds',
    initialized=w.initialized OR coalesce(p_initialized,false),
    active_sandbox_name=coalesce(p_resource,w.active_sandbox_name),updated_at=clock_timestamp()
    WHERE w.instance_id=p_instance_id AND w.site_id=p_site_id AND w.lease_token=p_token
      AND w.lease_expires_at>clock_timestamp() AND EXISTS (SELECT 1 FROM public.remote_instances i
        WHERE i.id=w.instance_id AND i.site_id=p_site_id AND i.is_archived IS NOT TRUE);
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.release_assistant_workspace(p_instance_id uuid,p_site_id uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.assistant_workspaces SET lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE instance_id=p_instance_id AND site_id=p_site_id AND lease_token=p_token;
  RETURN FOUND;
END;
$$;

ALTER TABLE public.sandbox_billing_resources DROP CONSTRAINT sandbox_billing_resources_owner_kind_check;
ALTER TABLE public.sandbox_billing_resources ADD CONSTRAINT sandbox_billing_resources_owner_kind_check
  CHECK (owner_kind IN ('harness','requirement','workflow','instance'));

-- Deletion intent survives the instance row and is consumed by the existing
-- billing-first housekeeping deletion path. No provider calls from a trigger.
-- This is NOT deletion_requested_at: that ledger field proves usage settled
-- before provider deletion and must never be forged by an instance DELETE.
CREATE TABLE public.assistant_workspace_deletions (
  sandbox_name text PRIMARY KEY REFERENCES public.sandbox_billing_resources(sandbox_name),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.assistant_workspace_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_workspace_deletions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.assistant_workspace_deletions TO service_role;
CREATE POLICY assistant_workspace_deletions_service ON public.assistant_workspace_deletions
  FOR SELECT TO service_role USING (true);
CREATE FUNCTION public.retire_deleted_assistant_workspaces()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.assistant_workspace_deletions(sandbox_name)
    SELECT sandbox_name FROM public.sandbox_billing_resources
    WHERE owner_kind='instance' AND owner_id=OLD.id AND site_id=OLD.site_id AND retired_at IS NULL
    ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;
CREATE TRIGGER retire_deleted_assistant_workspaces BEFORE DELETE ON public.remote_instances
  FOR EACH ROW EXECUTE FUNCTION public.retire_deleted_assistant_workspaces();
REVOKE ALL ON FUNCTION public.retire_deleted_assistant_workspaces() FROM PUBLIC,anon,authenticated;

-- Preserve all existing registration/credit accounting behavior; only add an
-- independently site-verified infrastructure owner for standalone instances.
CREATE OR REPLACE FUNCTION public.register_sandbox_billing(p_sandbox_name text,p_owner_kind text,
  p_owner_id uuid,p_site_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid; v_requirement uuid; v_available numeric; r public.sandbox_billing_resources%ROWTYPE;
BEGIN
  IF p_sandbox_name IS NULL OR length(p_sandbox_name) NOT BETWEEN 1 AND 200 OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Invalid sandbox billing owner';
  END IF;
  IF p_owner_kind='harness' THEN
    SELECT site_id,(snapshot#>>'{request,requirementId}')::uuid INTO v_site,v_requirement
      FROM public.harness_sessions WHERE id=p_owner_id FOR SHARE;
    IF v_requirement IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.requirements WHERE id=v_requirement AND site_id=v_site) THEN
        RAISE EXCEPTION 'Sandbox billing requirement ownership mismatch';
      END IF;
      p_owner_kind := 'requirement'; p_owner_id := v_requirement;
    END IF;
  ELSIF p_owner_kind='requirement' THEN
    SELECT site_id INTO v_site FROM public.requirements WHERE id=p_owner_id FOR SHARE;
  ELSIF p_owner_kind='workflow' THEN
    SELECT site_id INTO v_site FROM public.instance_plans WHERE id=p_owner_id FOR SHARE;
  ELSIF p_owner_kind='instance' THEN
    SELECT site_id INTO v_site FROM public.remote_instances WHERE id=p_owner_id AND is_archived IS NOT TRUE FOR SHARE;
    IF p_sandbox_name <> 'a-' || p_owner_id::text AND p_sandbox_name !~ '^ai-[0-9a-f]{40}$' THEN
      RAISE EXCEPTION 'Invalid instance sandbox name';
    END IF;
  ELSE RAISE EXCEPTION 'Invalid sandbox billing owner'; END IF;
  IF v_site IS NULL OR (p_site_id IS NOT NULL AND p_site_id<>v_site) THEN RAISE EXCEPTION 'Sandbox billing site ownership mismatch'; END IF;
  INSERT INTO public.sandbox_billing_resources(sandbox_name,site_id,owner_kind,owner_id)
    VALUES(p_sandbox_name,v_site,p_owner_kind,p_owner_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.sandbox_billing_resources WHERE sandbox_name=p_sandbox_name FOR UPDATE;
  IF r.site_id<>v_site THEN RAISE EXCEPTION 'Sandbox billing identity conflict'; END IF;
  IF r.owner_kind<>p_owner_kind OR r.owner_id<>p_owner_id THEN RAISE EXCEPTION 'Sandbox billing owner identity conflict'; END IF;
  IF r.deletion_requested_at IS NOT NULL AND r.retired_at IS NULL THEN RAISE EXCEPTION 'Sandbox deletion is pending'; END IF;
  PERFORM public.renew_site_plan_credits(v_site);
  SELECT credits_available INTO v_available FROM public.billing WHERE site_id=v_site FOR UPDATE;
  IF v_available IS NULL OR v_available<=0 THEN RETURN jsonb_build_object('success',false,'error','Sandbox requires available credits'); END IF;
  UPDATE public.sandbox_billing_resources SET deletion_requested_at=NULL,retired_at=NULL WHERE sandbox_name=p_sandbox_name;
  RETURN jsonb_build_object('success',true,'site_id',r.site_id,'registered_at',r.registered_at);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_assistant_workspace(uuid,uuid,uuid),
  public.renew_assistant_workspace(uuid,uuid,uuid,boolean,text),public.release_assistant_workspace(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_assistant_workspace(uuid,uuid,uuid),
  public.renew_assistant_workspace(uuid,uuid,uuid,boolean,text),public.release_assistant_workspace(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.register_sandbox_billing(text,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_sandbox_billing(text,text,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;