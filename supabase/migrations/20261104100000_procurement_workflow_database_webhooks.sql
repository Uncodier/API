BEGIN;

-- Requires the canonical market-fit procurement migrations and the existing
-- 20260923223000 workflow database webhook migration. Reuse its Vault-backed
-- authenticated ingress; do not emit additional events from the MCP adapter.
-- Quotations, sealed submissions, credentials, audit tables and internal queues
-- are deliberately excluded. This does not bypass procurement approval policy.
-- Rollback: drop only the <table>_webhooks triggers installed below.
DO $migration$
DECLARE
  target_table text;
  target_trigger text;
BEGIN
  IF to_regprocedure('public.dispatch_workflow_database_webhook()') IS NULL THEN
    RAISE EXCEPTION 'Workflow database webhook function is required';
  END IF;

  FOREACH target_table IN ARRAY ARRAY[
    'suppliers',
    'supplier_contacts',
    'catalog_item_suppliers',
    'procurement_requests',
    'procurement_tenders',
    'procurement_tender_publications',
    'procurement_tender_participants',
    'procurement_event_approvals',
    'procurement_awards',
    'purchase_orders',
    'procurement_receipts',
    'procurement_replenishment_rules',
    'procurement_replenishment_cases'
  ] LOOP
    IF to_regclass(format('public.%I', target_table)) IS NULL THEN
      RAISE EXCEPTION 'Required procurement webhook table public.% does not exist', target_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass(format('public.%I', target_table))
        AND attname = 'site_id' AND NOT attisdropped
        AND atttypid = 'uuid'::regtype
    ) THEN
      RAISE EXCEPTION 'Required procurement webhook table public.% must have a uuid site_id', target_table;
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

COMMIT;