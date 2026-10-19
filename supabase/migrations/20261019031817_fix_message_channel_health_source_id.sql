-- Target: Makinari. Preserve the trigger's authorization/configuration checks.
-- Parenthesize JSON extraction before text concatenation to avoid SQLSTATE 42883.
-- Rollback: restore the previous function definition (including the faulty expression).
CREATE OR REPLACE FUNCTION public.observe_message_channel_health()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_site uuid;
  v_channel text;
  v_config jsonb;
  v_channel_config jsonb;
  v_direction text;
  v_outcome text;
  v_error text;
  v_class text;
  v_source_id uuid;
BEGIN
  -- messages/settings permit client writes. A client must not manufacture
  -- provider observations in custom_data. SET ROLE is privilege-checked;
  -- the JWT claim GUC is not. SECURITY DEFINER also changes current_user.
  IF session_user NOT IN ('postgres', 'service_role')
     AND current_setting('role', true) IS DISTINCT FROM 'service_role'
  THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.custom_data IS NOT DISTINCT FROM OLD.custom_data THEN RETURN NEW; END IF;
  END IF;
  SELECT site_id, channel INTO v_site, v_channel FROM public.conversations WHERE id = NEW.conversation_id;
  IF v_site IS NULL THEN RETURN NEW; END IF;

  IF NEW.role = 'user' THEN
    v_direction := 'inbound';
    v_outcome := 'success'; -- Ingestion into messages succeeded, not AI processing.
    v_channel := coalesce(NEW.custom_data->>'channel', v_channel);
    IF TG_OP = 'UPDATE' OR v_channel IS NULL OR v_channel NOT IN ('email', 'whatsapp') THEN RETURN NEW; END IF;
    -- A successful API ingestion is not evidence the provider's webhook
    -- works unless it carries a stable provider-origin message identifier.
    IF coalesce(NEW.custom_data->>'origin_message_id', '') = ''
       OR NEW.custom_data->>'status' = 'failed' THEN RETURN NEW; END IF;
  ELSIF NEW.role IN ('assistant', 'agent') THEN
    v_direction := 'outbound';
    v_channel := coalesce(NEW.custom_data#>>'{delivery,channel}', NEW.custom_data->>'channel', v_channel);
    IF NEW.custom_data#>>'{delivery,success}' = 'true'
       AND NEW.custom_data->>'status' IN ('sent', 'delivered') THEN
      v_outcome := 'success';
    ELSIF NEW.custom_data#>>'{delivery,success}' = 'false'
          AND NEW.custom_data->>'status' = 'failed' THEN
      v_outcome := 'failure';
      v_error := lower(left(coalesce(NEW.custom_data#>>'{delivery,details,error}',
                                    NEW.custom_data->>'error_message', ''), 300));
      v_class := CASE
        WHEN v_error ~ '(invalid (phone|email|address|recipient)|no (phone|email)|unsubscrib|bounce|unknown recipient)' THEN 'recipient'
        WHEN v_error ~ '(template|content|placeholder|approval|no valid channels)' THEN 'content'
        WHEN v_error ~ '(unauthoriz|forbidden|authentication|credential|invalid api key|expired token|smtp auth|(^|[^0-9])(401|403)([^0-9]|$))' THEN 'auth'
        WHEN v_error ~ '(rate.limit|timeout|timed out|econnreset|econnrefused|etimedout|service unavailable|(^|[^0-9])(429|5[0-9][0-9])([^0-9]|$))' THEN 'provider'
        ELSE 'unknown'
      END;
    ELSE RETURN NEW; END IF;
  ELSE RETURN NEW; END IF;

  -- A provider-origin id is not the same thing as an AI/customer-support run.
  -- Only the initial persisted inbound message can establish inbound traffic.
  -- This is a health observation for a configured channel, not an arbitrary
  -- conversation label. Reconfiguration requires fresh evidence.
  IF v_channel IN ('email', 'whatsapp') THEN
    -- Serialize with settings reconfiguration (same lock order: settings,
    -- then channel_health), so an in-flight send cannot bless old credentials.
    SELECT channels INTO v_config
    FROM public.settings WHERE site_id = v_site FOR SHARE;
    IF v_config IS NULL OR jsonb_typeof(v_config) <> 'object' THEN RETURN NEW; END IF;
    IF v_channel = 'email' THEN
      v_channel_config := v_config->'email';
      IF NOT coalesce((
        (v_channel_config->>'enabled' = 'true' AND v_channel_config->>'status' IN ('active', 'synced')
         AND (nullif(v_channel_config->>'email', '') IS NOT NULL
              OR nullif(v_channel_config->'aliases', 'null'::jsonb) IS NOT NULL))
        OR (v_config->'agent'->>'enabled' = 'true' AND v_config->'agent'->>'status' = 'active')
        OR (coalesce(v_config->'agent_mail'->>'enabled', v_config->'agent_email'->>'enabled', 'true') <> 'false'
            AND coalesce(v_config->'agent_mail'->>'status', v_config->'agent_email'->>'status') IN ('active', 'synced'))
      ), false) THEN RETURN NEW; END IF;
    ELSE
      v_channel_config := coalesce(v_config->'whatsapp', v_config->'agent_whatsapp');
      IF NOT coalesce(
        v_channel_config->>'enabled' IS DISTINCT FROM 'false'
        AND v_channel_config->>'status' = 'active'
        AND coalesce(v_channel_config->>'phone_number', v_channel_config->>'existingNumber',
                     v_channel_config->>'number', v_channel_config->>'phone') IS NOT NULL,
        false
      ) THEN RETURN NEW; END IF;
    END IF;

    -- Stable provider messages can be ingested more than once under different
    -- local message IDs. UUIDv5 deduplicates those deliveries without storing
    -- the raw provider identifier in a public health table.
    v_source_id := NEW.id;
    IF v_direction = 'inbound' AND NEW.custom_data->>'origin_message_id' IS NOT NULL THEN
      v_source_id := extensions.uuid_generate_v5(
        '8fb3f7a7-d174-4643-9ad7-cc0d73dba845'::uuid,
        v_site::text || ':' || v_channel || ':' || (NEW.custom_data->>'origin_message_id')
      );
    END IF;
    PERFORM public.record_channel_health_event(v_site, v_channel, v_direction,
      v_source_id, v_outcome, v_class);
  END IF;
  RETURN NEW;
END;
$function$;
