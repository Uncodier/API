BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.assistant_lead_bulk_jobs
  ADD COLUMN selection_filter jsonb,
  ADD COLUMN selection_after uuid,
  ADD COLUMN selection_done boolean NOT NULL DEFAULT false;
CREATE INDEX assistant_lead_bulk_selection_due ON public.assistant_lead_bulk_jobs (due_at,id)
  WHERE state='draft' AND selection_filter IS NOT NULL AND NOT selection_done;

CREATE OR REPLACE FUNCTION public.assistant_lead_job_receipt(j public.assistant_lead_bulk_jobs)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('success',true,'job_id',j.id,'operation',j.operation,
    'state',CASE WHEN j.state='draft' AND j.selection_filter IS NOT NULL AND NOT j.selection_done THEN 'selecting' ELSE j.state END,
    'total_count',j.total,'affected_count',j.affected,'remaining_count',j.total-j.affected,
    'batch_count',j.batch_count,'completed_batches',j.next_batch-1,'error_code',j.error_code,
    'failed_batch',CASE WHEN j.state='failed' AND (j.selection_filter IS NULL OR j.selection_done) THEN j.next_batch END)
    || j.settings
    || CASE WHEN j.selection_filter IS NOT NULL THEN jsonb_build_object('selection_filter',j.selection_filter) ELSE '{}'::jsonb END
    || CASE WHEN j.state='review' THEN jsonb_build_object('expires_at',j.expires_at)
      || CASE WHEN j.operation='delete' THEN jsonb_build_object('confirmation_message','CONFIRM DELETE LEAD JOB ' || j.id) ELSE '{}'::jsonb END
      ELSE '{}'::jsonb END;
$$;

ALTER FUNCTION public.assistant_lead_job_command(uuid,uuid,uuid,uuid,text,uuid,jsonb) RENAME TO assistant_lead_job_command_base;
REVOKE EXECUTE ON FUNCTION public.assistant_lead_job_command_base(uuid,uuid,uuid,uuid,text,uuid,jsonb) FROM service_role;

CREATE FUNCTION public.assistant_lead_job_command(p_site uuid,p_user uuid,p_instance uuid,p_action uuid,
  p_command text,p_job uuid,p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' SET lock_timeout='5s' AS $$
DECLARE
  j public.assistant_lead_bulk_jobs;
  v_result jsonb;
  v_filter jsonb := p_data->'selection_filter';
  v_restricted boolean;
  v_page bigint;
  v_items jsonb;
  v_invalid constant jsonb := '{"success":false,"code":"invalid_job_state"}';
  v_denied constant jsonb := '{"success":false,"code":"access_denied"}';
BEGIN
  IF p_command IN ('job_select','job_open','job_preview','job_add','job_seal') THEN
    PERFORM 1 FROM public.instance_logs WHERE id=p_action AND instance_id=p_instance AND site_id=p_site AND user_id=p_user
      AND log_type='user_action' AND trusted_user_action IS TRUE AND details->>'status'='running'
      AND details->'lead_bulk_user_session'='true'::jsonb FOR SHARE;
    IF NOT FOUND THEN RETURN v_denied; END IF;
  END IF;
  IF p_command='job_select' THEN
    IF p_data->>'operation' NOT IN ('assign_to_me','assign_to_member','change_status','delete')
      OR p_data->>'operation' IS NULL
      OR jsonb_typeof(v_filter) IS DISTINCT FROM 'object' THEN RETURN v_invalid; END IF;
    IF v_filter <> '{"all":true}'::jsonb AND NOT (
      (v_filter-'status')='{}'::jsonb AND coalesce(v_filter->>'status' IN
        ('new','contacted','qualified','converted','lost','cold','not_qualified'),false)) THEN RETURN v_invalid; END IF;
    -- Serialize opens for this turn, including a legacy manual open. Roll back
    -- a just-created job if initialization cannot finish in this transaction.
    PERFORM pg_advisory_xact_lock(hashtextextended('lead-job-open:'||p_action,0));
    SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE action_id=p_action;
    IF FOUND AND j.selection_filter IS DISTINCT FROM v_filter THEN RETURN v_invalid; END IF;
    v_result := public.assistant_lead_job_command_base(p_site,p_user,p_instance,p_action,'job_open',NULL,p_data);
    IF v_result->>'success'<>'true' THEN RETURN v_result; END IF;
    IF j.id IS NOT NULL THEN RETURN v_result; END IF;
    UPDATE public.assistant_lead_bulk_jobs SET selection_filter=v_filter
      WHERE id=(v_result->>'job_id')::uuid RETURNING * INTO j;
    RETURN public.assistant_lead_job_receipt(j);
  ELSIF p_command='job_open' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('lead-job-open:'||p_action,0));
    IF EXISTS (SELECT 1 FROM public.assistant_lead_bulk_jobs WHERE action_id=p_action AND selection_filter IS NOT NULL) THEN
      RETURN v_invalid;
    END IF;
  ELSIF p_command IN ('job_preview','job_add','job_seal') THEN
    IF p_command='job_preview' THEN
      SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE id=p_job AND site_id=p_site AND user_id=p_user AND instance_id=p_instance FOR SHARE;
    ELSE
      SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE id=p_job AND site_id=p_site AND user_id=p_user AND instance_id=p_instance FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RETURN v_denied; END IF;
    IF j.selection_filter IS NOT NULL AND (p_command='job_add' OR (p_command='job_seal' AND NOT j.selection_done)) THEN
      RETURN v_invalid;
    END IF;
    IF p_command='job_preview' THEN
      v_restricted := public.assistant_lead_job_scope(p_site,p_user,p_instance,j.operation,(j.settings->>'assignee_id')::uuid);
      IF v_restricted IS NULL THEN RETURN v_denied; END IF;
      v_page := (p_data->>'batch_number')::bigint;
      IF j.state<>'review' OR j.expires_at<=clock_timestamp() OR v_page IS NULL OR v_page NOT BETWEEN 1 AND j.batch_count THEN RETURN v_invalid; END IF;
      SELECT jsonb_agg(CASE WHEN j.operation='create' THEN
          jsonb_build_object('name',i.draft->>'name','status',i.draft->>'status')
        WHEN l.id IS NULL THEN jsonb_build_object('unavailable',true)
        WHEN i.revision IS DISTINCT FROM sha256(convert_to((to_jsonb(l)||jsonb_build_object('row_version',l.xmin::text))::text,'UTF8'))
          THEN jsonb_build_object('id',i.lead_id,'changed',true)
        ELSE jsonb_build_object('id',l.id,'name',l.name,'status',l.status) END ORDER BY i.position)
      INTO v_items FROM public.assistant_lead_bulk_job_items i LEFT JOIN public.leads l
        ON l.id=i.lead_id AND l.site_id=p_site AND (NOT v_restricted OR l.user_id=p_user OR l.assignee_id=p_user)
        WHERE i.job_id=j.id AND i.batch_number=v_page;
      RETURN (public.assistant_lead_job_receipt(j)-'confirmation_message') || jsonb_build_object(
        'batch_number',v_page,'next_batch_number',CASE WHEN v_page<j.batch_count THEN v_page+1 END,'preview_items',v_items);
    END IF;
  END IF;
  RETURN public.assistant_lead_job_command_base(p_site,p_user,p_instance,p_action,p_command,p_job,p_data);
END;
$$;

-- Examine a bounded keyset page before applying filters. Even a sparse filter
-- cannot turn one tick into an unbounded search. No leads are written or locked.
CREATE FUNCTION public.assistant_lead_job_select_tick()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' SET lock_timeout='2s' AS $$
DECLARE
  j public.assistant_lead_bulk_jobs;
  v_restricted boolean;
  v_cursor uuid;
  v_scanned integer;
  v_selected integer;
  v_rows jsonb;
  v_number bigint;
BEGIN
  SELECT * INTO j FROM public.assistant_lead_bulk_jobs WHERE state='draft' AND selection_filter IS NOT NULL
    AND NOT selection_done AND due_at<=statement_timestamp() AND expires_at>statement_timestamp()
    ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"success":true,"processed":false}'; END IF;
  v_restricted := public.assistant_lead_job_scope(j.site_id,j.user_id,j.instance_id,j.operation,(j.settings->>'assignee_id')::uuid);
  IF v_restricted IS NULL THEN
    UPDATE public.assistant_lead_bulk_jobs SET state='failed',error_code='access_denied',updated_at=clock_timestamp() WHERE id=j.id;
    RETURN '{"success":true,"processed":true,"outcome":"failed"}';
  END IF;

  WITH page AS MATERIALIZED (
    SELECT l.id FROM public.leads l WHERE l.site_id=j.site_id
      AND l.id>=coalesce(j.selection_after,'00000000-0000-0000-0000-000000000000'::uuid)
      AND l.id IS DISTINCT FROM j.selection_after ORDER BY l.id LIMIT 50
  ), matches AS (
    SELECT l.id,sha256(convert_to((to_jsonb(l)||jsonb_build_object('row_version',l.xmin::text))::text,'UTF8')) AS revision
      FROM page p JOIN public.leads l ON l.id=p.id
      WHERE l.site_id=j.site_id AND (NOT v_restricted OR l.user_id=j.user_id OR l.assignee_id=j.user_id)
        AND (j.selection_filter ? 'all' OR l.status=j.selection_filter->>'status')
  )
  SELECT (SELECT id FROM page ORDER BY id DESC LIMIT 1),(SELECT count(*) FROM page),count(*),
    jsonb_agg(jsonb_build_array(id,encode(revision,'hex')) ORDER BY id)
    INTO v_cursor,v_scanned,v_selected,v_rows FROM matches;

  IF v_selected>0 THEN
    v_number := j.batch_count+1;
    INSERT INTO public.assistant_lead_bulk_job_batches VALUES(j.id,v_number,sha256(convert_to(v_rows::text,'UTF8')),v_selected);
    INSERT INTO public.assistant_lead_bulk_job_items(job_id,batch_number,position,lead_id,revision)
      SELECT j.id,v_number,n,(r->>0)::uuid,decode(r->>1,'hex') FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS rows(r,n);
  END IF;
  UPDATE public.assistant_lead_bulk_jobs SET total=total+v_selected,batch_count=coalesce(v_number,batch_count),
    selection_after=coalesce(v_cursor,selection_after),selection_done=v_scanned<50,due_at=clock_timestamp(),
    expires_at=clock_timestamp()+interval '24 hours',updated_at=clock_timestamp() WHERE id=j.id;
  RETURN '{"success":true,"processed":true,"outcome":"staged"}';
EXCEPTION WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
  -- The block rolls back the claim and page; the next cron can retry it.
  RETURN '{"success":true,"processed":true,"outcome":"retry"}';
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_lead_job_command(uuid,uuid,uuid,uuid,text,uuid,jsonb),
  public.assistant_lead_job_select_tick() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assistant_lead_job_command(uuid,uuid,uuid,uuid,text,uuid,jsonb),
  public.assistant_lead_job_select_tick() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;