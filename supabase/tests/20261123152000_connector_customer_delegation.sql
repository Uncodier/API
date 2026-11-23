-- Local fixture: no attestation issuance and no provider IO. Admission and
-- receipts use the same actor-specific v2 API as the old OAuth path.
BEGIN;
SET LOCAL ROLE service_role;
SELECT jsonb_build_object('instance',public.connector_direct_accounts_v2(:'site',:'member',:'instance',:'agent',:'account',:'tool'),
  'support',public.connector_support_agent_account_v2(:'site',:'agent',:'account',:'tool'));
ROLLBACK;
