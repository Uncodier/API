-- Migration to revert the erroneous foreign key change
-- This ensures catalog_items points back to catalog_categories as it originally did.

ALTER TABLE public.catalog_items 
  DROP CONSTRAINT IF EXISTS catalog_items_category_id_fkey;

-- Clean up any orphaned references (the bad UUIDs we just assigned)
-- We set them to NULL so PostgreSQL allows us to restore the correct constraint.
UPDATE public.catalog_items
SET category_id = NULL
WHERE category_id IS NOT NULL 
  AND NOT EXISTS (
    SELECT 1 FROM public.catalog_categories WHERE id = catalog_items.category_id
  );

ALTER TABLE public.catalog_items 
  ADD CONSTRAINT catalog_items_category_id_fkey 
  FOREIGN KEY (category_id) REFERENCES public.catalog_categories(id);
