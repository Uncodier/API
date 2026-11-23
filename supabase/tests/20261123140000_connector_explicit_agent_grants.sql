-- Disposable fixture: a verified workspace CRM account and a private turn.
-- Compare two distinct principals on the exact same account/tool/proof.
SET ROLE service_role;
SELECT jsonb_build_object(
  'support_list', jsonb_array_length(public.connector_support_agent_account(:'site',:'agent',:'account',NULL)),
  'support_use', jsonb_array_length(public.connector_support_agent_account(:'site',:'agent',:'account','CRM_LIST_DEALS')),
  'instance_member', jsonb_array_length(public.connector_direct_accounts(:'site',:'member',:'instance',:'agent',:'account','CRM_LIST_DEALS'))
);