-- Ephemeral PGlite only: baseline catalog tables predate checked-in migrations.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.sites(id uuid PRIMARY KEY, name text, archived_at timestamptz);
CREATE TABLE public.catalog_categories(id uuid PRIMARY KEY, site_id uuid REFERENCES public.sites,
  name text, status text DEFAULT 'active');
CREATE TABLE public.catalog_items(
  id uuid PRIMARY KEY, site_id uuid NOT NULL REFERENCES public.sites ON DELETE CASCADE,
  name text NOT NULL, description text, sku text, kind text DEFAULT 'product', digital_subtype text,
  category_id uuid REFERENCES public.catalog_categories ON DELETE SET NULL,
  parent_id uuid REFERENCES public.catalog_items ON DELETE CASCADE,
  status text DEFAULT 'active', availability_status text DEFAULT 'available',
  availability_mode text DEFAULT 'manual', is_reservation boolean DEFAULT false,
  is_purchasable boolean DEFAULT true, is_recurring boolean DEFAULT false,
  is_pos_available boolean DEFAULT true, is_marketplace_listed boolean DEFAULT true,
  currency text DEFAULT 'USD', cost numeric, target_sale_price numeric,
  metadata jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.item_spec_categories(id uuid PRIMARY KEY, site_id uuid REFERENCES public.sites, name text);
CREATE TABLE public.item_specs(id uuid PRIMARY KEY, site_id uuid REFERENCES public.sites,
  category_id uuid REFERENCES public.item_spec_categories, name text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.catalog_item_specs(catalog_item_id uuid REFERENCES public.catalog_items ON DELETE CASCADE,
  item_spec_id uuid REFERENCES public.item_specs ON DELETE CASCADE, sort_order integer DEFAULT 0,
  PRIMARY KEY(catalog_item_id, item_spec_id));
CREATE TABLE public.inventory_levels(id uuid PRIMARY KEY, site_id uuid REFERENCES public.sites,
  catalog_item_id uuid REFERENCES public.catalog_items ON DELETE CASCADE, quantity numeric);
CREATE TABLE public.price_lists(id uuid PRIMARY KEY, site_id uuid REFERENCES public.sites,
  name text, currency text, is_active boolean);
CREATE TABLE public.price_list_items(id uuid PRIMARY KEY, site_id uuid REFERENCES public.sites,
  catalog_item_id uuid REFERENCES public.catalog_items ON DELETE CASCADE,
  price_list_id uuid REFERENCES public.price_lists, unit_price numeric);

-- Simulate Supabase default grants so revocations must actively close exposure.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;