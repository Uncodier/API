-- Disposable fixture only, after migration. Exercise the unprivileged surface
-- and the write gate independently: merely revoking RPC EXECUTE is not enough.
BEGIN;
DO $$
DECLARE p regprocedure; role_name name;
BEGIN
  FOREACH p IN ARRAY ARRAY[
    'public.connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
    'public.connector_instance_report_sources(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text)'::regprocedure,
    'public.claim_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text)'::regprocedure,
    'public.store_connector_instance_scoped_read(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,uuid,jsonb)'::regprocedure,
    'connector_direct_rpc.scoped_write(uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,text,text,text,text,text,text,text,uuid,jsonb)'::regprocedure
  ] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','connector_result_reader'] LOOP
      IF has_function_privilege(role_name,p,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected % on %', role_name,p; END IF;
    END LOOP;
  END LOOP;
END $$;

-- Simulate a stale service writer that still has column INSERT grants. Restore
-- nothing manually; all synthetic grants roll back in this disposable session.
GRANT INSERT (scoped_status,data_scope,source_name,project_ref) ON connector_direct_rpc.write_gate TO service_role;
SET LOCAL ROLE service_role;
DO $$
DECLARE stmt text;
BEGIN
  FOREACH stmt IN ARRAY ARRAY[
    'INSERT INTO connector_direct_rpc.write_gate(scoped_status) VALUES (true)',
    'INSERT INTO connector_direct_rpc.write_gate(data_scope) VALUES (''workspace'')',
    'INSERT INTO connector_direct_rpc.write_gate(attestation_id,source_name) VALUES (gen_random_uuid(),''paid_sales'')',
    'INSERT INTO connector_direct_rpc.write_gate(project_ref,claim_id) VALUES (repeat(''a'',20),gen_random_uuid())',
    'INSERT INTO connector_direct_rpc.write_gate(claim_id) VALUES (gen_random_uuid())'
  ] LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'Retired gate accepted a request';
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM <> 'Instance scoped report retired' THEN RAISE; END IF;
    END;
  END LOOP;
END $$;
ROLLBACK;