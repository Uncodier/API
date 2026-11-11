-- Forward-only, no backfill or replay. Package for public and existing app_* tenants.
-- Call only after verified live app-echo admission; these RPCs never send messages.
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_catalog.pg_namespace
    WHERE (nspname = 'public' OR nspname LIKE 'app\_%' ESCAPE '\')
      AND pg_catalog.to_regclass(format('%I.conversations', nspname)) IS NOT NULL
      AND pg_catalog.to_regclass(format('%I.messages', nspname)) IS NOT NULL
  LOOP
    IF to_regprocedure(format('%I.authorize_lead_site_snooze_write()', s)) IS NULL
      OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(format('%I.messages',s))
        AND tgname='conversation_automation_snooze_after_human_reply' AND NOT tgisinternal AND tgenabled <> 'D')
      OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(format('%I.conversations',s))
        AND tgname='conversation_snooze_write_authorization' AND NOT tgisinternal AND tgenabled <> 'D') THEN
      RAISE EXCEPTION 'Apply lead/site snooze predecessor before first-contact snooze in %', s;
    END IF;
    EXECUTE format($ddl$
      CREATE TABLE %1$I.conversation_automation_contacts (
        site_id uuid NOT NULL REFERENCES %1$I.sites(id) ON DELETE CASCADE,
        connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 200),
        sender_id text NOT NULL CHECK (sender_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
        recipient text NOT NULL CHECK (recipient ~ '^\+[1-9][0-9]{6,14}$'),
        -- Conversation deletion releases only the binding, never consumed receipts.
        -- Site deletion removes contacts and cascades their PII/event ledger below.
        conversation_id uuid REFERENCES %1$I.conversations(id) ON DELETE SET NULL,
        PRIMARY KEY (site_id, connection_id, sender_id, recipient)
      );
      CREATE TABLE %1$I.conversation_automation_events (
        id uuid PRIMARY KEY,
        site_id uuid NOT NULL,
        connection_id text NOT NULL,
        sender_id text NOT NULL,
        recipient text NOT NULL,
        provider_message_id text NOT NULL CHECK (length(btrim(provider_message_id)) BETWEEN 1 AND 200),
        event_at timestamptz NOT NULL CHECK (isfinite(event_at)),
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        content text NOT NULL CHECK (length(btrim(content)) > 0),
        metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
        snooze_hours numeric NOT NULL CHECK (snooze_hours >= 0 AND snooze_hours <= 168),
        applied_at timestamptz,
        FOREIGN KEY (site_id, connection_id, sender_id, recipient)
          REFERENCES %1$I.conversation_automation_contacts(site_id, connection_id, sender_id, recipient) ON DELETE CASCADE,
        UNIQUE (site_id, connection_id, sender_id, provider_message_id)
      );
      CREATE INDEX conversation_automation_events_pending ON %1$I.conversation_automation_events
        (site_id, connection_id, sender_id, recipient, event_at, id) WHERE applied_at IS NULL;
      -- Exact indexed identity lookups, never broad suffix searches or latest-row guesses.
      CREATE INDEX messages_automation_inbound_identity ON %1$I.messages
        ((custom_data->>'connection_id'), (custom_data->>'zavu_sender_id'),
         (custom_data->>'zavu_from'), conversation_id) WHERE role = 'user';
      ALTER TABLE %1$I.conversation_automation_contacts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE %1$I.conversation_automation_events ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON %1$I.conversation_automation_contacts, %1$I.conversation_automation_events
        FROM PUBLIC, anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE ON %1$I.conversation_automation_contacts, %1$I.conversation_automation_events TO service_role;
    $ddl$, s);

    EXECUTE format($ddl$
      CREATE FUNCTION %1$I.validate_conversation_automation_contact(
        p_site_id uuid, p_connection_id text, p_sender_id text, p_recipient text)
      RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
      DECLARE v_count integer; v_matches integer;
      BEGIN
        -- No JWT claim or caller-set GUC is an authority. Invoker retains all existing RLS.
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
          RAISE EXCEPTION 'Server-only automation registration' USING ERRCODE = '42501';
        END IF;
        IF p_site_id IS NULL OR p_connection_id IS NULL OR length(p_connection_id) NOT BETWEEN 1 AND 200
          OR p_sender_id IS NULL OR p_sender_id !~ '^[a-zA-Z0-9_-]{1,128}$'
          OR p_recipient IS NULL OR p_recipient !~ '^\+[1-9][0-9]{6,14}$' THEN
          RAISE EXCEPTION 'Invalid automation contact identity' USING ERRCODE = '22023';
        END IF;
        SELECT count(*), count(*) FILTER (WHERE st.site_id = p_site_id AND c->>'id' = p_connection_id)
          INTO v_count, v_matches
          FROM %1$I.settings st CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(st.channels->'connections') = 'array' THEN st.channels->'connections' ELSE '[]'::jsonb END) c
          WHERE c->>'type' = 'whatsapp' AND c->>'zavu_sender_id' = p_sender_id;
        IF v_count <> 1 OR v_matches <> 1 THEN
          RAISE EXCEPTION 'Connection ownership missing or ambiguous' USING ERRCODE = '42501';
        END IF;
      END $function$;

      CREATE FUNCTION %1$I.conversation_automation_frozen_hours(p_site_id uuid, p_conversation_id uuid)
      RETURNS numeric LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
      DECLARE v_hours numeric; v_activities jsonb; v_setting jsonb; v_lead uuid; v_lead_site uuid;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
          RAISE EXCEPTION 'Server-only automation policy' USING ERRCODE = '42501';
        END IF;
        IF p_conversation_id IS NOT NULL THEN
          SELECT lead_id INTO v_lead FROM %1$I.conversations WHERE id=p_conversation_id AND site_id=p_site_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Human reply requires an authorized conversation site' USING ERRCODE = '42501';
          END IF;
          IF v_lead IS NOT NULL THEN
            SELECT site_id,automation_snooze_hours INTO v_lead_site,v_hours FROM %1$I.leads WHERE id=v_lead;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'Human reply lead configuration is inaccessible' USING ERRCODE = '42501';
            END IF;
            IF v_lead_site IS DISTINCT FROM p_site_id THEN v_hours := NULL; END IF;
          END IF;
        END IF;
        IF v_hours IS NOT NULL THEN RETURN v_hours; END IF;
        BEGIN
          SELECT activities INTO STRICT v_activities FROM %1$I.settings WHERE site_id = p_site_id;
        EXCEPTION WHEN no_data_found THEN v_activities := NULL;
        END;
        IF v_activities IS NOT NULL AND jsonb_typeof(v_activities) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Settings activities must be an object' USING ERRCODE = '22023';
        END IF;
        v_setting := v_activities->'conversation_automation_snooze';
        IF v_setting IS NULL THEN RETURN 4; END IF;
        IF jsonb_typeof(v_setting) IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_setting->'status') IS DISTINCT FROM 'string'
          OR v_setting->>'status' NOT IN ('default','active','inactive')
          OR jsonb_typeof(v_setting->'hours') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'Invalid conversation automation snooze setting' USING ERRCODE = '22023';
        END IF;
        v_hours := (v_setting->>'hours')::numeric;
        IF v_hours <= 0 OR v_hours > 168 THEN
          RAISE EXCEPTION 'Invalid conversation automation snooze hours' USING ERRCODE = '22023';
        END IF;
        RETURN CASE WHEN v_setting->>'status' = 'inactive' THEN 0 ELSE v_hours END;
      END $function$;

      CREATE FUNCTION %1$I.reconcile_conversation_human_events(
        p_site_id uuid, p_connection_id text, p_sender_id text, p_recipient text, p_conversation_id uuid)
      RETURNS json LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
      DECLARE v_bound uuid; v_candidates uuid[]; e record; v_saved record; v_count integer := 0;
      BEGIN
        PERFORM %1$I.validate_conversation_automation_contact(p_site_id,p_connection_id,p_sender_id,p_recipient);
        INSERT INTO %1$I.conversation_automation_contacts(site_id,connection_id,sender_id,recipient)
          VALUES(p_site_id,p_connection_id,p_sender_id,p_recipient) ON CONFLICT DO NOTHING;
        SELECT conversation_id INTO v_bound FROM %1$I.conversation_automation_contacts
          WHERE site_id=p_site_id AND connection_id=p_connection_id AND sender_id=p_sender_id AND recipient=p_recipient FOR UPDATE;
        -- Keep the actual target site's ownership stable through message insertion.
        -- Lock order is always contact -> conversation, matching registration.
        PERFORM 1 FROM %1$I.conversations WHERE id=p_conversation_id AND site_id=p_site_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Conversation site mismatch' USING ERRCODE = '42501';
        END IF;
        SELECT array_agg(DISTINCT c.id) INTO v_candidates FROM %1$I.messages m
          JOIN %1$I.conversations c ON c.id=m.conversation_id
          WHERE c.site_id=p_site_id AND m.role='user'
            AND m.custom_data->>'connection_id'=p_connection_id AND m.custom_data->>'zavu_sender_id'=p_sender_id
            AND m.custom_data->>'zavu_from' IN (p_recipient,substring(p_recipient FROM 2),'whatsapp:'||p_recipient,'whatsapp:'||substring(p_recipient FROM 2));
        IF p_conversation_id IS NULL OR cardinality(v_candidates) IS DISTINCT FROM 1
          OR v_candidates[1] IS DISTINCT FROM p_conversation_id
          OR (v_bound IS NOT NULL AND v_bound <> p_conversation_id) THEN
          RAISE EXCEPTION 'Saved inbound contact identity missing, mismatched or ambiguous' USING ERRCODE = '42501';
        END IF;
        UPDATE %1$I.conversation_automation_contacts SET conversation_id=p_conversation_id
          WHERE site_id=p_site_id AND connection_id=p_connection_id AND sender_id=p_sender_id AND recipient=p_recipient;
        FOR e IN SELECT * FROM %1$I.conversation_automation_events
          WHERE site_id=p_site_id AND connection_id=p_connection_id AND sender_id=p_sender_id AND recipient=p_recipient
            AND applied_at IS NULL ORDER BY event_at,id
        LOOP
          INSERT INTO %1$I.messages(id,conversation_id,role,user_id,content,created_at,custom_data)
            VALUES(e.id,p_conversation_id,'team_member',NULL,e.content,e.event_at,
              (CASE WHEN e.metadata->>'message_type' IN ('note','internal_note') THEN e.metadata - 'message_type' ELSE e.metadata END
                - ARRAY['internal','is_internal','is_internal_note','type']) || jsonb_build_object(
                'source','whatsapp_business_app','origin','zavu','external_human',true,
                'external_message_id',e.provider_message_id,'origin_message_id',e.provider_message_id,
                'connection_id',p_connection_id,'zavu_sender_id',p_sender_id,'zavu_from',p_recipient,
                'channel','whatsapp','direction','outbound'))
            ON CONFLICT (id) DO NOTHING;
          -- Existing deterministic messages are consumed, never updated/re-triggered.
          SELECT * INTO STRICT v_saved FROM %1$I.messages WHERE id=e.id;
          IF v_saved.conversation_id IS DISTINCT FROM p_conversation_id OR v_saved.role IS DISTINCT FROM 'team_member'
            OR v_saved.user_id IS NOT NULL OR v_saved.content IS DISTINCT FROM e.content
            OR v_saved.custom_data->>'source' IS DISTINCT FROM 'whatsapp_business_app'
            OR v_saved.custom_data->>'external_message_id' IS DISTINCT FROM e.provider_message_id
            OR v_saved.custom_data->>'connection_id' IS DISTINCT FROM p_connection_id
            OR v_saved.custom_data->>'zavu_sender_id' IS DISTINCT FROM p_sender_id
            OR NOT COALESCE(v_saved.custom_data->>'zavu_from' IN (p_recipient,substring(p_recipient FROM 2),'whatsapp:'||p_recipient,'whatsapp:'||substring(p_recipient FROM 2)),false) THEN
            RAISE EXCEPTION 'Existing message scope conflict' USING ERRCODE = '23505';
          END IF;
          UPDATE %1$I.conversation_automation_events SET applied_at=clock_timestamp() WHERE id=e.id;
          v_count := v_count + 1;
        END LOOP;
        RETURN json_build_object('state','reconciled','conversation_id',p_conversation_id,'applied_count',v_count);
      END $function$;

      CREATE FUNCTION %1$I.register_conversation_human_event(
        p_site_id uuid,p_connection_id text,p_sender_id text,p_recipient text,p_message_id uuid,
        p_provider_message_id text,p_event_at timestamptz,p_content text,p_metadata jsonb)
      RETURNS json LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
      DECLARE v_bound uuid; v_candidates uuid[]; v_event record; v_hours numeric;
      BEGIN
        PERFORM %1$I.validate_conversation_automation_contact(p_site_id,p_connection_id,p_sender_id,p_recipient);
        IF p_message_id IS NULL OR p_provider_message_id IS NULL OR length(btrim(p_provider_message_id)) NOT BETWEEN 1 AND 200
          OR p_event_at IS NULL OR NOT isfinite(p_event_at) OR p_event_at <= '1970-01-01'::timestamptz
          OR p_content IS NULL OR length(btrim(p_content))=0 OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
          RAISE EXCEPTION 'Invalid human event' USING ERRCODE = '22023';
        END IF;
        INSERT INTO %1$I.conversation_automation_contacts(site_id,connection_id,sender_id,recipient)
          VALUES(p_site_id,p_connection_id,p_sender_id,p_recipient) ON CONFLICT DO NOTHING;
        SELECT conversation_id INTO v_bound FROM %1$I.conversation_automation_contacts
          WHERE site_id=p_site_id AND connection_id=p_connection_id AND sender_id=p_sender_id AND recipient=p_recipient FOR UPDATE;
        SELECT * INTO v_event FROM %1$I.conversation_automation_events WHERE id=p_message_id
          OR (site_id=p_site_id AND connection_id=p_connection_id AND sender_id=p_sender_id AND provider_message_id=p_provider_message_id);
        IF FOUND THEN
          IF v_event.id IS DISTINCT FROM p_message_id OR v_event.site_id IS DISTINCT FROM p_site_id
            OR v_event.connection_id IS DISTINCT FROM p_connection_id OR v_event.sender_id IS DISTINCT FROM p_sender_id
            OR v_event.recipient IS DISTINCT FROM p_recipient OR v_event.provider_message_id IS DISTINCT FROM p_provider_message_id
            OR v_event.content IS DISTINCT FROM p_content THEN
            RAISE EXCEPTION 'Human event identity conflict' USING ERRCODE = '23505';
          END IF;
          RETURN json_build_object('state','duplicate','conversation_id',v_bound);
        END IF;
        SELECT array_agg(DISTINCT c.id) INTO v_candidates FROM %1$I.messages m
          JOIN %1$I.conversations c ON c.id=m.conversation_id
          WHERE c.site_id=p_site_id AND m.role='user'
            AND m.custom_data->>'connection_id'=p_connection_id AND m.custom_data->>'zavu_sender_id'=p_sender_id
            AND m.custom_data->>'zavu_from' IN (p_recipient,substring(p_recipient FROM 2),'whatsapp:'||p_recipient,'whatsapp:'||substring(p_recipient FROM 2));
        IF cardinality(v_candidates)>1 OR (v_bound IS NOT NULL AND v_bound IS DISTINCT FROM v_candidates[1]) THEN
          RAISE EXCEPTION 'Ambiguous or stale conversation binding' USING ERRCODE = '42501';
        END IF;
        v_bound := v_candidates[1];
        IF v_bound IS NOT NULL THEN
          PERFORM 1 FROM %1$I.conversations WHERE id=v_bound AND site_id=p_site_id FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Conversation site mismatch' USING ERRCODE = '42501';
          END IF;
        END IF;
        v_hours := %1$I.conversation_automation_frozen_hours(p_site_id,v_bound);
        INSERT INTO %1$I.conversation_automation_events(id,site_id,connection_id,sender_id,recipient,provider_message_id,event_at,content,metadata,snooze_hours)
          VALUES(p_message_id,p_site_id,p_connection_id,p_sender_id,p_recipient,p_provider_message_id,
            LEAST(p_event_at,clock_timestamp()),p_content,p_metadata,v_hours);
        IF v_bound IS NOT NULL THEN
          PERFORM %1$I.reconcile_conversation_human_events(p_site_id,p_connection_id,p_sender_id,p_recipient,v_bound);
          RETURN json_build_object('state','applied','conversation_id',v_bound);
        END IF;
        RETURN json_build_object('state','pending','conversation_id',NULL);
      END $function$;
    $ddl$, s);

    -- Trigger replacement below retains the editor authorization and non-ledger policy.
    -- Frozen values are obtained only from the server-only ledger, never message metadata.
    EXECUTE format($ddl$
      CREATE OR REPLACE FUNCTION %1$I.snooze_conversation_after_human_reply()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
      AS $function$
      DECLARE
        v_human_at timestamptz; v_previous_at timestamptz;
        v_site uuid; v_lead uuid; v_lead_site uuid; v_hours numeric;
        v_setting jsonb; v_activities jsonb; v_rls text;
      BEGIN
        IF NEW.role IS DISTINCT FROM 'team_member'
          OR NEW.custom_data->>'internal' = 'true'
          OR NEW.custom_data->>'is_internal' = 'true'
          OR NEW.custom_data->>'is_internal_note' = 'true'
          OR NEW.custom_data->>'type' IN ('note', 'internal_note')
          OR NEW.custom_data->>'message_type' IN ('note', 'internal_note')
        THEN RETURN NEW; END IF;
        v_human_at := LEAST(COALESCE(NEW.created_at, statement_timestamp()), statement_timestamp());
        SELECT last_human_reply_at, site_id, lead_id INTO v_previous_at, v_site, v_lead
          FROM %1$I.conversations WHERE id = NEW.conversation_id FOR UPDATE;
        IF NOT FOUND OR v_site IS NULL THEN
          RAISE EXCEPTION 'Human reply requires an authorized conversation site' USING ERRCODE = '42501';
        END IF;
        IF v_previous_at IS NOT NULL AND v_human_at <= v_previous_at THEN RETURN NEW; END IF;
        -- Only trusted database invokers can read server-only policy. Client metadata
        -- and custom GUCs never authorize a frozen duration or bypass existing guards.
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
          SELECT e.snooze_hours INTO v_hours
            FROM %1$I.conversation_automation_events e
            JOIN %1$I.conversation_automation_contacts c USING(site_id,connection_id,sender_id,recipient)
            WHERE e.id=NEW.id AND e.applied_at IS NULL AND e.site_id=v_site
              AND c.conversation_id=NEW.conversation_id AND e.event_at=NEW.created_at
              AND e.content=NEW.content;
        END IF;
        IF v_hours IS NULL AND v_lead IS NOT NULL THEN
          SELECT site_id, automation_snooze_hours INTO v_lead_site, v_hours
            FROM %1$I.leads WHERE id = v_lead;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Human reply lead configuration is inaccessible' USING ERRCODE = '42501';
          END IF;
          -- A cross-site link never imports another customer's override.
          IF v_lead_site IS DISTINCT FROM v_site THEN v_hours := NULL; END IF;
        END IF;
        IF v_hours IS NULL THEN
          BEGIN
            SELECT activities INTO STRICT v_activities
              FROM %1$I.settings WHERE site_id = v_site;
            -- STRICT rejects duplicate settings as ambiguous, too.
            IF v_activities IS NOT NULL AND jsonb_typeof(v_activities) IS DISTINCT FROM 'object' THEN
              RAISE EXCEPTION 'Settings activities must be an object' USING ERRCODE = '22023';
            END IF;
            v_setting := v_activities->'conversation_automation_snooze';
          EXCEPTION WHEN no_data_found THEN
            -- row_security=off is NOT a bypass: PostgreSQL errors if RLS could
            -- filter this read. Only a provably absent row may use default ON4.
            -- Keep the original invoker and restore its setting after the probe.
            v_rls := current_setting('row_security');
            PERFORM set_config('row_security', 'off', true);
            PERFORM 1 FROM %1$I.settings WHERE site_id = v_site;
            PERFORM set_config('row_security', v_rls, true);
            v_setting := NULL;
          END;
        END IF;
        IF v_hours IS NULL THEN
          IF v_setting IS NULL THEN v_hours := 4;
          ELSE
            IF jsonb_typeof(v_setting) IS DISTINCT FROM 'object'
              OR jsonb_typeof(v_setting->'status') IS DISTINCT FROM 'string'
              OR v_setting->>'status' NOT IN ('default','active','inactive')
              OR jsonb_typeof(v_setting->'hours') IS DISTINCT FROM 'number' THEN
              RAISE EXCEPTION 'Invalid conversation automation snooze setting' USING ERRCODE = '22023';
            END IF;
            v_hours := (v_setting->>'hours')::numeric;
            IF v_hours <= 0 OR v_hours > 168 THEN
              RAISE EXCEPTION 'Invalid conversation automation snooze hours' USING ERRCODE = '22023';
            END IF;
            IF v_setting->>'status' = 'inactive' THEN v_hours := 0; END IF;
          END IF;
        END IF;
        UPDATE %1$I.conversations SET last_human_reply_at = v_human_at,
          automation_paused_until = CASE WHEN v_hours = 0 THEN automation_paused_until
            ELSE GREATEST(automation_paused_until, v_human_at + v_hours * interval '1 hour') END
          WHERE id = NEW.conversation_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Human reply requires conversation update authorization' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END
      $function$;
    $ddl$, s);


    EXECUTE format('REVOKE ALL ON FUNCTION %1$I.validate_conversation_automation_contact(uuid,text,text,text),
      %1$I.conversation_automation_frozen_hours(uuid,uuid),
      %1$I.register_conversation_human_event(uuid,text,text,text,uuid,text,timestamptz,text,jsonb),
      %1$I.reconcile_conversation_human_events(uuid,text,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %1$I.validate_conversation_automation_contact(uuid,text,text,text),
      %1$I.conversation_automation_frozen_hours(uuid,uuid),
      %1$I.register_conversation_human_event(uuid,text,text,text,uuid,text,timestamptz,text,jsonb),
      %1$I.reconcile_conversation_human_events(uuid,text,text,text,uuid) TO service_role', s);
  END LOOP;
END
$migration$;