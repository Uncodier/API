BEGIN;
SET LOCAL lock_timeout = '5s';

-- Internal workflow, not a message: never expose the proposal or its outcome
-- through conversations, browser grants, RLS policies or realtime subscriptions.
CREATE TABLE public.connector_action_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  -- Immutable provenance snapshots survive reassignment/deletion of their source.
  conversation_id uuid,
  agent_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256
    AND idempotency_key = btrim(idempotency_key)),
  action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object' AND action <> '{}'::jsonb
    AND octet_length(action::text) <= 65536),
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '24 hours'),
  -- The deciding workspace member is the execution actor; never the customer.
  actor_user_id uuid,
  decided_at timestamptz,
  finished_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (site_id, agent_id, conversation_id, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK ((status IN ('pending','expired') AND actor_user_id IS NULL AND decided_at IS NULL AND finished_at IS NULL)
    OR (status IN ('executing','rejected') AND actor_user_id IS NOT NULL AND decided_at IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('succeeded','failed') AND actor_user_id IS NOT NULL AND decided_at IS NOT NULL AND finished_at IS NOT NULL))
);
CREATE INDEX connector_approval_site_created ON public.connector_action_approvals(site_id, created_at DESC, id);
CREATE INDEX connector_approval_pending_budget ON public.connector_action_approvals(site_id, expires_at, conversation_id)
  WHERE status='pending';
ALTER TABLE public.connector_action_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connector_action_approvals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.connector_action_approvals TO service_role;

CREATE FUNCTION public.connector_guard_approval_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.id, NEW.site_id, NEW.agent_id, NEW.conversation_id, NEW.idempotency_key,
         NEW.action, NEW.created_at, NEW.expires_at) IS DISTINCT FROM
     ROW(OLD.id, OLD.site_id, OLD.agent_id, OLD.conversation_id, OLD.idempotency_key,
         OLD.action, OLD.created_at, OLD.expires_at)
     OR NOT ((OLD.status = 'pending' AND NEW.status IN ('executing','rejected','expired'))
       OR (OLD.status = 'executing' AND NEW.status IN ('succeeded','failed')
           AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
           AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at)) THEN
    RAISE EXCEPTION 'Invalid approval transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_guard_approval_transition() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER connector_approval_transition BEFORE UPDATE ON public.connector_action_approvals
  FOR EACH ROW EXECUTE FUNCTION public.connector_guard_approval_transition();

CREATE FUNCTION public.connector_assert_approval_origin(p_site_id uuid, p_conversation_id uuid, p_agent_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.agents WHERE id=p_agent_id AND site_id=p_site_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid approval origin' USING ERRCODE='42501'; END IF;
  IF p_conversation_id IS NOT NULL THEN
    PERFORM 1 FROM public.conversations WHERE id=p_conversation_id AND site_id=p_site_id
      AND agent_id=p_agent_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid approval origin' USING ERRCODE='42501'; END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.connector_assert_approval_origin(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.request_connector_action_approval(p_site_id uuid, p_conversation_id uuid, p_agent_id uuid,
  p_idempotency_key text, p_action jsonb) RETURNS SETOF public.connector_action_approvals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE proposal public.connector_action_approvals%ROWTYPE; admission_time timestamptz;
  site_pending bigint; conversation_pending bigint;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.sites WHERE id=p_site_id AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid approval origin' USING ERRCODE='42501'; END IF;
  PERFORM public.connector_assert_approval_origin(p_site_id, p_conversation_id, p_agent_id);
  -- Admission must count commits made while waiting for the previous proposer.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Approval admission requires read committed isolation' USING ERRCODE='25000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('connector-approval:' || p_site_id::text, 0));
  SELECT * INTO proposal FROM public.connector_action_approvals WHERE site_id=p_site_id AND agent_id=p_agent_id
    AND conversation_id IS NOT DISTINCT FROM p_conversation_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF proposal.action IS DISTINCT FROM p_action THEN
      RAISE EXCEPTION 'Approval idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN NEXT proposal; RETURN;
  END IF;
  admission_time := clock_timestamp();
  SELECT count(*), count(*) FILTER (WHERE conversation_id=p_conversation_id)
    INTO site_pending, conversation_pending FROM public.connector_action_approvals
    WHERE site_id=p_site_id AND status='pending' AND expires_at > admission_time;
  IF site_pending >= 50 OR conversation_pending >= 5 THEN
    RAISE EXCEPTION 'Pending approval limit reached' USING ERRCODE='54000';
  END IF;
  INSERT INTO public.connector_action_approvals(site_id, conversation_id, agent_id, idempotency_key, action, created_at, expires_at)
    VALUES (p_site_id, p_conversation_id, p_agent_id, p_idempotency_key, p_action, admission_time,
      admission_time + interval '24 hours') RETURNING * INTO proposal;
  RETURN NEXT proposal;
END;
$$;

CREATE FUNCTION public.decide_connector_action_approval(p_site_id uuid, p_approval_id uuid,
  p_actor_user_id uuid, p_decision text) RETURNS SETOF public.connector_action_approvals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE proposal public.connector_action_approvals%ROWTYPE; decision_time timestamptz;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'Invalid approval decision' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.sites WHERE id=p_site_id FOR SHARE;
  PERFORM 1 FROM public.site_ownership WHERE site_id=p_site_id AND user_id=p_actor_user_id FOR SHARE;
  PERFORM 1 FROM public.site_members WHERE site_id=p_site_id AND user_id=p_actor_user_id ORDER BY id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM public.connector_effective_site_access(p_site_id,p_actor_user_id) WHERE can_manage) THEN
    RAISE EXCEPTION 'Connector management denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO proposal FROM public.connector_action_approvals
    WHERE site_id=p_site_id AND id=p_approval_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_decision='approve' AND proposal.expires_at > clock_timestamp() THEN
    PERFORM public.connector_assert_approval_origin(p_site_id, proposal.conversation_id, proposal.agent_id);
  END IF;
  -- Use wall time after acquiring locks; a waiter cannot use a pre-expiry transaction timestamp.
  decision_time := clock_timestamp();
  IF proposal.expires_at <= decision_time THEN
    UPDATE public.connector_action_approvals SET status='expired' WHERE id=proposal.id;
    RETURN;
  END IF;
  RETURN QUERY UPDATE public.connector_action_approvals SET
    status=CASE WHEN p_decision='approve' THEN 'executing' ELSE 'rejected' END,
    actor_user_id=p_actor_user_id, decided_at=decision_time WHERE id=proposal.id RETURNING *;
END;
$$;

-- No release/retry transition, even after a crash or ambiguous provider outcome.
CREATE FUNCTION public.finish_connector_action_approval(p_site_id uuid, p_approval_id uuid,
  p_actor_user_id uuid, p_status text) RETURNS SETOF public.connector_action_approvals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'Invalid completion status' USING ERRCODE='22023';
  END IF;
  -- Completing records an outcome rather than authorizing another operation.
  RETURN QUERY UPDATE public.connector_action_approvals SET status=p_status, finished_at=clock_timestamp()
    WHERE id=p_approval_id AND site_id=p_site_id AND actor_user_id=p_actor_user_id AND status='executing' RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.request_connector_action_approval(uuid,uuid,uuid,text,jsonb),
  public.decide_connector_action_approval(uuid,uuid,uuid,text), public.finish_connector_action_approval(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_connector_action_approval(uuid,uuid,uuid,text,jsonb),
  public.decide_connector_action_approval(uuid,uuid,uuid,text), public.finish_connector_action_approval(uuid,uuid,uuid,text)
  TO service_role;
COMMIT;