-- Disposable fixture only; the supplied manager, instance, agent and exact
-- completed account are fixture identities. This does not create authority.
BEGIN;
SET LOCAL ROLE service_role;
SELECT jsonb_build_object('instance',public.connector_direct_accounts_v2(:'site',:'member',:'instance',:'agent',:'account','GMAIL_FETCH_EMAILS'),
  'support',public.connector_support_agent_account_v2(:'site',:'agent',:'account','GMAIL_FETCH_EMAILS'),
  'manager',public.connector_instance_policy_status(:'site',:'manager',:'account'));
ROLLBACK;
