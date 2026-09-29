-- Minimal local-only prerequisite schema; never run against an existing database.
-- Derived from /tmp/visitor-identity-schema.json read-only REST metadata (2026-09-29).
-- Includes relevant columns, required fields, enum, and reported foreign keys.
-- Core production CHECK constraints, RLS policies, and triggers are not available.
-- The real three OTP migrations and token migration are loaded by run.py.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create table public.sites (
  id uuid primary key default gen_random_uuid(), name text not null,
  user_id uuid not null, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.leads (
  id uuid primary key default gen_random_uuid(), name text, email text,
  status text not null, site_id uuid references public.sites(id), user_id uuid not null,
  origin text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.visitors (
  id uuid primary key, first_seen_at bigint not null, last_seen_at bigint not null,
  lead_id uuid, is_identified boolean default false,
  created_at timestamptz default now(), updated_at timestamptz
);
create table public.visitor_sessions (
  id uuid primary key, visitor_id uuid not null references public.visitors(id),
  site_id uuid not null, started_at bigint not null, last_activity_at bigint not null,
  is_active boolean default true, lead_id uuid references public.leads(id),
  identified_at bigint, created_at timestamptz default now(), updated_at timestamptz
);
create type public.key_status as enum ('active', 'expired', 'revoked');
create table public.api_keys (
  id uuid primary key default gen_random_uuid(), name varchar(255) not null,
  key_hash text not null, prefix varchar(50) not null, user_id uuid not null,
  site_id uuid references public.sites(id), status public.key_status default 'active',
  scopes text[] not null, expires_at timestamptz not null, lookup_hash text,
  created_at timestamptz default current_timestamp,
  updated_at timestamptz default current_timestamp
);
grant all on all tables in schema public to service_role;
-- Explicitly permissive fixture grants isolate the new provisioning trigger.
-- These do NOT attempt to reproduce the production API-key RLS policies.
grant select on public.sites to authenticated;
grant select, insert, update on public.api_keys to authenticated;