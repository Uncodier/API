-- =====================================================================
-- Apps Platform — schema-per-tenant infrastructure (idempotent)
--
-- Run this in the Apps Supabase project (currently the same project as
-- repositories: faxxouxekfwxvexoitxv). It creates:
--   1. public.apps_tenants  — registry of provisioned tenants.
--   2. public.tenant_users  — bridge between auth.users and tenants.
--   3. public.apps_exec_sql — SECURITY DEFINER RPC used by the
--      tenant-provisioner and migration endpoint to apply DDL inside the
--      tenant schema. NEVER expose this RPC to the anon role.
--   4. Strict GRANTs/REVOKEs aligned with the harness rules.
-- =====================================================================

create extension if not exists "pgcrypto";

create table if not exists public.apps_tenants (
  tenant_id uuid primary key,
  requirement_id uuid not null,
  user_id uuid not null,
  site_id uuid not null,
  schema text not null,
  bucket text not null,
  auth_provider text not null default 'supabase'
    check (auth_provider in ('supabase', 'auth0')),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'destroyed')),
  requires_isolation boolean not null default false,
  limits jsonb not null default jsonb_build_object(
    'max_rows_per_table', 100000,
    'max_storage_mb', 500,
    'max_auth_users', 10000,
    'max_rpc_calls_per_day', 50000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists apps_tenants_requirement_unique
  on public.apps_tenants (requirement_id);
create index if not exists apps_tenants_site_idx
  on public.apps_tenants (site_id);

alter table public.apps_tenants enable row level security;
drop policy if exists apps_tenants_service_only on public.apps_tenants;
create policy apps_tenants_service_only on public.apps_tenants
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create table if not exists public.tenant_users (
  tenant_id uuid not null references public.apps_tenants(tenant_id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table public.tenant_users enable row level security;
drop policy if exists tenant_users_service_only on public.tenant_users;
create policy tenant_users_service_only on public.tenant_users
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
drop policy if exists tenant_users_self_read on public.tenant_users;
create policy tenant_users_self_read on public.tenant_users
  for select
  using (auth.uid() = user_id);

create or replace function public.apps_exec_sql(sql text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if sql is null or length(trim(sql)) = 0 then
    raise exception 'apps_exec_sql: empty SQL';
  end if;
  execute sql;
end;
$$;

revoke all on function public.apps_exec_sql(text) from public;
revoke all on function public.apps_exec_sql(text) from anon, authenticated;

create or replace function public.tenant_id_from_jwt()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'tenant_id', '')::uuid;
$$;
