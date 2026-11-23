-- Disposable fixture only. No enrollment, synthetic claim, or caller-chosen proof.
SET SESSION AUTHORIZATION direct_fixture_gateway;
SET ROLE service_role;
SELECT public.connector_direct_accounts(:'site',:'member',:'instance',:'agent',:'account','CRM_LIST_DEALS')->0 AS discovered \gset
SELECT (:'discovered'::jsonb->'connector'->>'revision')::integer AS cr,
  (:'discovered'::jsonb->'policy'->>'revision')::integer AS pr,
  (:'discovered'::jsonb->>'direct_revision')::integer AS dr,
  (:'discovered'::jsonb->'provider'->>'credential_revision') AS credential,
  (:'discovered'::jsonb->>'attestation_id')::uuid AS proof \gset
INSERT INTO public.instance_logs(id,instance_id,site_id,user_id,agent_id,log_type,trusted_user_action,details)
VALUES (:'action',:'instance',:'site',:'member',:'agent','user_action',true,:'details'::jsonb);
SELECT public.claim_connector_direct_dispatch(:'site',:'member',:'instance',:'agent',:'account',:'action','CRM_LIST_DEALS','v1',
  repeat('a',64),:'proof',:cr,:pr,:dr,:'credential',repeat('b',64)) AS reservation \gset
SELECT public.store_connector_direct_result(:'site',:'member',:'instance',:'agent',:'account',:'action','CRM_LIST_DEALS','v1',
  repeat('a',64),:'proof',:cr,:pr,:dr,:'credential',:'reservation','{"title":"Fixture","note":"","columns":["N"],"rows":[["1"]]}') AS result \gset
SELECT jsonb_build_object('result',:'result','reservation',:'reservation');