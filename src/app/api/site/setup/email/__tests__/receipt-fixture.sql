CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.sites(id uuid PRIMARY KEY, user_id uuid NOT NULL, archived_at timestamptz);