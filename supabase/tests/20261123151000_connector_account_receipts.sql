-- Disposable database only. Resolve real authority on a newly completed hosted
-- account. No resource attestation is installed; ordinary account provenance
-- must suffice all the way through the authenticated owner's receipt read.
SET SESSION AUTHORIZATION direct_fixture_gateway;
SET ROLE service_role;
SELECT public.connector_direct_accounts_v2(:'site',:'member',:'instance',:'agent',:'account',:'tool')->0 AS discovered \gset
SELECT (:'discovered'::jsonb->'connector'->>'revision')::integer AS cr,
  (:'discovered'::jsonb->'policy'->>'revision')::integer AS pr,
  (:'discovered'::jsonb->>'direct_revision')::integer AS dr,
  (:'discovered'::jsonb->'provider'->>'credential_revision') AS credential,
  (:'discovered'::jsonb->>'authorization_id')::uuid AS authorization \gset
INSERT INTO public.instance_logs(id,instance_id,site_id,user_id,agent_id,log_type,trusted_user_action,details)
VALUES (:'action',:'instance',:'site',:'member',:'agent','user_action',true,:'details'::jsonb);
SELECT public.claim_connector_account_dispatch(:'site',:'member',:'instance',:'agent',:'account',:'action',:'tool','v1',
  repeat('a',64),:'authorization',:cr,:pr,:dr,:'credential',repeat('b',64)) AS reservation \gset
SELECT public.store_connector_account_result(:'site',:'member',:'instance',:'agent',:'account',:'action',:'tool','v1',
  repeat('a',64),:'authorization',:cr,:pr,:dr,:'credential',:'reservation',:'report'::jsonb) AS result \gset
SET ROLE authenticated;
SELECT set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',:'member','is_anonymous',false)::text,false) AS jwt \gset
SELECT jsonb_build_object('result',:'result','reservation',:'reservation','read',public.read_connector_private_result(:'result'),
  'authorization',:'authorization','cr',:cr,'pr',:pr,'dr',:dr,'credential',:'credential');