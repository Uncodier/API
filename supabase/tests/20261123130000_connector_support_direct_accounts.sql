-- Disposable fixture only: this account has independently verified resource and
-- credential bindings, no member grant and no Ask enrollment.
SET ROLE service_role;
SELECT public.connector_support_agent_account(:'site',:'agent',:'account',NULL)->0 AS listed \gset
SELECT public.connector_support_agent_account(:'site',:'agent',:'account','CRM_LIST_DEALS')->0 AS admitted \gset
SELECT jsonb_build_object('same',:'listed'::jsonb=:'admitted'::jsonb,'account',:'admitted'::jsonb);