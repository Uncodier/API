BEGIN;
SET LOCAL lock_timeout = '5s';

-- Catalog action names are not capability boundaries. Both legacy and delegated
-- accounts use the saved tool policy; account/actor/host checks remain in callers.
-- CREATE OR REPLACE preserves the existing owner and private EXECUTE permissions.
CREATE OR REPLACE FUNCTION connector_result_private.account_tool_allowed(o connector_result_private.ordinary_accounts,slug text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN slug IS NULL THEN o.tool_access_mode='all' OR (o.tool_access_mode='selected' AND cardinality(o.allowed_tools)>0)
    ELSE starts_with(slug,upper(replace(o.toolkit_slug,'-','_'))||'_') AND length(slug)<=150
      AND NOT starts_with(slug,'COMPOSIO_') AND slug COLLATE "C" ~ '^[A-Z0-9]+(_[A-Z0-9]+)+$'
      AND (o.tool_access_mode='all' OR (o.tool_access_mode='selected' AND slug=ANY(o.allowed_tools))) END;
$$;

DROP FUNCTION connector_result_private.customer_slug(text,text,text);
COMMIT;