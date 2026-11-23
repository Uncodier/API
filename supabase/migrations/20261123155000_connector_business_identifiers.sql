BEGIN;
-- Business identifiers are not execution capabilities. The remaining operation is still checked.
CREATE OR REPLACE FUNCTION connector_result_private.customer_slug(kit text,slug text,project_ref text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT starts_with(slug,upper(replace(kit,'-','_'))||'_') AND length(slug)<=150 AND NOT starts_with(slug,'COMPOSIO_')
    AND slug COLLATE "C" ~ '^[A-Z0-9]+(_[A-Z0-9]+)+$'
    AND (project_ref IS NULL OR substr(slug,length(kit)+2) COLLATE "C" ~ '^(GET|FETCH|RETRIEVE)_PROJECT(_(METADATA|DETAILS|STATUS))?$')
    AND regexp_replace(substr(slug,length(kit)+1),'_(PROMOTION|POSTAL|ZIP|CURRENCY|COUNTRY|LANGUAGE|PRODUCT)_CODE(_|$)','_IDENTIFIER\2','g') COLLATE "C"
      !~ '_(SQL|QUERY|ADMIN|IAM|RBAC|ROLE|ROLES|PERMISSION|PERMISSIONS|CREDENTIALS?|OAUTH|TOKENS?|SECRETS?|PROXY|EXECUTE|CODE|SHELL|SCRIPT|DEPLOY|WEBHOOK|WORKFLOW|RPC|RAW|GRAPHQL)(_|$)';
$$;

COMMIT;
