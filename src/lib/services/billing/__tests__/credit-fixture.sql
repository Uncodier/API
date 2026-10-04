CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role',true),'');
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;
CREATE TABLE public.sites(id uuid PRIMARY KEY, name text, user_id uuid, archived_at timestamptz);
CREATE TABLE public.site_ownership(site_id uuid, user_id uuid);
CREATE TABLE public.site_members(site_id uuid, user_id uuid, status text, role text);
CREATE TABLE public.billing(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid REFERENCES sites(id),
  plan varchar DEFAULT 'free', credits_available numeric DEFAULT 0, credits_used numeric DEFAULT 0,
  account_balance numeric DEFAULT 0, status varchar DEFAULT 'active', addons_count integer DEFAULT 0,
  subscription_status text, stripe_customer_id text, stripe_subscription_id text, auto_renew boolean DEFAULT true,
  subscription_current_period_end timestamptz, subscription_start_date timestamptz,subscription_end_date timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.payments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid REFERENCES sites(id),
  transaction_id varchar UNIQUE, transaction_type varchar, amount numeric, currency text,
  status varchar, payment_method varchar, credits integer, details jsonb,
  invoice_url text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.credit_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid REFERENCES sites(id),
  amount numeric, transaction_type varchar, description text, metadata jsonb,created_at timestamptz DEFAULT now()
);
CREATE TABLE public.stripe_subscription_invoice_settlements(
  invoice_id text PRIMARY KEY, site_id uuid REFERENCES sites(id),payment_id uuid UNIQUE REFERENCES payments(id),
  customer_id text,subscription_id text,amount numeric,currency text,credits_granted integer,event_id text,settled_at timestamptz DEFAULT now()
);