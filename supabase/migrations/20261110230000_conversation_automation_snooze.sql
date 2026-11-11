-- Deploy before enabling conversation snooze readers/writers. No historical backfill.
-- This operator migration covers existing public/app_* schemas with chat tables.
-- New tenant provisioning must include equivalent schema-local DDL.
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_catalog.pg_namespace
    WHERE (nspname = 'public' OR nspname LIKE 'app\_%' ESCAPE '\')
      AND pg_catalog.to_regclass(format('%I.conversations', nspname)) IS NOT NULL
      AND pg_catalog.to_regclass(format('%I.messages', nspname)) IS NOT NULL
  LOOP
    EXECUTE format('ALTER TABLE %I.conversations
      ADD COLUMN automation_paused_until timestamptz,
      ADD COLUMN last_human_reply_at timestamptz,
      ADD COLUMN automation_snooze_hours numeric,
      ADD CONSTRAINT conversations_automation_snooze_hours_check
        CHECK (automation_snooze_hours >= 0 AND automation_snooze_hours <= 168)', s);
    -- Existing broad conversation RLS grants must not authorize snooze writes
    -- by read-only members. Keep unrelated column updates under existing RLS.
    EXECUTE format($ddl$
      CREATE FUNCTION %1$I.authorize_conversation_snooze_write()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog
      AS $function$
      DECLARE v_allowed boolean;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.automation_paused_until IS NOT DISTINCT FROM OLD.automation_paused_until
            AND NEW.automation_snooze_hours IS NOT DISTINCT FROM OLD.automation_snooze_hours
            AND NEW.last_human_reply_at IS NOT DISTINCT FROM OLD.last_human_reply_at
          THEN RETURN NEW; END IF;
        ELSIF NEW.automation_paused_until IS NULL AND NEW.automation_snooze_hours IS NULL
          AND NEW.last_human_reply_at IS NULL THEN RETURN NEW;
        END IF;
        -- Only actual privileged database roles bypass authorization, never JWT
        -- metadata or a caller-set custom session variable.
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls))
          THEN RETURN NEW; END IF;
        IF current_user <> 'authenticated' OR auth.uid() IS NULL THEN
          RAISE EXCEPTION 'Snooze changes require an authenticated editor' USING ERRCODE = '42501';
        END IF;
        IF to_regprocedure('%1$I.user_can(uuid,text)') IS NULL THEN
          RAISE EXCEPTION 'Snooze authorization is unavailable' USING ERRCODE = '42501';
        END IF;
        EXECUTE 'SELECT %1$I.user_can($1, $2)' INTO v_allowed USING NEW.site_id, 'update';
        IF v_allowed IS DISTINCT FROM true THEN
          RAISE EXCEPTION 'Snooze changes require conversation update permission' USING ERRCODE = '42501';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          EXECUTE 'SELECT %1$I.user_can($1, $2)' INTO v_allowed USING OLD.site_id, 'update';
          IF v_allowed IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'Snooze changes require original site permission' USING ERRCODE = '42501';
          END IF;
          -- A direct client UPDATE cannot forge/reset the human watermark.
          -- Nested human-message trigger updates still run as the same editor.
          IF NEW.last_human_reply_at IS DISTINCT FROM OLD.last_human_reply_at AND pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'Human reply time is maintained by message ingestion' USING ERRCODE = '42501';
          END IF;
        ELSIF NEW.last_human_reply_at IS NOT NULL THEN
          RAISE EXCEPTION 'Human reply time is maintained by message ingestion' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END
      $function$;
    $ddl$, s);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.authorize_conversation_snooze_write() FROM PUBLIC, anon, authenticated, service_role', s);
    EXECUTE format('CREATE TRIGGER conversation_snooze_write_authorization
      BEFORE INSERT OR UPDATE ON %I.conversations FOR EACH ROW
      EXECUTE FUNCTION %I.authorize_conversation_snooze_write()', s, s);
    EXECUTE format($ddl$
      CREATE FUNCTION %1$I.snooze_conversation_after_human_reply()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        v_human_at timestamptz;
        v_previous_at timestamptz;
        v_hours numeric;
      BEGIN
        -- Pending sends pause immediately. Failed sends remain paused until expiry
        -- or explicit resume. Delivery-state UPDATEs never run this trigger.
        IF NEW.role IS DISTINCT FROM 'team_member'
          OR NEW.custom_data->>'internal' = 'true'
          OR NEW.custom_data->>'is_internal' = 'true'
          OR NEW.custom_data->>'is_internal_note' = 'true'
          OR NEW.custom_data->>'type' IN ('note', 'internal_note')
          OR NEW.custom_data->>'message_type' IN ('note', 'internal_note')
        THEN RETURN NEW; END IF;

        -- Clamp future provider clocks; old history retains its original time and
        -- cannot create a fresh four-hour pause starting at ingestion time.
        v_human_at := LEAST(COALESCE(NEW.created_at, statement_timestamp()), statement_timestamp());
        -- Row lock serializes human inserts with resume/configuration updates.
        -- The schema is bound at migration time, never from caller search_path.
        SELECT last_human_reply_at, COALESCE(automation_snooze_hours, 4)
          INTO v_previous_at, v_hours
          FROM %1$I.conversations WHERE id = NEW.conversation_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Human reply requires an authorized conversation'
            USING ERRCODE = '42501';
        END IF;
        -- Out-of-order history/duplicate echoes cannot undo a manual resume.
        IF v_previous_at IS NOT NULL AND v_human_at <= v_previous_at THEN
          RETURN NEW;
        END IF;
        UPDATE %1$I.conversations
          SET last_human_reply_at = GREATEST(last_human_reply_at, v_human_at),
              automation_paused_until = CASE WHEN v_hours = 0 THEN automation_paused_until
                ELSE GREATEST(automation_paused_until, v_human_at + v_hours * interval '1 hour') END
          WHERE id = NEW.conversation_id;
        -- RLS UPDATE can filter a row without throwing. Do not commit a human
        -- message that should pause but could not update its conversation.
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Human reply requires conversation update authorization'
            USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END
      $function$;
    $ddl$, s);
    -- Trigger execution does not require a client EXECUTE grant. No callable RPC,
    -- security-definer escalation, table grants or RLS-policy changes are added.
    EXECUTE format('REVOKE ALL ON FUNCTION %I.snooze_conversation_after_human_reply() FROM PUBLIC, anon, authenticated, service_role', s);
    EXECUTE format('CREATE TRIGGER conversation_automation_snooze_after_human_reply
      AFTER INSERT ON %I.messages FOR EACH ROW
      EXECUTE FUNCTION %I.snooze_conversation_after_human_reply()', s, s);
    EXECUTE format('COMMENT ON COLUMN %I.conversations.automation_snooze_hours IS %L', s,
      'Human reply snooze override in hours: NULL = 4 hours, 0 = disabled, maximum 168. Disabling an active snooze also requires clearing automation_paused_until.');
  END LOOP;
END
$migration$;