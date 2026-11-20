BEGIN;
SET LOCAL lock_timeout = '5s';

-- Fail closed on a channel collision rather than reclassifying existing chats.
LOCK TABLE public.conversations IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM public.conversations WHERE channel = 'internal_review') THEN
    RAISE EXCEPTION 'Reserved review channel already in use';
  END IF;
END $$;

-- Snapshots, not FKs to mutable instance/agent/member assignments. None of the
-- source identifiers or action contents are copied to chat metadata/messages.
CREATE TABLE public.connector_review_threads (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) DEFERRABLE INITIALLY DEFERRED,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL, owner_id uuid NOT NULL, agent_id uuid NOT NULL,
  UNIQUE(site_id, instance_id, owner_id, agent_id)
);
CREATE TABLE public.connector_approval_review_links (
  approval_id uuid PRIMARY KEY REFERENCES public.connector_action_approvals(id) ON DELETE CASCADE,
  review_conversation_id uuid NOT NULL REFERENCES public.conversations(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX connector_approval_links_by_thread ON public.connector_approval_review_links(review_conversation_id);
ALTER TABLE public.connector_review_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_approval_review_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connector_review_threads, public.connector_approval_review_links
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.connector_approval_review_links TO service_role;

CREATE FUNCTION public.connector_review_link_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Review link is immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION public.connector_review_link_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER connector_review_link_immutable BEFORE UPDATE ON public.connector_approval_review_links
  FOR EACH ROW EXECUTE FUNCTION public.connector_review_link_immutable();
CREATE TRIGGER connector_review_group_immutable BEFORE UPDATE ON public.connector_review_threads
  FOR EACH ROW EXECUTE FUNCTION public.connector_review_link_immutable();

-- A generic review thread can be shared with a current manager who can actually
-- use a represented connector. Managing metadata alone does not grant use.
CREATE FUNCTION public.connector_can_read_review_thread(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT FROM public.connector_review_threads t
    JOIN public.remote_instances i ON (i.id,i.site_id,i.user_id) = (t.instance_id,t.site_id,t.owner_id)
    CROSS JOIN LATERAL public.connector_effective_site_access(t.site_id,auth.uid()) s
    WHERE t.conversation_id = p_thread AND s.can_view AND (t.owner_id = auth.uid() OR
      (s.can_manage AND EXISTS (
        SELECT FROM public.connector_approval_review_links l
        JOIN public.connector_action_approvals a ON a.id=l.approval_id AND a.site_id=t.site_id
        JOIN public.connectors c ON c.site_id=a.site_id AND c.id::text=lower(a.action->>'connector_id')
        LEFT JOIN public.connector_members m ON (m.connector_id,m.site_id,m.user_id)=(c.id,c.site_id,auth.uid())
        WHERE l.review_conversation_id=t.conversation_id AND c.enabled AND NOT c.revocation_pending
          AND CASE WHEN m.user_id IS NULL THEN c.access_mode='workspace' ELSE
            m.can_view AND m.can_use AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp()) END
      )))
  );
$$;
REVOKE ALL ON FUNCTION public.connector_can_read_review_thread(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.connector_can_read_review_thread(uuid) TO authenticated;

-- The baseline permissive conversation policy grants far broader site access,
-- including user_id matches without membership. Intersect; never replace it.
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_review_no_anonymous ON public.conversations AS RESTRICTIVE TO anon
  USING (channel IS DISTINCT FROM 'internal_review') WITH CHECK (channel IS DISTINCT FROM 'internal_review');
CREATE POLICY connector_review_select ON public.conversations AS RESTRICTIVE FOR SELECT TO authenticated
  USING (channel IS DISTINCT FROM 'internal_review' OR public.connector_can_read_review_thread(id));
CREATE POLICY connector_review_insert ON public.conversations AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (channel IS DISTINCT FROM 'internal_review');
CREATE POLICY connector_review_update ON public.conversations AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (channel IS DISTINCT FROM 'internal_review') WITH CHECK (channel IS DISTINCT FROM 'internal_review');
CREATE POLICY connector_review_delete ON public.conversations AS RESTRICTIVE FOR DELETE TO authenticated
  USING (channel IS DISTINCT FROM 'internal_review');
-- These DDL privileges bypass row policies: TRUNCATE erases every chat,
-- REFERENCES permits hidden-ID probes and TRIGGER can modify delivery guards.
-- No existing FK is removed. Ordinary chat and message CRUD stays unchanged.
REVOKE TRIGGER, TRUNCATE, REFERENCES ON public.conversations FROM PUBLIC, anon, authenticated;
REVOKE TRIGGER ON public.messages FROM PUBLIC, anon, authenticated;

-- Even privileged channel writers cannot convert review threads or attach a
-- customer. The only mutable data is the list's activity timestamp pair.
CREATE FUNCTION public.connector_review_chat_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT FROM public.connector_review_threads t WHERE
      (t.conversation_id,t.site_id,t.owner_id,t.agent_id)=(NEW.id,NEW.site_id,NEW.user_id,NEW.agent_id)) THEN
      RAISE EXCEPTION 'Reserved conversation channel' USING ERRCODE='42501';
    END IF;
  ELSIF OLD.channel IS DISTINCT FROM NEW.channel OR
    (to_jsonb(OLD) - ARRAY['last_message_at','updated_at']) IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['last_message_at','updated_at']) THEN
    RAISE EXCEPTION 'Review conversation is read only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.connector_review_chat_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER connector_review_chat_insert BEFORE INSERT ON public.conversations FOR EACH ROW
  WHEN (NEW.channel='internal_review') EXECUTE FUNCTION public.connector_review_chat_guard();
CREATE TRIGGER connector_review_chat_guard BEFORE UPDATE ON public.conversations FOR EACH ROW
  WHEN (OLD.channel='internal_review' OR NEW.channel='internal_review') EXECUTE FUNCTION public.connector_review_chat_guard();

-- Never enqueue customer messages, channel-health observations, summary
-- updates or workflow deliveries on this channel, including via service_role.
CREATE FUNCTION public.connector_review_message_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT FROM public.conversations WHERE id=NEW.conversation_id AND channel='internal_review') THEN
    RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.connector_review_message_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER connector_review_message_guard BEFORE INSERT OR UPDATE OF conversation_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.connector_review_message_guard();

-- Preserve the existing dispatcher and its privileges. Multi-event triggers
-- cannot reference OLD and NEW in a shared WHEN clause. Fail on missing baseline.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_trigger WHERE tgrelid='public.conversations'::regclass
      AND tgname='conversations_webhooks' AND tgfoid='public.dispatch_workflow_database_webhook()'::regprocedure
      AND NOT tgisinternal AND tgtype=29 AND tgenabled='O' AND tgnargs=0 AND tgqual IS NULL
      AND tgattr=''::int2vector AND tgconstraint=0 AND tgoldtable IS NULL AND tgnewtable IS NULL) THEN
    RAISE EXCEPTION 'Unexpected conversation webhook configuration; inspect before migration';
  END IF;
END $$;
DROP TRIGGER conversations_webhooks ON public.conversations;
CREATE TRIGGER conversations_webhooks_insert AFTER INSERT ON public.conversations FOR EACH ROW
  WHEN (NEW.channel IS DISTINCT FROM 'internal_review') EXECUTE FUNCTION public.dispatch_workflow_database_webhook();
CREATE TRIGGER conversations_webhooks_update AFTER UPDATE ON public.conversations FOR EACH ROW
  WHEN (NEW.channel IS DISTINCT FROM 'internal_review' AND OLD.channel IS DISTINCT FROM 'internal_review')
  EXECUTE FUNCTION public.dispatch_workflow_database_webhook();
CREATE TRIGGER conversations_webhooks_delete AFTER DELETE ON public.conversations FOR EACH ROW
  WHEN (OLD.channel IS DISTINCT FROM 'internal_review') EXECUTE FUNCTION public.dispatch_workflow_database_webhook();

-- The service queue cannot use a review container as a channel proposal origin.
CREATE OR REPLACE FUNCTION public.connector_assert_approval_origin(p_site_id uuid, p_conversation_id uuid, p_agent_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.agents WHERE id=p_agent_id AND site_id=p_site_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid approval origin' USING ERRCODE='42501'; END IF;
  IF p_conversation_id IS NOT NULL THEN
    PERFORM 1 FROM public.conversations WHERE id=p_conversation_id AND site_id=p_site_id AND agent_id=p_agent_id
      AND channel IS DISTINCT FROM 'internal_review' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid approval origin' USING ERRCODE='42501'; END IF;
  END IF;
END $$;

-- Called only by the AFTER INSERT trigger inside the existing quota/idempotency
-- site lock, or by the migration while approval writes are locked. False means
-- unverified historical origin (skip); a new insert must instead roll back.
CREATE FUNCTION public.connector_attach_review_thread(a public.connector_action_approvals) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE instance_key uuid; owner_key uuid; connector_key uuid; thread uuid;
BEGIN
  BEGIN
    instance_key := (a.action#>>'{origin,instance_id}')::uuid;
    owner_key := (a.action#>>'{origin,user_id}')::uuid;
    connector_key := (a.action->>'connector_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RETURN false;
  END;
  PERFORM 1 FROM public.remote_instances i
    JOIN public.agents g ON g.site_id=i.site_id AND g.id=a.agent_id AND g.status='active'
    JOIN public.connectors c ON c.site_id=i.site_id AND c.id=connector_key
    WHERE i.site_id=a.site_id AND i.id=instance_key AND i.user_id=owner_key
      AND a.conversation_id IS NULL AND a.action#>>'{origin,kind}'='interactive'
      AND EXISTS (SELECT FROM public.connector_effective_site_access(a.site_id,i.user_id) WHERE can_view)
    FOR SHARE OF i,g,c;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT conversation_id INTO thread FROM public.connector_review_threads
    WHERE (site_id,instance_id,owner_id,agent_id)=(a.site_id,instance_key,owner_key,a.agent_id);
  IF NOT FOUND THEN
    thread := gen_random_uuid();
    INSERT INTO public.connector_review_threads(conversation_id,site_id,instance_id,owner_id,agent_id)
      VALUES(thread,a.site_id,instance_key,owner_key,a.agent_id);
    INSERT INTO public.conversations(id,site_id,user_id,agent_id,title,channel,custom_data,last_message_at)
      VALUES(thread,a.site_id,owner_key,a.agent_id,'Instance approvals','internal_review','{"channel":"internal_review"}',a.created_at);
  ELSE
    UPDATE public.conversations SET last_message_at=greatest(last_message_at,a.created_at),updated_at=now() WHERE id=thread;
  END IF;
  INSERT INTO public.connector_approval_review_links(approval_id,review_conversation_id) VALUES(a.id,thread);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.connector_attach_review_thread(public.connector_action_approvals) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.connector_link_review_on_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT public.connector_attach_review_thread(NEW) THEN
    RAISE EXCEPTION 'Invalid interactive approval origin' USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.connector_link_review_on_request() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER connector_link_interactive_approval AFTER INSERT ON public.connector_action_approvals FOR EACH ROW
  WHEN (NEW.action#>>'{origin,kind}'='interactive') EXECUTE FUNCTION public.connector_link_review_on_request();

DO $$ DECLARE a public.connector_action_approvals; BEGIN
  FOR a IN SELECT * FROM public.connector_action_approvals WHERE conversation_id IS NULL
    AND status='pending' AND expires_at > statement_timestamp() AND action#>>'{origin,kind}'='interactive'
    ORDER BY created_at,id LOOP
    PERFORM public.connector_attach_review_thread(a);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;