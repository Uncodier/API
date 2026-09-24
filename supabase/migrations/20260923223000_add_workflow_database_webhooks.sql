-- Rollback:
-- DROP TRIGGER IF EXISTS leads_webhooks ON public.leads;
-- DROP TRIGGER IF EXISTS deals_webhooks ON public.deals;
-- DROP TRIGGER IF EXISTS conversations_webhooks ON public.conversations;
-- DROP TRIGGER IF EXISTS tasks_webhooks ON public.tasks;
-- DROP TRIGGER IF EXISTS quotations_webhooks ON public.quotations;
-- DROP TRIGGER IF EXISTS reservations_webhooks ON public.reservations;
-- DROP TRIGGER IF EXISTS content_webhooks ON public.content;
-- DROP TRIGGER IF EXISTS sales_webhooks ON public.sales;
-- DROP FUNCTION IF EXISTS public.dispatch_workflow_database_webhook();
--
-- Configure each environment without committing credentials:
-- SELECT vault.create_secret(
--   'https://backend.example.com/api/workflow/webhook',
--   'workflow_webhook_url'
-- );
-- SELECT vault.create_secret(
--   '<service-api-key>',
--   'workflow_webhook_api_key'
-- );

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

  webhook_payload := jsonb_build_object(
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
    RAISE WARNING
      'Could not enqueue workflow webhook for %.%: %',
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME,
      SQLERRM;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_workflow_database_webhook()
  FROM PUBLIC, anon, authenticated;

DO $migration$
DECLARE
  target_table text;
  target_trigger text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'leads',
    'deals',
    'conversations',
    'tasks',
    'quotations',
    'reservations',
    'content',
    'sales'
  ]
  LOOP
    IF to_regclass(format('public.%I', target_table)) IS NULL THEN
      RAISE EXCEPTION 'Required webhook table public.% does not exist', target_table;
    END IF;

    target_trigger := target_table || '_webhooks';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target_trigger, target_table);
    EXECUTE format(
      'CREATE TRIGGER %I '
      || 'AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION public.dispatch_workflow_database_webhook()',
      target_trigger,
      target_table
    );
  END LOOP;
END;
$migration$;
