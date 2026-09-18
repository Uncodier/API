-- Rollback:
-- DROP TRIGGER IF EXISTS preserve_sale_order_creator ON public.sale_orders;
-- DROP FUNCTION IF EXISTS public.preserve_sale_order_creator();
-- DROP INDEX IF EXISTS public.sale_orders_site_requested_by_idx;
-- DROP INDEX IF EXISTS public.sale_orders_site_seller_idx;
-- DROP INDEX IF EXISTS public.sale_orders_site_created_by_idx;
-- ALTER TABLE public.sale_orders
--   DROP COLUMN IF EXISTS requested_by_lead_id,
--   DROP COLUMN IF EXISTS seller_user_id,
--   DROP COLUMN IF EXISTS created_by_user_id;

-- Structured attribution for orders. These fields intentionally remain
-- separate from workflow assignment and from unvalidated JSON metadata.
ALTER TABLE public.sale_orders
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS seller_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requested_by_lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sale_orders.created_by_user_id IS
  'Authenticated actor who originally created the order. Immutable after creation.';
COMMENT ON COLUMN public.sale_orders.seller_user_id IS
  'Site employee credited with handling the order. Independent from workflow assignment.';
COMMENT ON COLUMN public.sale_orders.requested_by_lead_id IS
  'Lead or customer who requested the order.';

-- Allow an interrupted or manually applied migration to finish its backfill
-- before restoring creator immutability.
DROP TRIGGER IF EXISTS preserve_sale_order_creator ON public.sale_orders;

-- Existing POS rows used user_id for the acting cashier. Do not backfill
-- storefront rows because their user_id commonly represents the site owner.
UPDATE public.sale_orders AS orders
SET
  created_by_user_id = COALESCE(orders.created_by_user_id, orders.user_id),
  seller_user_id = COALESCE(orders.seller_user_id, orders.user_id)
FROM public.sales AS sales
WHERE sales.id = orders.sale_id
  AND sales.source = 'pos'
  AND orders.user_id IS NOT NULL;

UPDATE public.sale_orders AS orders
SET requested_by_lead_id = sales.lead_id
FROM public.sales AS sales
WHERE sales.id = orders.sale_id
  AND orders.requested_by_lead_id IS NULL
  AND sales.lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sale_orders_site_created_by_idx
  ON public.sale_orders (site_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sale_orders_site_seller_idx
  ON public.sale_orders (site_id, seller_user_id)
  WHERE seller_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sale_orders_site_requested_by_idx
  ON public.sale_orders (site_id, requested_by_lead_id)
  WHERE requested_by_lead_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.preserve_sale_order_creator()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
    RAISE EXCEPTION 'created_by_user_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER preserve_sale_order_creator
BEFORE UPDATE OF created_by_user_id ON public.sale_orders
FOR EACH ROW
EXECUTE FUNCTION public.preserve_sale_order_creator();
