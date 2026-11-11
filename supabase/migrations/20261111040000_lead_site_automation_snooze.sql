-- Forward-only: requires 20261110230000. Never copies deprecated conversation
-- overrides or rewrites active expiry. Configuration affects future human turns.
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_catalog.pg_namespace
    WHERE (nspname = 'public' OR nspname LIKE 'app\_%' ESCAPE '\')
      AND pg_catalog.to_regclass(format('%I.conversations', nspname)) IS NOT NULL
      AND pg_catalog.to_regclass(format('%I.messages', nspname)) IS NOT NULL
  LOOP
    -- Missing prerequisites deliberately abort rather than leave a tenant on old policy.
    IF (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass(format('%I.conversations', s))
      AND NOT attisdropped AND attname IN ('automation_paused_until','last_human_reply_at','automation_snooze_hours','lead_id')) <> 4
      OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(format('%I.messages', s))
        AND tgname = 'conversation_automation_snooze_after_human_reply' AND NOT tgisinternal)
      OR to_regprocedure(format('%I.authorize_conversation_snooze_write()', s)) IS NULL THEN
      RAISE EXCEPTION 'Apply conversation snooze predecessor and lead linkage before lead/site policy in %', s;
    END IF;
    EXECUTE format('ALTER TABLE %I.leads ADD COLUMN IF NOT EXISTS automation_snooze_hours numeric', s);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I.leads', s))
      AND conname = 'leads_automation_snooze_hours_check') THEN
      EXECUTE format('ALTER TABLE %I.leads ADD CONSTRAINT leads_automation_snooze_hours_check
        CHECK (automation_snooze_hours >= 0 AND automation_snooze_hours <= 168)', s);
    END IF;
    EXECUTE format($ddl$
      CREATE OR REPLACE FUNCTION %1$I.authorize_lead_site_snooze_write()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
      AS $function$
      DECLARE v_new jsonb; v_old jsonb; v_allowed boolean;
      BEGIN
        IF TG_TABLE_NAME = 'settings' THEN
          IF NEW.activities IS NOT NULL AND jsonb_typeof(NEW.activities) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'Settings activities must be an object' USING ERRCODE = '22023';
          END IF;
          v_new := NEW.activities->'conversation_automation_snooze';
          IF TG_OP = 'UPDATE' THEN v_old := OLD.activities->'conversation_automation_snooze'; END IF;
          IF v_new IS NOT NULL THEN
            IF jsonb_typeof(v_new) IS DISTINCT FROM 'object'
              OR jsonb_typeof(v_new->'status') IS DISTINCT FROM 'string'
              OR v_new->>'status' NOT IN ('default','active','inactive')
              OR jsonb_typeof(v_new->'hours') IS DISTINCT FROM 'number' THEN
              RAISE EXCEPTION 'Invalid conversation automation snooze setting' USING ERRCODE = '22023';
            END IF;
            IF (v_new->>'hours')::numeric <= 0 OR (v_new->>'hours')::numeric > 168 THEN
              RAISE EXCEPTION 'Snooze hours must be positive and at most 168' USING ERRCODE = '22023';
            END IF;
          END IF;
        ELSE
          v_new := to_jsonb(NEW.automation_snooze_hours);
          IF TG_OP = 'UPDATE' THEN v_old := to_jsonb(OLD.automation_snooze_hours); END IF;
        END IF;
        IF v_new IS NOT DISTINCT FROM v_old THEN
          IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
          IF NEW.site_id IS NOT DISTINCT FROM OLD.site_id THEN RETURN NEW; END IF;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls))
          THEN RETURN NEW; END IF;
        IF current_user <> 'authenticated' OR auth.uid() IS NULL
          OR to_regprocedure('%1$I.user_can(uuid,text)') IS NULL THEN
          RAISE EXCEPTION 'Snooze authorization unavailable' USING ERRCODE = '42501';
        END IF;
        EXECUTE 'SELECT %1$I.user_can($1,$2)' INTO v_allowed USING NEW.site_id, 'update';
        IF v_allowed IS DISTINCT FROM true THEN
          RAISE EXCEPTION 'Snooze requires site update permission' USING ERRCODE = '42501';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          EXECUTE 'SELECT %1$I.user_can($1,$2)' INTO v_allowed USING OLD.site_id, 'update';
          IF v_allowed IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'Snooze requires original site update permission' USING ERRCODE = '42501';
          END IF;
        END IF;
        RETURN NEW;
      END
      $function$;
    $ddl$, s);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.authorize_lead_site_snooze_write() FROM PUBLIC, anon, authenticated, service_role', s);
    EXECUTE format('DROP TRIGGER IF EXISTS lead_snooze_write_authorization ON %I.leads', s);
    EXECUTE format('CREATE TRIGGER lead_snooze_write_authorization BEFORE INSERT OR UPDATE ON %I.leads
      FOR EACH ROW EXECUTE FUNCTION %I.authorize_lead_site_snooze_write()', s, s);
    EXECUTE format('DROP TRIGGER IF EXISTS site_snooze_write_authorization ON %I.settings', s);
    EXECUTE format('CREATE TRIGGER site_snooze_write_authorization BEFORE INSERT OR UPDATE ON %I.settings
      FOR EACH ROW EXECUTE FUNCTION %I.authorize_lead_site_snooze_write()', s, s);
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
        IF v_lead IS NOT NULL THEN
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
    EXECUTE format('REVOKE ALL ON FUNCTION %I.snooze_conversation_after_human_reply() FROM PUBLIC, anon, authenticated, service_role', s);
    EXECUTE format('COMMENT ON COLUMN %I.conversations.automation_snooze_hours IS %L', s,
      'Deprecated: no longer controls duration. Retained without migration of conflicting customer values. Use leads.automation_snooze_hours or settings.activities.conversation_automation_snooze.');
    EXECUTE format('COMMENT ON COLUMN %I.leads.automation_snooze_hours IS %L', s,
      'NULL inherits site default (missing setting ON 4h), 0 disables future snoozes, positive through 168 overrides. Does not clear current expiry; explicit resume required.');
  END LOOP;
END
$migration$;