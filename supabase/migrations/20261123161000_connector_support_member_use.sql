BEGIN;
-- A private thread cannot borrow the assigned agent grant on behalf of a view-only member.
CREATE OR REPLACE FUNCTION public.connector_claim_support_dispatch(
  p_site_id uuid,p_agent_id uuid,p_user_id uuid,p_conversation_id uuid,p_connector_id uuid,p_slug text,p_turn_digest text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  INSERT INTO connector_result_private.support_dispatch_claims(site_id,conversation_id,turn_digest,connector_id,slug)
    SELECT p_site_id,p_conversation_id,p_turn_digest,p_connector_id,p_slug FROM public.conversations t
    WHERE (t.id,t.site_id,t.agent_id,t.user_id)=(p_conversation_id,p_site_id,p_agent_id,p_user_id)
      AND p_turn_digest COLLATE "C" ~ '^[0-9a-f]{64}$' AND p_connector_id IS NOT NULL AND p_slug IS NOT NULL
      AND EXISTS (SELECT FROM connector_result_private.instance_policy_accounts(p_site_id,p_user_id,p_connector_id,p_slug))
      AND jsonb_array_length(public.connector_support_agent_account_v2(p_site_id,p_agent_id,p_connector_id,p_slug))=1
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;
COMMIT;
