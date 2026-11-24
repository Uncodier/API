BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.assistant_lead_bulk_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  action_id uuid NOT NULL UNIQUE,
  operation text NOT NULL CHECK (operation IN ('create','assign_to_me','assign_to_member','change_status','delete')),
  settings jsonb NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','review','queued','completed','failed','cancelled','expired')),
  total bigint NOT NULL DEFAULT 0,
  affected bigint NOT NULL DEFAULT 0,
  batch_count bigint NOT NULL DEFAULT 0,
  next_batch bigint NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_action_id uuid,
  sealed_at timestamptz,
  error_code text
);
CREATE INDEX assistant_lead_bulk_jobs_due ON public.assistant_lead_bulk_jobs (due_at, id) WHERE state = 'queued';
CREATE INDEX assistant_lead_bulk_jobs_expiry ON public.assistant_lead_bulk_jobs (expires_at, id) WHERE state IN ('draft','review');
CREATE INDEX assistant_lead_bulk_jobs_retention ON public.assistant_lead_bulk_jobs (updated_at, id)
  WHERE state IN ('completed','failed','cancelled','expired');

CREATE TABLE public.assistant_lead_bulk_job_batches (
  job_id uuid NOT NULL REFERENCES public.assistant_lead_bulk_jobs(id),
  batch_number bigint NOT NULL,
  request_hash bytea NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 50),
  PRIMARY KEY (job_id,batch_number)
);
CREATE TABLE public.assistant_lead_bulk_job_items (
  job_id uuid NOT NULL,
  batch_number bigint NOT NULL,
  position integer NOT NULL,
  lead_id uuid,
  revision bytea,
  draft jsonb,
  PRIMARY KEY (job_id,batch_number,position),
  UNIQUE (job_id,lead_id),
  FOREIGN KEY (job_id,batch_number) REFERENCES public.assistant_lead_bulk_job_batches(job_id,batch_number) ON DELETE CASCADE
);
ALTER TABLE public.assistant_lead_bulk_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_lead_bulk_job_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_lead_bulk_job_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_lead_bulk_jobs, public.assistant_lead_bulk_job_batches,
  public.assistant_lead_bulk_job_items FROM PUBLIC, anon, authenticated, service_role;

-- Same live permissions as the interactive RPC. NULL means not authorized;
-- otherwise the result indicates whether the lead selection is restricted.
CREATE FUNCTION public.assistant_lead_job_scope(p_site uuid, p_user uuid, p_instance uuid, p_operation text, p_assignee uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_owner boolean;
  v_site_owner uuid;
  v_member public.site_members%ROWTYPE;
  v_admin boolean;
BEGIN
  SELECT user_id INTO v_site_owner FROM public.sites WHERE id = p_site AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.remote_instances WHERE id = p_instance AND site_id = p_site AND is_archived IS NOT TRUE FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.site_members WHERE user_id = p_user OR (user_id = p_assignee AND site_id = p_site)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.site_ownership WHERE site_id = p_site AND user_id IN (p_user,p_assignee) ORDER BY user_id FOR SHARE;
  IF public.site_user_has_effective_access(p_site,p_user) IS NOT TRUE THEN RETURN NULL; END IF;
  v_owner := v_site_owner IS NOT DISTINCT FROM p_user OR EXISTS (
    SELECT 1 FROM public.site_ownership WHERE site_id = p_site AND user_id = p_user);
  SELECT * INTO v_member FROM public.site_members WHERE site_id = p_site AND user_id = p_user AND status = 'active';
  v_admin := v_owner OR coalesce(v_member.role IN ('owner','admin'),false);
  IF (NOT v_admin AND (v_member.role IS DISTINCT FROM 'collaborator' OR 'leads' = ANY(coalesce(v_member.blocked_screens,'{}'))))
    OR (p_operation = 'delete' AND NOT v_admin)
    OR EXISTS (
      SELECT 1 FROM public.site_members m JOIN public.site_member_location_restrictions r
        ON r.site_id = m.site_id AND r.site_member_id = m.id JOIN public.sites s ON s.id = m.site_id
      WHERE m.user_id = p_user AND (public.site_user_has_effective_access(s.id,p_user) IS TRUE AND (
        s.user_id = p_user OR EXISTS (SELECT 1 FROM public.site_ownership o WHERE o.site_id = s.id AND o.user_id = p_user)
        OR (m.status = 'active' AND m.role IN ('owner','admin') AND public.site_member_has_effective_license(m.id) IS TRUE))) IS NOT TRUE)
  THEN RETURN NULL; END IF;
  RETURN NOT v_owner AND v_member.restrict_to_assigned_only IS DISTINCT FROM false;
END;
$$;

CREATE FUNCTION public.assistant_lead_job_receipt(j public.assistant_lead_bulk_jobs)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('success',true,'job_id',j.id,'operation',j.operation,'state',j.state,
    'total_count',j.total,'affected_count',j.affected,'remaining_count',j.total-j.affected,
    'batch_count',j.batch_count,'completed_batches',j.next_batch-1,'error_code',j.error_code,
    'failed_batch',CASE WHEN j.state = 'failed' THEN j.next_batch END)
    || j.settings
    || CASE WHEN j.state = 'review' THEN jsonb_build_object('expires_at',j.expires_at)
      || CASE WHEN j.operation = 'delete' THEN jsonb_build_object('confirmation_message','CONFIRM DELETE LEAD JOB ' || j.id) ELSE '{}'::jsonb END
      ELSE '{}'::jsonb END;
$$;

CREATE FUNCTION public.assistant_lead_job_command(p_site uuid,p_user uuid,p_instance uuid,p_action uuid,
  p_command text,p_job uuid,p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '5s' AS $$
DECLARE
  j public.assistant_lead_bulk_jobs;
  v_action public.instance_logs%ROWTYPE;
  v_operation text;
  v_assignee uuid;
  v_settings jsonb := '{}'::jsonb;
  v_restricted boolean;
  v_number bigint;
  v_count integer;
  v_batch jsonb;
  v_hash bytea;
  v_ids uuid[];
  v_missing uuid[];
  v_duplicates uuid[];
  v_denied constant jsonb := '{"success":false,"code":"access_denied"}';
  v_invalid constant jsonb := '{"success":false,"code":"invalid_job_state"}';
BEGIN
  SELECT * INTO v_action FROM public.instance_logs WHERE id=p_action AND instance_id=p_instance AND site_id=p_site
    AND user_id=p_user AND log_type='user_action' AND trusted_user_action IS TRUE AND details->>'status'='running'
    AND details->'lead_bulk_user_session'='true'::jsonb FOR SHARE;
  IF NOT FOUND THEN RETURN v_denied; END IF;

  IF p_command = 'job_open' THEN
    v_operation := p_data->>'operation';
    IF v_operation IS NULL OR v_operation NOT IN ('create','assign_to_me','assign_to_member','change_status','delete') THEN
      RETURN v_invalid;
    END IF;
    IF v_operation = 'assign_to_member' THEN
      v_assignee := (p_data->>'assignee_id')::uuid;
      v_settings := jsonb_build_object('assignee_id',v_assignee);
    ELSIF v_operation = 'change_status' THEN
      IF NOT coalesce(p_data->>'status' IN ('new','contacted','qualified','converted','lost','cold','not_qualified'),false) THEN
        RETURN v_invalid;
      END IF;
      v_settings := jsonb_build_object('status',p_data->>'status');
    END IF;
    IF public.assistant_lead_job_scope(p_site,p_user,p_instance,v_operation,v_assignee) IS NULL THEN RETURN v_denied; END IF;
    IF v_operation = 'assign_to_member' AND public.site_user_has_effective_access(p_site,v_assignee) IS NOT TRUE THEN
      RETURN '{"success":false,"code":"invalid_assignee"}';
    END IF;
    INSERT INTO public.assistant_lead_bulk_jobs (site_id,user_id,instance_id,action_id,operation,settings)
      VALUES (p_site,p_user,p_instance,p_action,v_operation,v_settings) ON CONFLICT (action_id) DO NOTHING RETURNING * INTO j;
    IF NOT FOUND THEN
      SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE action_id=p_action AND site_id=p_site AND user_id=p_user AND instance_id=p_instance;
      IF NOT FOUND OR j.operation <> v_operation OR j.settings <> v_settings THEN RETURN v_invalid; END IF;
    END IF;
    RETURN public.assistant_lead_job_receipt(j);
  END IF;

  -- Read-only polling does not compete with the worker's row lock.
  IF p_command = 'job_status' THEN
    SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE id=p_job AND site_id=p_site AND user_id=p_user AND instance_id=p_instance;
  ELSE
    SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE id=p_job AND site_id=p_site AND user_id=p_user AND instance_id=p_instance FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN v_denied; END IF;
  v_assignee := (j.settings->>'assignee_id')::uuid;
  v_restricted := public.assistant_lead_job_scope(p_site,p_user,p_instance,
    CASE WHEN p_command IN ('job_status','job_cancel') THEN 'create' ELSE j.operation END,v_assignee);
  IF v_restricted IS NULL THEN RETURN v_denied; END IF;
  IF p_command = 'job_status' THEN RETURN public.assistant_lead_job_receipt(j); END IF;
  IF p_command = 'job_cancel' THEN
    IF j.state IN ('draft','review','queued') THEN
      UPDATE public.assistant_lead_bulk_jobs SET state='cancelled', updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
    END IF;
    RETURN public.assistant_lead_job_receipt(j);
  END IF;
  IF j.state IN ('draft','review') AND j.expires_at <= clock_timestamp() THEN RETURN v_invalid; END IF;

  IF p_command = 'job_add' THEN
    v_number := (p_data->>'batch_number')::bigint;
    v_batch := p_data->CASE WHEN j.operation = 'create' THEN 'leads' ELSE 'lead_ids' END;
    IF jsonb_typeof(v_batch) IS DISTINCT FROM 'array' OR v_number IS NULL OR v_number < 1 THEN RETURN v_invalid; END IF;
    v_count := jsonb_array_length(v_batch);
    IF v_count NOT BETWEEN 1 AND 50 THEN RETURN v_invalid; END IF;
    IF j.operation <> 'create' THEN
      SELECT array_agg(value::uuid ORDER BY value::uuid) INTO v_ids FROM jsonb_array_elements_text(v_batch);
      IF (SELECT count(DISTINCT id) FROM unnest(v_ids) AS ids(id)) <> v_count THEN RETURN v_invalid; END IF;
      v_batch := to_jsonb(v_ids);
    END IF;
    v_hash := sha256(convert_to(v_batch::text,'UTF8'));
    IF v_number <= j.batch_count AND EXISTS (SELECT 1 FROM public.assistant_lead_bulk_job_batches
      WHERE job_id=j.id AND batch_number=v_number AND request_hash=v_hash) THEN
      RETURN public.assistant_lead_job_receipt(j) || jsonb_build_object('added_count',v_count,'batch_number',v_number,'replayed',true);
    END IF;
    IF j.state <> 'draft' OR v_number <> j.batch_count+1 THEN RETURN v_invalid; END IF;

    IF j.operation <> 'create' THEN
      SELECT array_agg(lead_id ORDER BY lead_id) INTO v_duplicates FROM public.assistant_lead_bulk_job_items
        WHERE job_id=j.id AND lead_id=ANY(v_ids);
      IF v_duplicates IS NOT NULL THEN RETURN jsonb_build_object('success',false,'code','duplicate_leads','duplicate_lead_ids',v_duplicates); END IF;
    END IF;
    -- A rejected batch never changes the manifest, including its sequence number.
    BEGIN
      INSERT INTO public.assistant_lead_bulk_job_batches VALUES (j.id,v_number,v_hash,v_count);
      IF j.operation = 'create' THEN
        INSERT INTO public.assistant_lead_bulk_job_items (job_id,batch_number,position,draft)
          SELECT j.id,v_number,n,value FROM jsonb_array_elements(v_batch) WITH ORDINALITY AS b(value,n);
      ELSE
        INSERT INTO public.assistant_lead_bulk_job_items (job_id,batch_number,position,lead_id,revision)
          SELECT j.id,v_number,b.n,l.id,sha256(convert_to((to_jsonb(l) || jsonb_build_object('row_version',l.xmin::text))::text,'UTF8'))
          FROM unnest(v_ids) WITH ORDINALITY AS b(id,n) JOIN public.leads l ON l.id=b.id AND l.site_id=p_site
          WHERE NOT v_restricted OR l.user_id=p_user OR l.assignee_id=p_user;
        SELECT array_agg(id ORDER BY id) INTO v_missing FROM unnest(v_ids) AS b(id) WHERE NOT EXISTS (
          SELECT 1 FROM public.assistant_lead_bulk_job_items i WHERE i.job_id=j.id AND i.lead_id=b.id);
        IF v_missing IS NOT NULL THEN RAISE SQLSTATE 'PJB01'; END IF;
      END IF;
    EXCEPTION WHEN SQLSTATE 'PJB01' THEN
      RETURN jsonb_build_object('success',false,'code','missing_leads','missing_lead_ids',v_missing);
    END;
    UPDATE public.assistant_lead_bulk_jobs SET total=total+v_count,batch_count=v_number,
      expires_at=clock_timestamp()+interval '24 hours',updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
    RETURN public.assistant_lead_job_receipt(j) || jsonb_build_object('added_count',v_count,'batch_number',v_number,'replayed',false);
  ELSIF p_command = 'job_seal' THEN
    IF (p_data->>'expected_count')::bigint IS DISTINCT FROM j.total OR j.total=0 THEN RETURN v_invalid; END IF;
    IF j.state = 'review' THEN RETURN public.assistant_lead_job_receipt(j); END IF;
    IF j.state <> 'draft' THEN RETURN v_invalid; END IF;
    UPDATE public.assistant_lead_bulk_jobs SET state='review',sealed_action_id=p_action,sealed_at=clock_timestamp(),
      expires_at=clock_timestamp()+interval '30 minutes',updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
  ELSIF p_command = 'job_submit' THEN
    IF (p_data->>'expected_count')::bigint IS DISTINCT FROM j.total THEN RETURN v_invalid; END IF;
    IF j.state IN ('queued','completed','failed') THEN RETURN public.assistant_lead_job_receipt(j); END IF;
    IF j.state <> 'review' THEN RETURN v_invalid; END IF;
    IF j.operation = 'delete' AND (p_action = j.sealed_action_id OR v_action.created_at < j.sealed_at
      OR btrim(v_action.message,E' \n\r\t') IS DISTINCT FROM 'CONFIRM DELETE LEAD JOB ' || j.id::text) THEN
      RETURN '{"success":false,"code":"confirmation_required"}';
    END IF;
    UPDATE public.assistant_lead_bulk_jobs SET state='queued',due_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=j.id RETURNING * INTO j;
  ELSE
    RETURN v_invalid;
  END IF;
  RETURN public.assistant_lead_job_receipt(j);
END;
$$;

-- A claim, write and progress update share one transaction. A lost HTTP
-- response or worker crash cannot advance the cursor without the mutation.
CREATE FUNCTION public.assistant_lead_job_tick()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '2s' AS $$
DECLARE
  j public.assistant_lead_bulk_jobs;
  v_assignee uuid;
  v_restricted boolean;
  v_ids uuid[];
  v_count integer;
  v_expected integer;
  v_changed boolean;
  v_error text;
BEGIN
  SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE state='queued' AND due_at<=statement_timestamp()
    ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"success":true,"processed":false}'; END IF;

  BEGIN
    v_assignee := (j.settings->>'assignee_id')::uuid;
    v_restricted := public.assistant_lead_job_scope(j.site_id,j.user_id,j.instance_id,j.operation,v_assignee);
    IF v_restricted IS NULL THEN v_error := 'access_denied'; RAISE SQLSTATE 'PJB02'; END IF;
    IF j.operation = 'assign_to_member' AND public.site_user_has_effective_access(j.site_id,v_assignee) IS NOT TRUE THEN
      v_error := 'invalid_assignee'; RAISE SQLSTATE 'PJB02';
    END IF;
    SELECT size INTO STRICT v_expected FROM public.assistant_lead_bulk_job_batches WHERE job_id=j.id AND batch_number=j.next_batch;

    IF j.operation = 'create' THEN
      INSERT INTO public.leads (site_id,user_id,name,email,phone,company,"position",notes,origin,status)
        SELECT j.site_id,j.user_id,d.name,d.email,d.phone,CASE WHEN d.company IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('name',d.company) END,
          d."position",d.notes,d.origin,d.status
        FROM public.assistant_lead_bulk_job_items i
        CROSS JOIN LATERAL jsonb_to_record(i.draft) AS d(name text,email text,phone text,company text,"position" text,notes text,origin text,status text)
        WHERE i.job_id=j.id AND i.batch_number=j.next_batch ORDER BY i.position;
    ELSE
      SELECT array_agg(locked.id ORDER BY locked.id), bool_or(locked.actual IS DISTINCT FROM locked.reviewed)
        INTO v_ids,v_changed FROM (
          SELECT l.id,i.revision AS reviewed,
            sha256(convert_to((to_jsonb(l) || jsonb_build_object('row_version',l.xmin::text))::text,'UTF8')) AS actual
          FROM public.assistant_lead_bulk_job_items i JOIN public.leads l ON l.id=i.lead_id AND l.site_id=j.site_id
          WHERE i.job_id=j.id AND i.batch_number=j.next_batch AND (NOT v_restricted OR l.user_id=j.user_id OR l.assignee_id=j.user_id)
          ORDER BY l.id FOR UPDATE OF l
        ) locked;
      IF cardinality(v_ids) IS DISTINCT FROM v_expected OR v_changed THEN
        v_error := 'selection_changed'; RAISE SQLSTATE 'PJB02';
      END IF;
      IF j.operation = 'delete' THEN
        DELETE FROM public.leads WHERE site_id=j.site_id AND id=ANY(v_ids);
      ELSE
        UPDATE public.leads SET status=CASE WHEN j.operation='change_status' THEN j.settings->>'status' ELSE status END,
          assignee_id=CASE j.operation WHEN 'assign_to_me' THEN j.user_id WHEN 'assign_to_member' THEN v_assignee ELSE assignee_id END,
          updated_at=clock_timestamp() WHERE site_id=j.site_id AND id=ANY(v_ids);
      END IF;
    END IF;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> v_expected THEN v_error := 'incomplete_write'; RAISE SQLSTATE 'PJB02'; END IF;

    DELETE FROM public.assistant_lead_bulk_job_items WHERE job_id=j.id AND batch_number=j.next_batch;
    UPDATE public.assistant_lead_bulk_jobs SET affected=affected+v_count,next_batch=next_batch+1,attempts=0,
      state=CASE WHEN next_batch=batch_count THEN 'completed' ELSE 'queued' END,
      due_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=j.id;
    RETURN '{"success":true,"processed":true,"outcome":"applied"}';
  EXCEPTION
    WHEN SQLSTATE 'PJB02' THEN NULL;
    WHEN integrity_constraint_violation OR data_exception THEN v_error := 'write_rejected';
    WHEN lock_not_available OR deadlock_detected OR serialization_failure OR query_canceled THEN v_error := 'temporarily_unavailable';
    WHEN OTHERS THEN v_error := 'processing_error';
  END;

  IF v_error IN ('temporarily_unavailable','processing_error') AND j.attempts < 4 THEN
    UPDATE public.assistant_lead_bulk_jobs SET attempts=attempts+1,due_at=clock_timestamp()+make_interval(secs => 15 * (1 << attempts)),
      updated_at=clock_timestamp() WHERE id=j.id;
    RETURN '{"success":true,"processed":true,"outcome":"retry"}';
  END IF;
  UPDATE public.assistant_lead_bulk_jobs SET state='failed',error_code=v_error,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN '{"success":true,"processed":true,"outcome":"failed"}';
END;
$$;

-- Expire abandoned staging and scrub finished/abandoned payloads without a
-- transaction proportional to the job size. Keep small receipts for 7 days.
CREATE FUNCTION public.assistant_lead_job_prune()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE v_job uuid;
BEGIN
  WITH expired AS (SELECT id FROM public.assistant_lead_bulk_jobs WHERE state IN ('draft','review') AND expires_at<=statement_timestamp()
    ORDER BY expires_at,id LIMIT 20 FOR UPDATE SKIP LOCKED)
  UPDATE public.assistant_lead_bulk_jobs SET state='expired',updated_at=clock_timestamp() FROM expired
    WHERE assistant_lead_bulk_jobs.id=expired.id;

  SELECT id INTO v_job FROM public.assistant_lead_bulk_jobs WHERE state IN ('completed','failed','cancelled','expired')
    AND updated_at <= statement_timestamp()-interval '7 days' ORDER BY updated_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    DELETE FROM public.assistant_lead_bulk_job_batches WHERE job_id=v_job AND batch_number IN (
      SELECT batch_number FROM public.assistant_lead_bulk_job_batches WHERE job_id=v_job ORDER BY batch_number LIMIT 20);
    DELETE FROM public.assistant_lead_bulk_jobs WHERE id=v_job AND NOT EXISTS (
      SELECT 1 FROM public.assistant_lead_bulk_job_batches WHERE job_id=v_job);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_lead_job_scope(uuid,uuid,uuid,text,uuid),
  public.assistant_lead_job_receipt(public.assistant_lead_bulk_jobs),
  public.assistant_lead_job_command(uuid,uuid,uuid,uuid,text,uuid,jsonb),public.assistant_lead_job_tick(),public.assistant_lead_job_prune()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_lead_job_command(uuid,uuid,uuid,uuid,text,uuid,jsonb),
  public.assistant_lead_job_tick(),public.assistant_lead_job_prune() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;