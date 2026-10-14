-- Review-only forward migration. Never run against a live database from tests.
-- Configuration is encrypted by the Node host; SQL never receives plaintext secrets.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.harness_sessions ADD CONSTRAINT harness_sessions_id_site_key UNIQUE (id, site_id);

CREATE TABLE public.harness_host_state (
  session_id uuid PRIMARY KEY,
  site_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740990),
  ciphertext text NOT NULL CHECK (octet_length(ciphertext) <= 262144
    AND ciphertext ~ '^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]+={0,2}$'),
  FOREIGN KEY (session_id, site_id) REFERENCES public.harness_sessions(id, site_id) ON DELETE CASCADE
);

CREATE TABLE public.harness_artifacts (
  session_id uuid NOT NULL,
  site_id uuid NOT NULL,
  id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'),
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1000),
  -- This is complete REDACTED output only. Host configuration is never an artifact.
  content text NOT NULL CHECK (octet_length(content) <= 1048576),
  bytes integer GENERATED ALWAYS AS (octet_length(content)) STORED,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id, site_id) REFERENCES public.harness_sessions(id, site_id) ON DELETE CASCADE
);

CREATE TABLE public.harness_artifact_reservations (
  session_id uuid NOT NULL,
  site_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1000),
  bytes integer NOT NULL CHECK (bytes BETWEEN 0 AND 1048576),
  PRIMARY KEY (session_id, operation_id),
  FOREIGN KEY (session_id, site_id) REFERENCES public.harness_sessions(id, site_id) ON DELETE CASCADE
);

ALTER TABLE public.harness_host_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.harness_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.harness_artifact_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.harness_host_state, public.harness_artifacts, public.harness_artifact_reservations
  FROM PUBLIC, anon, authenticated, service_role;

-- All readers/writers lock the parent first. Lease time is evaluated AFTER lock
-- acquisition, not at transaction start. This also serializes quota checks and CAS.
CREATE FUNCTION public.lock_harness_host_owner(p_id uuid, p_site_id uuid, p_owner text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r public.harness_sessions%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_site_id IS NULL OR p_owner IS NULL OR length(btrim(p_owner)) = 0 OR length(p_owner) > 200
  THEN RAISE EXCEPTION 'Invalid harness host scope' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM public.harness_sessions WHERE id=p_id AND site_id=p_site_id FOR UPDATE;
  IF NOT FOUND OR r.lease_owner IS DISTINCT FROM p_owner OR r.lease_expires_at IS NULL
    OR r.lease_expires_at <= clock_timestamp() OR r.snapshot->>'status' IS DISTINCT FROM 'running'
  THEN RAISE EXCEPTION 'Harness host ownership conflict' USING ERRCODE='P0002'; END IF;
END;
$$;

CREATE FUNCTION public.load_harness_host_state(p_id uuid, p_site_id uuid, p_owner text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.lock_harness_host_owner(p_id,p_site_id,p_owner);
  SELECT jsonb_build_object('version',version,'ciphertext',ciphertext) INTO result
    FROM public.harness_host_state WHERE session_id=p_id AND site_id=p_site_id;
  RETURN result;
END;
$$;

CREATE FUNCTION public.save_harness_host_state(p_id uuid, p_site_id uuid, p_owner text, p_expected_version bigint, p_ciphertext text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE previous bigint;
BEGIN
  PERFORM public.lock_harness_host_owner(p_id,p_site_id,p_owner);
  IF p_expected_version IS NULL OR p_expected_version NOT BETWEEN 0 AND 9007199254740989
    OR p_ciphertext IS NULL OR octet_length(p_ciphertext) > 262144
    OR p_ciphertext !~ '^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]+={0,2}$'
  THEN RAISE EXCEPTION 'Invalid harness encrypted state' USING ERRCODE='22023'; END IF;
  SELECT version INTO previous FROM public.harness_host_state WHERE session_id=p_id AND site_id=p_site_id;
  IF coalesce(previous,0) <> p_expected_version
  THEN RAISE EXCEPTION 'Harness host version conflict' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.harness_host_state(session_id,site_id,version,ciphertext)
    VALUES(p_id,p_site_id,p_expected_version+1,p_ciphertext)
    ON CONFLICT (session_id) DO UPDATE SET version=EXCLUDED.version,ciphertext=EXCLUDED.ciphertext;
  RETURN p_expected_version+1;
END;
$$;

CREATE FUNCTION public.reserve_harness_artifact(p_id uuid, p_site_id uuid, p_owner text, p_operation_id text, p_bytes integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE used bigint; reserved bigint; previous integer;
BEGIN
  PERFORM public.lock_harness_host_owner(p_id,p_site_id,p_owner);
  IF p_operation_id IS NULL OR length(p_operation_id) NOT BETWEEN 1 AND 1000
    OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 1048576
  THEN RAISE EXCEPTION 'Invalid harness artifact reservation' USING ERRCODE='22023'; END IF;
  SELECT bytes INTO previous FROM public.harness_artifact_reservations WHERE session_id=p_id AND operation_id=p_operation_id;
  -- Repeated preflights are idempotent. A consumed reservation must be reacquired
  -- before any new execution; never promise capacity already occupied by output.
  IF FOUND AND previous >= p_bytes THEN RETURN true; END IF;
  SELECT coalesce(sum(bytes),0) INTO used FROM public.harness_artifacts WHERE session_id=p_id;
  SELECT coalesce(sum(bytes),0) INTO reserved FROM public.harness_artifact_reservations WHERE session_id=p_id;
  IF used+reserved-coalesce(previous,0)+p_bytes > 16777216
  THEN RAISE EXCEPTION 'Harness artifact quota exceeded before execution' USING ERRCODE='54000'; END IF;
  INSERT INTO public.harness_artifact_reservations(session_id,site_id,operation_id,bytes) VALUES(p_id,p_site_id,p_operation_id,p_bytes)
    ON CONFLICT (session_id,operation_id) DO UPDATE SET bytes=EXCLUDED.bytes;
  RETURN true;
END;
$$;

CREATE FUNCTION public.put_harness_artifact(p_id uuid, p_site_id uuid, p_owner text, p_operation_id text, p_artifact_id text, p_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE used bigint; reserved bigint; own_reservation integer; expected_id text; char_count integer;
BEGIN
  PERFORM public.lock_harness_host_owner(p_id,p_site_id,p_owner);
  IF p_operation_id IS NULL OR length(p_operation_id) NOT BETWEEN 1 AND 1000 OR p_text IS NULL OR p_artifact_id IS NULL
  THEN RAISE EXCEPTION 'Invalid harness artifact' USING ERRCODE='22023'; END IF;
  IF octet_length(p_text)>1048576
  THEN RAISE EXCEPTION 'Harness artifact quota exceeded' USING ERRCODE='54000'; END IF;
  expected_id := encode(sha256(convert_to(p_id::text,'UTF8') || decode('00','hex') || convert_to(p_operation_id,'UTF8') || decode('00','hex') || convert_to(p_text,'UTF8')),'hex');
  IF p_artifact_id IS DISTINCT FROM expected_id
  THEN RAISE EXCEPTION 'Invalid harness artifact identity' USING ERRCODE='22023'; END IF;
  -- Count UTF-16 code units for the host contract, including astral Unicode pairs.
  char_count := length(p_text)+length(regexp_replace(p_text,U&'[^\+010000-\+10FFFF]','','g'));
  IF EXISTS (SELECT 1 FROM public.harness_artifacts WHERE session_id=p_id AND id=p_artifact_id) THEN
    UPDATE public.harness_artifact_reservations SET bytes=0 WHERE session_id=p_id AND operation_id=p_operation_id;
    RETURN jsonb_build_object('id',p_artifact_id,'bytes',octet_length(p_text),'chars',char_count);
  END IF;
  SELECT coalesce(sum(bytes),0) INTO used FROM public.harness_artifacts WHERE session_id=p_id;
  SELECT coalesce(sum(bytes),0) INTO reserved FROM public.harness_artifact_reservations WHERE session_id=p_id;
  SELECT bytes INTO own_reservation FROM public.harness_artifact_reservations WHERE session_id=p_id AND operation_id=p_operation_id;
  IF used+reserved-coalesce(own_reservation,0)+octet_length(p_text)>16777216
  THEN RAISE EXCEPTION 'Harness artifact quota exceeded' USING ERRCODE='54000'; END IF;
  INSERT INTO public.harness_artifacts(session_id,site_id,id,operation_id,content) VALUES(p_id,p_site_id,p_artifact_id,p_operation_id,p_text);
  INSERT INTO public.harness_artifact_reservations(session_id,site_id,operation_id,bytes) VALUES(p_id,p_site_id,p_operation_id,0)
    ON CONFLICT (session_id,operation_id) DO UPDATE SET bytes=0;
  RETURN jsonb_build_object('id',p_artifact_id,'bytes',octet_length(p_text),'chars',char_count);
END;
$$;

CREATE FUNCTION public.read_harness_artifact(p_id uuid, p_site_id uuid, p_owner text, p_artifact_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.lock_harness_host_owner(p_id,p_site_id,p_owner);
  IF p_artifact_id IS NULL OR p_artifact_id !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'Invalid harness artifact identity' USING ERRCODE='22023'; END IF;
  SELECT jsonb_build_object('text',content) INTO result FROM public.harness_artifacts
    WHERE session_id=p_id AND site_id=p_site_id AND id=p_artifact_id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_harness_host_owner(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_harness_host_state(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_harness_host_state(uuid,uuid,text,bigint,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_harness_artifact(uuid,uuid,text,text,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.put_harness_artifact(uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_harness_artifact(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_harness_host_state(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_harness_host_state(uuid,uuid,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_harness_artifact(uuid,uuid,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.put_harness_artifact(uuid,uuid,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_harness_artifact(uuid,uuid,text,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;