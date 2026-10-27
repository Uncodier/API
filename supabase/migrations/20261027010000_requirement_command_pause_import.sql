BEGIN;
SET LOCAL lock_timeout = '5s';

-- One-time bridge for pre-install pauses whose requirement xmin was changed by
-- trusted command admission. The original finish still has matching mapping and
-- status transaction identities; the current row must belong to the newest
-- admitted command transaction. No free-form error/message inference, no resume,
-- no counter reset, and no replacement of already captured pause provenance.
DO $$
DECLARE
  r public.requirements%ROWTYPE;
  h public.harness_requirement_runs%ROWTYPE;
  s public.harness_sessions%ROWTYPE;
  st public.requirement_status%ROWTYPE;
  candidate record;
  command record;
  expected_revision bigint;
  ready boolean;
BEGIN
  FOR candidate IN
    SELECT q.id FROM public.requirements q
    WHERE q.status='blocked'
      AND NOT EXISTS (SELECT 1 FROM public.requirement_economic_pauses p WHERE p.requirement_id=q.id)
      AND EXISTS (SELECT 1 FROM public.requirement_commands c WHERE c.requirement_id=q.id AND c.applied_at IS NULL)
    ORDER BY q.id
  LOOP
    SELECT * INTO r FROM public.requirements WHERE id=candidate.id FOR UPDATE;
    SELECT * INTO h FROM public.harness_requirement_runs WHERE requirement_id=r.id FOR UPDATE;
    IF NOT FOUND OR h.site_id IS DISTINCT FROM r.site_id OR h.next_run_at IS NOT NULL
      OR coalesce(h.pause_reason,'') NOT IN ('token_budget_exhausted','account_credits_exhausted',
        'turn_budget_exhausted','active_time_budget_exhausted')
      OR h.generation::text IS DISTINCT FROM r.metadata->>'requirement_execution_generation' THEN CONTINUE; END IF;
    SELECT * INTO st FROM public.requirement_status WHERE requirement_id=r.id
      ORDER BY updated_at DESC NULLS LAST,id DESC LIMIT 1 FOR SHARE;
    IF NOT FOUND OR st.site_id IS DISTINCT FROM r.site_id OR st.stage IS DISTINCT FROM 'blocked'
      OR st.cycle IS DISTINCT FROM 'agent:'||h.last_cycle_id
      OR st.instance_id::text IS DISTINCT FROM r.metadata->>'runner_instance_id'
      OR st.updated_at IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.harness_requirement_runs m
      JOIN public.requirement_status status ON status.id=st.id
      WHERE m.requirement_id=r.id AND m.xmin=status.xmin) THEN CONTINUE; END IF;
    -- A later unrelated row write, forged revision, or missing newest command
    -- cannot be explained by command admission and remains operator-only.
    IF NOT EXISTS (SELECT 1 FROM public.requirements q JOIN public.requirement_commands c
      ON c.requirement_id=q.id AND c.revision=q.external_user_action_revision
      WHERE q.id=r.id AND q.xmin=c.xmin AND c.applied_at IS NULL
        AND c.action_id::text=q.last_external_user_action_id) THEN CONTINUE; END IF;
    SELECT * INTO s FROM public.harness_sessions WHERE id=h.session_id FOR UPDATE;
    IF NOT FOUND OR s.site_id IS DISTINCT FROM r.site_id OR s.user_id IS DISTINCT FROM r.user_id
      OR s.snapshot->>'status' IS DISTINCT FROM 'paused'
      OR s.snapshot->>'reason' IS DISTINCT FROM h.pause_reason
      OR (s.snapshot#>>'{request,requirementId}' IS NOT NULL
        AND s.snapshot#>>'{request,requirementId}'<>r.id::text) THEN CONTINUE; END IF;
    SELECT min(c.revision) INTO expected_revision FROM public.requirement_commands c
      WHERE c.requirement_id=r.id AND c.applied_at IS NULL;
    ready:=true;
    FOR command IN SELECT c.*, a.site_id AS action_site, a.user_id AS action_user,
        a.instance_id AS action_instance, a.log_type, a.trusted_user_action,
        a.details->>'status' AS action_status, a.created_at AS action_created,
        receipt.revision AS receipt_revision
      FROM public.requirement_commands c LEFT JOIN public.instance_logs a ON a.id=c.action_id
      LEFT JOIN public.requirement_user_action_receipts receipt
        ON receipt.requirement_id=c.requirement_id AND receipt.action_id=c.action_id
      WHERE c.requirement_id=r.id AND c.applied_at IS NULL ORDER BY c.revision FOR SHARE OF c
    LOOP
      IF command.revision IS DISTINCT FROM expected_revision
        OR command.receipt_revision IS DISTINCT FROM command.revision
        OR command.action_site IS DISTINCT FROM r.site_id
        OR command.log_type IS DISTINCT FROM 'user_action'
        OR command.trusted_user_action IS DISTINCT FROM true
        OR coalesce(command.action_status,'') NOT IN ('completed','failed')
        OR command.action_created IS NULL OR command.action_created<st.updated_at
        OR public.site_user_has_effective_access(r.site_id,command.action_user) IS DISTINCT FROM true
        OR NOT EXISTS (SELECT 1 FROM public.remote_instances i WHERE i.id=command.action_instance
          AND i.site_id=r.site_id AND i.is_archived IS NOT TRUE) THEN ready:=false; EXIT; END IF;
      expected_revision:=expected_revision+1;
    END LOOP;
    IF NOT ready OR expected_revision-1 IS DISTINCT FROM r.external_user_action_revision THEN CONTINUE; END IF;
    INSERT INTO public.requirement_economic_pauses(requirement_id,status_id,session_id,generation,
      requirement_guard,status_guard,session_version,pause_reason)
    VALUES(r.id,st.id,h.session_id,h.generation,to_jsonb(r)-ARRAY['budget','updated_at'],
      to_jsonb(st),s.version,h.pause_reason) ON CONFLICT(requirement_id) DO NOTHING;
    -- Existing recovery still checks all leases, manual pauses, uncertain effects,
    -- cleanup, accounting and credits before atomically applying this command chain.
  END LOOP;
END;
$$;
COMMIT;