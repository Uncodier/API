-- ONE-TIME OPERATOR REPAIR, not a migration or a reusable recovery mechanism.
-- Review the incident and run as the database operator, with ON_ERROR_STOP (psql)
-- or an equivalent stop-on-error client. Never run automatically at deployment.
-- Deploy the idle-timeout API fix FIRST, then execute once after review.
-- Exact version 587 is intentional: any later save requires fresh diagnosis,
-- not relaxing this fence. No external/provider state is reconciled by this SQL.
-- Requires the existing pause-command drainer (20261026030000) and controls.
-- Brief table write locks protect absence checks against inserted plans,
-- reservations and cleanup/leases. Reads continue; use a quiet operator window.
-- A lock timeout, mismatch, or failed control aborts the entire transaction.
-- No audit row is inserted: requirement_status triggers have product effects.
-- After commit, the EXISTING drainer applies revision 7 and increments generation;
-- the EXISTING cron/budget admission determines whether work can actually run.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

SELECT pg_advisory_xact_lock(hashtextextended('requirement-cron-global-capacity', 0));
LOCK TABLE public.requirements, public.harness_requirement_runs,
  public.harness_sessions, public.remote_instances, public.instance_plans,
  public.instance_logs, public.requirement_status, public.requirement_commands,
  public.harness_model_credit_reservations IN SHARE ROW EXCLUSIVE MODE;

DO $repair$
DECLARE
  expected_requirement CONSTANT uuid := 'aed8167c-a4fc-43ed-824d-832c9163cd1b';
  expected_session CONSTANT uuid := '96d3d132-7ad7-4f36-8a41-440f44dc7d50';
  expected_site CONSTANT uuid := '9be0a6a2-5567-41bf-ad06-cb4014f0faf2';
  expected_session_version CONSTANT bigint := 587;
  r public.requirements%ROWTYPE;
  h public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE;
  st public.requirement_status%ROWTYPE;
  command public.requirement_commands%ROWTYPE;
  action public.instance_logs%ROWTYPE;
  owner public.remote_instances%ROWTYPE;
  resumed jsonb;
BEGIN
  SELECT * INTO STRICT r FROM public.requirements WHERE id=expected_requirement FOR UPDATE;
  SELECT * INTO STRICT h FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE;
  SELECT * INTO STRICT s FROM public.harness_sessions WHERE id=expected_session FOR UPDATE;
  IF r.site_id IS DISTINCT FROM expected_site OR h.site_id IS DISTINCT FROM expected_site
    OR s.site_id IS DISTINCT FROM expected_site OR s.user_id IS DISTINCT FROM r.user_id
    OR h.session_id IS DISTINCT FROM expected_session
    OR s.snapshot#>>'{request,requirementId}' IS DISTINCT FROM r.id::text
    OR r.status IS DISTINCT FROM 'blocked' OR h.generation IS DISTINCT FROM 2
    OR r.metadata->>'requirement_execution_generation' IS DISTINCT FROM '2'
    OR h.next_run_at IS NOT NULL
    OR h.pause_reason IS DISTINCT FROM 'assistant_execution_requires_reconciliation'
    OR s.snapshot->>'status' IS DISTINCT FROM 'paused'
    OR s.snapshot->>'reason' IS DISTINCT FROM h.pause_reason
    OR s.version IS DISTINCT FROM expected_session_version
    OR s.snapshot->>'version' IS DISTINCT FROM expected_session_version::text THEN
    RAISE EXCEPTION 'Incident repair refused: identity, pause, generation or version changed';
  END IF;
  IF s.snapshot ?| ARRAY['assistantExecutionVersion','assistantAuditCursor','auditCursor','pending']
    OR s.snapshot->'uncertainOperations' IS DISTINCT FROM '[]'::jsonb
    OR jsonb_typeof(s.snapshot->'messages') IS DISTINCT FROM 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') msg,
      jsonb_array_elements(coalesce(msg->'toolCalls','[]'::jsonb)) call
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'messages') result
        WHERE result->>'role'='tool' AND result->>'toolCallId'=call->>'id')) THEN
    RAISE EXCEPTION 'Incident repair refused: execution evidence requires reconciliation';
  END IF;
  IF r.cron_lock_expires_at>clock_timestamp() OR s.lease_expires_at>clock_timestamp()
    OR EXISTS (SELECT 1 FROM public.harness_sessions other
      WHERE (other.id=s.id OR (other.site_id=r.site_id AND other.snapshot#>>'{request,requirementId}'=r.id::text)
        OR other.snapshot#>>'{workspace,id}'=s.snapshot#>>'{workspace,id}'
        OR other.sandbox_cleanup_resource=s.snapshot#>>'{workspace,id}')
      AND (other.sandbox_cleanup_token IS NOT NULL OR other.lease_expires_at>clock_timestamp()))
    OR EXISTS (SELECT 1 FROM public.harness_model_credit_reservations
      WHERE (requirement_id=r.id OR session_id=s.id) AND state IN ('reserved','dispatched','pending'))
    OR EXISTS (SELECT 1 FROM public.requirements other WHERE other.id<>r.id
      AND other.cron_lock_expires_at>clock_timestamp()
      AND (other.metadata->>'runner_instance_id' IN (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id')
        OR other.metadata->>'assistant_origin_instance_id' IN (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id'))) THEN
    RAISE EXCEPTION 'Incident repair refused: live ownership, cleanup or model reservation';
  END IF;
  FOR owner IN SELECT i.* FROM public.remote_instances i WHERE i.site_id=r.site_id
    AND i.id::text IN (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id')
    ORDER BY i.id FOR UPDATE
  LOOP
    IF owner.is_archived IS TRUE OR owner.status IN ('paused','stopped','stopping','cancelled') THEN
      RAISE EXCEPTION 'Incident repair refused: runner or origin is paused or unavailable';
    END IF;
  END LOOP;
  IF public.agent_requirement_runner_allowed(r.id,(r.metadata->>'runner_instance_id')::uuid) IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM public.instance_plans p WHERE p.site_id=r.site_id AND p.status='paused'
      AND (p.metadata->>'requirement_id'=r.id::text OR p.instance_id::text IN
        (r.metadata->>'runner_instance_id',r.metadata->>'assistant_origin_instance_id'))) THEN
    RAISE EXCEPTION 'Incident repair refused: runner admission or paused plan';
  END IF;
  SELECT * INTO STRICT st FROM public.requirement_status WHERE requirement_id=r.id
    ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1 FOR SHARE;
  IF st.site_id IS DISTINCT FROM r.site_id OR st.stage IS DISTINCT FROM 'blocked'
    OR st.instance_id::text IS DISTINCT FROM r.metadata->>'runner_instance_id'
    OR h.last_cycle_id IS NULL OR st.cycle IS DISTINCT FROM 'agent:'||h.last_cycle_id
    OR st.updated_at IS NULL THEN
    RAISE EXCEPTION 'Incident repair refused: pause status provenance changed';
  END IF;
  IF (SELECT count(*) FROM public.requirement_commands WHERE requirement_id=r.id AND applied_at IS NULL)<>1 THEN
    RAISE EXCEPTION 'Incident repair refused: expected exactly one queued command';
  END IF;
  SELECT * INTO STRICT command FROM public.requirement_commands
    WHERE requirement_id=r.id AND applied_at IS NULL FOR UPDATE;
  SELECT * INTO STRICT action FROM public.instance_logs WHERE id=command.action_id FOR SHARE;
  IF command.revision IS DISTINCT FROM 7 OR r.external_user_action_revision IS DISTINCT FROM 7
    OR r.last_external_user_action_id IS DISTINCT FROM action.id::text
    OR action.site_id IS DISTINCT FROM r.site_id OR action.user_id IS NULL
    OR action.trusted_user_action IS DISTINCT FROM true OR action.log_type IS DISTINCT FROM 'user_action'
    OR action.details->>'status' IS DISTINCT FROM 'completed'
    OR action.created_at IS NULL OR action.created_at<st.updated_at
    OR command.created_at<st.updated_at
    OR NOT EXISTS (SELECT 1 FROM public.remote_instances source WHERE source.id=action.instance_id
      AND source.site_id=r.site_id AND source.is_archived IS NOT TRUE) THEN
    RAISE EXCEPTION 'Incident repair refused: revision 7 is not a trusted completed post-pause command';
  END IF;

  -- The ONLY write: established control preserves transcript, counters, request,
  -- workspace and old reason. Never edit the snapshot, mapping or receipts here.
  resumed := public.control_harness_session(s.id,r.site_id,'resume');
  IF resumed IS NULL OR resumed->>'status' IS DISTINCT FROM 'queued'
    OR resumed->>'version' IS DISTINCT FROM (expected_session_version+1)::text
    OR resumed-ARRAY['status','version','updatedAt'] IS DISTINCT FROM s.snapshot-ARRAY['status','version','updatedAt'] THEN
    RAISE EXCEPTION 'Incident repair refused: unexpected control result';
  END IF;
  RAISE NOTICE 'Incident session resumed; command remains queued for existing cron and budget admission';
END;
$repair$;
COMMIT;