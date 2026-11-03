-- Forward-only replacement: existing shared triggers (including procurement)
-- keep their ingress and gain one immutable identity per queued mutation.
-- Retries must replay the queued payload, not generate a new event_id.
BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_workflow_database_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  webhook_url text;
  webhook_api_key text;
  webhook_headers jsonb;
  webhook_payload jsonb;
  webhook_event_id uuid;
BEGIN
  SELECT secret.decrypted_secret
  INTO webhook_url
  FROM vault.decrypted_secrets AS secret
  WHERE secret.name = 'workflow_webhook_url'
  LIMIT 1;

  SELECT secret.decrypted_secret
  INTO webhook_api_key
  FROM vault.decrypted_secrets AS secret
  WHERE secret.name = 'workflow_webhook_api_key'
  LIMIT 1;

  IF webhook_url IS NULL OR btrim(webhook_url) = '' THEN
    RAISE WARNING
      'Skipping workflow webhook for %.% because workflow_webhook_url is not configured in Vault',
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  webhook_headers := jsonb_build_object('Content-Type', 'application/json');
  IF webhook_api_key IS NOT NULL AND btrim(webhook_api_key) <> '' THEN
    webhook_headers := webhook_headers
      || jsonb_build_object('x-api-key', webhook_api_key);
  END IF;

  webhook_event_id := pg_catalog.gen_random_uuid();
  webhook_payload := jsonb_build_object(
    'event_id', webhook_event_id,
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE
      WHEN TG_OP = 'DELETE' THEN 'null'::jsonb
      ELSE to_jsonb(NEW)
    END,
    'old_record', CASE
      WHEN TG_OP = 'INSERT' THEN 'null'::jsonb
      ELSE to_jsonb(OLD)
    END
  );

  PERFORM net.http_post(
    url := webhook_url,
    body := webhook_payload,
    params := '{}'::jsonb,
    headers := webhook_headers,
    timeout_milliseconds := 5000
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- net errors can include credential-bearing URLs/headers. Never log SQLERRM.
    RAISE WARNING
      'Could not enqueue workflow webhook for %.% (SQLSTATE %)',
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME,
      SQLSTATE;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_workflow_database_webhook()
  FROM PUBLIC, anon, authenticated;

COMMIT;