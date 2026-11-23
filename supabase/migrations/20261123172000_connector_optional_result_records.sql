BEGIN;
SET LOCAL lock_timeout = '5s';

-- Recheck release against the original dispatch claim without storing a report.
-- Only the claim ID is writable; the checked identity comes from the journal.
CREATE TABLE connector_direct_rpc.result_gate (
  claim_id uuid, owner_id uuid, site_id uuid, instance_id uuid, result_id uuid, CHECK (false)
);
ALTER TABLE connector_direct_rpc.result_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON connector_direct_rpc.result_gate FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT INSERT (claim_id) ON connector_direct_rpc.result_gate TO service_role;

CREATE FUNCTION connector_result_private.check_result_release() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c connector_result_private.direct_claims;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  SELECT j.* INTO c FROM connector_result_private.direct_claims j WHERE j.id=NEW.claim_id;
  IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
  PERFORM connector_result_private.lock_direct_write(c);
  PERFORM connector_result_private.check_dispatch_authority(c);
  IF c.claimed_at<=clock_timestamp()-interval '1 hour' THEN RAISE insufficient_privilege; END IF;
  NEW.owner_id:=c.owner_id; NEW.site_id:=c.site_id; NEW.instance_id:=c.instance_id; NEW.result_id:=c.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION connector_result_private.check_result_release() FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER a_check BEFORE INSERT ON connector_direct_rpc.result_gate FOR EACH ROW
  EXECUTE FUNCTION connector_result_private.check_result_release();
-- Reuse the authenticated parent RLS check. It acknowledges the claim and
-- drops the gate row; neither the report store nor its advisory lock is used.
CREATE TRIGGER z_authorize BEFORE INSERT ON connector_direct_rpc.result_gate FOR EACH ROW
  EXECUTE FUNCTION connector_result_private.authorize_direct_parent();

CREATE FUNCTION public.confirm_connector_result_release(p_claim_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '3s' AS $$
DECLARE confirmed uuid; previous_result text:=current_setting('connector_direct.result_id',true);
BEGIN
  IF current_user<>'service_role' OR current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE insufficient_privilege; END IF;
  PERFORM set_config('connector_direct.result_id','',true);
  INSERT INTO connector_direct_rpc.result_gate(claim_id) VALUES (p_claim_id);
  confirmed:=nullif(current_setting('connector_direct.result_id'),'')::uuid;
  PERFORM set_config('connector_direct.result_id',coalesce(previous_result,''),true);
  IF confirmed IS NULL OR confirmed IS DISTINCT FROM p_claim_id THEN RAISE insufficient_privilege; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.confirm_connector_result_release(uuid) FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
GRANT EXECUTE ON FUNCTION public.confirm_connector_result_release(uuid) TO service_role;

COMMIT;