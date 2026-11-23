BEGIN;
-- Account discovery requests have no slug. Never require an executable member of the selection to browse it.
-- Exact action checks (describe, dispatch and receipt binding) retain the existing authority rules.
CREATE OR REPLACE FUNCTION connector_result_private.account_tool_allowed(o connector_result_private.ordinary_accounts,slug text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN slug IS NULL THEN o.tool_access_mode='all' OR (o.tool_access_mode='selected' AND cardinality(o.allowed_tools)>0)
    WHEN NOT (o.wire ? 'auth_scheme') THEN connector_result_private.ordinary_tool_allowed(o.toolkit_slug,o.tool_access_mode,o.allowed_tools,slug)
    ELSE connector_result_private.customer_slug(o.toolkit_slug,slug,o.wire->>'bound_project_ref') AND
      (o.tool_access_mode='all' OR (o.tool_access_mode='selected' AND slug=ANY(o.allowed_tools))) END;
$$;
COMMIT;
