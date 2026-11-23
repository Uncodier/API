BEGIN;
-- Directory read labels do not grant authority or override the account. Keep capability checks for the rest of the slug.
CREATE OR REPLACE FUNCTION connector_result_private.customer_slug(kit text,slug text,project_ref text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT starts_with(slug,upper(replace(kit,'-','_'))||'_') AND length(slug)<=150 AND NOT starts_with(slug,'COMPOSIO_')
    AND slug COLLATE "C" ~ '^[A-Z0-9]+(_[A-Z0-9]+)+$'
    AND (project_ref IS NULL OR substr(slug,length(kit)+2) COLLATE "C" ~ '^(GET|FETCH|RETRIEVE)_PROJECT(_(METADATA|DETAILS|STATUS))?$')
    AND substr(slug,length(kit)+1) COLLATE "C" !~ '_(RUN|CALL|EVALUATE|COMPILE|RAW|DATABASE)(_[A-Z0-9]+)*_QUERY(_|$)'
    AND regexp_replace(CASE WHEN substr(slug,length(kit)+2) COLLATE "C" ~ '^(GET|LIST|FIND|SEARCH|FETCH|RETRIEVE)_'
      THEN regexp_replace(substr(slug,length(kit)+1),'_(ADMIN|IAM|RBAC|ROLES?)(?=_|$)','_RESOURCE','g')
      ELSE substr(slug,length(kit)+1) END,'_(PROMOTION|POSTAL|ZIP|CURRENCY|COUNTRY|LANGUAGE|PRODUCT)_CODE(_|$)','_IDENTIFIER\2','g') COLLATE "C"
      !~ '_(SQL|ADMIN|IAM|RBAC|ROLE|ROLES|PERMISSION|PERMISSIONS|CREDENTIALS?|OAUTH|TOKENS?|SECRETS?|PROXY|EXECUTE|CODE|SHELL|SCRIPT|DEPLOY|WEBHOOK|WORKFLOW|RPC|RAW|GRAPHQL)(_|$)';
$$;

COMMIT;
