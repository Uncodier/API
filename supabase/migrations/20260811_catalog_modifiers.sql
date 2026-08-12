-- Product modifiers: reusable groups of catalog items attachable to host products.
-- Rollback:
--   ALTER TABLE public.sale_order_items DROP COLUMN IF EXISTS parent_sale_order_item_id;
--   DROP TABLE IF EXISTS public.catalog_item_modifier_groups;
--   DROP TABLE IF EXISTS public.modifier_group_items;
--   DROP TABLE IF EXISTS public.modifier_groups;

-- 1. Modifier groups
CREATE TABLE IF NOT EXISTS public.modifier_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  min_select integer NOT NULL DEFAULT 0,
  max_select integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT modifier_groups_pkey PRIMARY KEY (id),
  CONSTRAINT modifier_groups_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE,
  CONSTRAINT modifier_groups_min_select_check CHECK (min_select >= 0),
  CONSTRAINT modifier_groups_max_select_check CHECK (max_select IS NULL OR max_select >= min_select)
);

CREATE INDEX IF NOT EXISTS idx_modifier_groups_site_id ON public.modifier_groups(site_id);

-- 2. Options inside a group (catalog items used as extras)
CREATE TABLE IF NOT EXISTS public.modifier_group_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  modifier_group_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT modifier_group_items_pkey PRIMARY KEY (id),
  CONSTRAINT modifier_group_items_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE,
  CONSTRAINT modifier_group_items_group_fkey FOREIGN KEY (modifier_group_id) REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
  CONSTRAINT modifier_group_items_catalog_item_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id) ON DELETE CASCADE,
  CONSTRAINT modifier_group_items_unique_pair UNIQUE (modifier_group_id, catalog_item_id)
);

CREATE INDEX IF NOT EXISTS idx_modifier_group_items_group_id ON public.modifier_group_items(modifier_group_id);
CREATE INDEX IF NOT EXISTS idx_modifier_group_items_site_id ON public.modifier_group_items(site_id);

-- 3. Attach groups to host catalog items
CREATE TABLE IF NOT EXISTS public.catalog_item_modifier_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  modifier_group_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT catalog_item_modifier_groups_pkey PRIMARY KEY (id),
  CONSTRAINT catalog_item_modifier_groups_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE,
  CONSTRAINT catalog_item_modifier_groups_catalog_item_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id) ON DELETE CASCADE,
  CONSTRAINT catalog_item_modifier_groups_group_fkey FOREIGN KEY (modifier_group_id) REFERENCES public.modifier_groups(id) ON DELETE CASCADE,
  CONSTRAINT catalog_item_modifier_groups_unique_pair UNIQUE (catalog_item_id, modifier_group_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_item_modifier_groups_host ON public.catalog_item_modifier_groups(catalog_item_id);
CREATE INDEX IF NOT EXISTS idx_catalog_item_modifier_groups_site ON public.catalog_item_modifier_groups(site_id);

-- 4. Nested order lines (host + modifier children)
ALTER TABLE public.sale_order_items
  ADD COLUMN IF NOT EXISTS parent_sale_order_item_id uuid REFERENCES public.sale_order_items(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sale_order_items_parent
  ON public.sale_order_items (sale_order_id, parent_sale_order_item_id);

-- 5. RLS
ALTER TABLE public.modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.modifier_group_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_item_modifier_groups ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name TEXT;
  tables_array TEXT[] := ARRAY[
    'modifier_groups',
    'modifier_group_items',
    'catalog_item_modifier_groups'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables_array
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%I_unified" ON public.%I', table_name, table_name);

    EXECUTE format('
      CREATE POLICY "%I_unified" ON public.%I
      FOR ALL
      USING (
        current_setting(''role'', true) = ''service_role'' OR
        (auth.jwt() ->> ''role'') = ''service_role'' OR
        (
          EXISTS (
            SELECT 1 FROM public.sites s
            WHERE s.id = %I.site_id AND (
              s.user_id = auth.uid() OR
              EXISTS (
                SELECT 1 FROM public.site_members sm
                WHERE sm.site_id = s.id AND sm.user_id = auth.uid()
              )
            )
          )
        )
      );
    ', table_name, table_name, table_name);
  END LOOP;
END $$;
