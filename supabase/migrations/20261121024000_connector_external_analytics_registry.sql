BEGIN;
SET LOCAL lock_timeout = '5s';

-- Reviewed, non-secret source definitions only. No wildcard, default row, seed data or
-- management API. Database operators upsert one exact pair or delete it to revoke it.
CREATE TABLE connector_result_private.external_analytics_datasets (
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  project_ref text COLLATE "C" NOT NULL CHECK (project_ref ~ '^[a-z]{20}$'),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND
    jsonb_array_length(sources) BETWEEN 1 AND 8 AND octet_length(sources::text) <= 65536),
  PRIMARY KEY (site_id, project_ref)
);
ALTER TABLE connector_result_private.external_analytics_datasets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_result_private.external_analytics_datasets
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- Server only, after the host resolved the actor, instance, agent and current connector
-- use permission. Recheck the persisted binding and read its policy in a single snapshot.
-- No connector data API route, arbitrary project lookup, raw SQL, or external project call.
CREATE FUNCTION public.connector_external_analytics_dataset(
  p_site_id uuid, p_connector_id uuid, p_project_ref text, p_connector_revision integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Connector service role required' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object('siteId', c.site_id, 'projectRef', c.supabase_project_ref) ||
    CASE WHEN m.site_id IS NULL THEN '{"missing": true}'::jsonb ELSE jsonb_build_object('sources', m.sources) END
    INTO result
    FROM public.connectors c
    JOIN public.site_connector_providers p ON (p.id, p.site_id, p.project_id) = (c.provider_id, c.site_id, c.provider_project_id)
    JOIN public.connector_policies policy ON (policy.connector_id, policy.site_id) = (c.id, c.site_id)
    LEFT JOIN connector_result_private.external_analytics_datasets m ON (m.site_id, m.project_ref) = (c.site_id, c.supabase_project_ref)
    WHERE (c.id, c.site_id, c.supabase_project_ref, c.revision) = (p_connector_id, p_site_id, p_project_ref, p_connector_revision)
      AND c.toolkit_slug = 'supabase' AND c.enabled AND c.verified_at IS NOT NULL AND c.provider_status = 'ACTIVE'
      AND NOT c.revocation_pending AND NOT c.revocation_dispatched AND p.status = 'active'
      AND policy.catalog_reads AND 'assistant' = ANY(policy.allowed_hosts)
      AND (policy.tool_access_mode = 'all' OR 'SUPABASE_RUN_READ_ONLY_QUERY' = ANY(policy.allowed_tools));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connector binding is no longer authorized' USING ERRCODE = 'P0C02';
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.connector_external_analytics_dataset(uuid,uuid,text,integer)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.connector_external_analytics_dataset(uuid,uuid,text,integer) TO service_role;

COMMIT;