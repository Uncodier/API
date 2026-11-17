BEGIN;
SET LOCAL lock_timeout = '5s';

-- Historical creators cannot be inferred from a shared query or its segments.
ALTER TABLE public.icp_mining ADD COLUMN user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.icp_mining ALTER COLUMN user_id SET DEFAULT auth.uid();
CREATE INDEX icp_mining_site_user_created_idx ON public.icp_mining(site_id, user_id, created_at DESC);

-- Match Robots: owned records for assigned-only members; existing site access
-- for owners/co-owners and unrestricted licensed members. Unknown owners deny.
CREATE FUNCTION public.finder_list_row_access(p_site uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.user_can(p_site, 'select') IS TRUE
    AND EXISTS (
      SELECT 1 FROM public.sites s WHERE s.id = p_site AND (
        s.user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM public.site_ownership so
          WHERE so.site_id = s.id AND so.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.site_members sm
          WHERE sm.site_id = s.id AND sm.user_id = auth.uid() AND sm.status = 'active'
            AND (NOT coalesce(sm.restrict_to_assigned_only, false) OR p_user = auth.uid()))
      )
    );
$$;
REVOKE ALL ON FUNCTION public.finder_list_row_access(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finder_list_row_access(uuid, uuid) TO authenticated;

CREATE FUNCTION public.guard_finder_list_attribution()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF current_setting('role', true) NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Finder list attribution requires authentication' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.user_id := coalesce(NEW.user_id, auth.uid());
    IF NEW.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Finder list attribution must match the actor' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Finder list attribution is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_finder_list_attribution() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER finder_list_attribution_guard BEFORE INSERT OR UPDATE ON public.icp_mining
FOR EACH ROW EXECUTE FUNCTION public.guard_finder_list_attribution();

ALTER TABLE public.icp_mining ENABLE ROW LEVEL SECURITY;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.icp_mining FROM PUBLIC, anon, authenticated;
CREATE POLICY finder_list_ownership_anon ON public.icp_mining
AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
DECLARE operation text; predicate text;
BEGIN
  FOREACH operation IN ARRAY ARRAY['select','insert','update','delete'] LOOP
    predicate := format(
      'public.finder_list_row_access(site_id, user_id) AND public.user_can(site_id, %L) IS TRUE', operation);
    EXECUTE format('CREATE POLICY %I ON public.icp_mining AS RESTRICTIVE FOR %s TO authenticated %s %s',
      'finder_list_ownership_' || operation, upper(operation),
      CASE WHEN operation <> 'insert' THEN 'USING (' || predicate || ')' ELSE '' END,
      CASE WHEN operation IN ('insert','update') THEN 'WITH CHECK (' || predicate || ')' ELSE '' END);
    -- Segment selection is optional. Grants still intersect ownership and all
    -- existing location guards; no service-role bypass is added for clients.
    IF operation <> 'select' THEN
      EXECUTE format('CREATE POLICY %I ON public.icp_mining FOR %s TO authenticated %s %s',
        'finder_list_site_' || operation, upper(operation),
        CASE WHEN operation <> 'insert' THEN 'USING (' || predicate || ')' ELSE '' END,
        CASE WHEN operation IN ('insert','update') THEN 'WITH CHECK (' || predicate || ')' ELSE '' END);
    END IF;
  END LOOP;
END;
$$;

COMMIT;