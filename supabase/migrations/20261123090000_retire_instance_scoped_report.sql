BEGIN;
SET LOCAL lock_timeout = '3s';

-- Fence the private gate before a_apply (which can write or return NULL before
-- table constraints are checked). Do not reinterpret a scoped payload as a
-- provider dispatch. Generic writes always carry their original attestation.
CREATE FUNCTION connector_result_private.reject_retired_scoped_write() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Instance scoped report retired' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION connector_result_private.reject_retired_scoped_write()
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
CREATE TRIGGER a0_reject_retired_scoped BEFORE INSERT ON connector_direct_rpc.write_gate
  FOR EACH ROW WHEN (NEW.attestation_id IS NULL OR NEW.scoped_status IS NOT NULL
    OR NEW.data_scope IS NOT NULL OR NEW.source_name IS NOT NULL OR NEW.project_ref IS NOT NULL)
  EXECUTE FUNCTION connector_result_private.reject_retired_scoped_write();

-- Enforce at the journal too, including direct SQL writers. Do not validate
-- against historical scoped rows: keep them readable. New rows and updates
-- (including consumption of an outstanding scoped claim) are checked now.
ALTER TABLE connector_result_private.direct_claims ADD CONSTRAINT direct_claim_requires_attestation
  CHECK (attestation_id IS NOT NULL) NOT VALID;

REVOKE INSERT (scoped_status, data_scope, source_name, project_ref) ON connector_direct_rpc.write_gate
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;
REVOKE ALL ON FUNCTION
  public.connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid),
  public.connector_instance_report_sources(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text),
  public.claim_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text),
  public.store_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,uuid,jsonb),
  connector_direct_rpc.scoped_write(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role, connector_result_reader;

-- AFTER INSERT trigger on a hot customer table: replacing the function avoids
-- table DDL there. Historical heads do not confer receipt read authority. Do
-- not touch the separate generic head, submission, or provenance triggers.
CREATE OR REPLACE FUNCTION connector_result_private.advance_scoped_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END $$;
COMMIT;