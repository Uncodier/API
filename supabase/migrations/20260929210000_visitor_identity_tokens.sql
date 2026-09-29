-- Local forward-only migration. Requires the existing visitor OTP migrations.
-- Remote REST OpenAPI metadata was checked read-only on 2026-09-29.
begin;

-- Enforce the provisioning boundary even when callers use Supabase REST directly.
create function public.guard_visitor_identity_issuer_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if 'identity:issue' = any(new.scopes) and coalesce(auth.role(), '') <> 'service_role' then
    if new.site_id is null or new.user_id <> auth.uid() or not exists (
      select 1 from public.sites where id = new.site_id and user_id = auth.uid()
    ) then raise exception using errcode = '42501', message = 'identity_issuer_owner_required'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_visitor_identity_issuer_scope() from public, anon, authenticated;
create trigger guard_visitor_identity_issuer_scope before insert or update on public.api_keys
  for each row execute function public.guard_visitor_identity_issuer_scope();

create table public.visitor_identity_session_state (
  session_id uuid primary key references public.visitor_sessions(id) on delete cascade,
  epoch bigint not null default 0 check (epoch >= 0)
);

create table public.visitor_identity_attributes (
  session_id uuid primary key references public.visitor_sessions(id) on delete cascade,
  attributes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.visitor_identity_attributes enable row level security;
alter table public.visitor_identity_attributes force row level security;
revoke all on public.visitor_identity_attributes from public, anon, authenticated;
grant all on public.visitor_identity_attributes to service_role;

create table public.visitor_external_identities (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  issuer text not null check (length(issuer) between 1 and 100),
  external_user_id text not null check (length(external_user_id) between 1 and 255),
  lead_id uuid not null unique references public.leads(id) on delete cascade,
  display_name text check (length(display_name) <= 200),
  asserted_email text check (length(asserted_email) <= 320),
  created_at timestamptz not null default now(),
  unique (site_id, issuer, external_user_id)
);

create table public.visitor_identity_token_redemptions (
  jti uuid primary key,
  site_id uuid not null references public.sites(id) on delete cascade,
  session_id uuid not null references public.visitor_sessions(id) on delete cascade,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  identity_id uuid not null references public.visitor_external_identities(id) on delete cascade,
  issuer_key_id uuid references public.api_keys(id) on delete set null,
  epoch bigint not null,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index visitor_identity_redemptions_session_idx
  on public.visitor_identity_token_redemptions(session_id);
create index visitor_identity_redemptions_key_idx
  on public.visitor_identity_token_redemptions(issuer_key_id) where issuer_key_id is not null;

create function public.revoke_visitor_identity_issuer_grants()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- No session row lock here: exchange locks session then credential then grant.
  -- Retain the lead binding so access fails closed until renewal or logout.
  if tg_op = 'DELETE' or new.status is distinct from 'active' or new.site_id is distinct from old.site_id
    or new.user_id is distinct from old.user_id
    or new.lookup_hash is distinct from old.lookup_hash or new.key_hash is distinct from old.key_hash
    or not coalesce('identity:issue' = any(new.scopes), false)
    or new.expires_at is null or new.expires_at < old.expires_at
    or new.expires_at <= clock_timestamp() then
    update public.visitor_session_identity_grants g
      set revoked_at = clock_timestamp(), trusted_token_hash = null, updated_at = clock_timestamp()
      where g.revoked_at is null and exists (
        select 1 from public.visitor_identity_token_redemptions r
          where r.issuer_key_id = old.id and r.session_id = g.session_id and r.token_hash = g.trusted_token_hash
      );
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.revoke_visitor_identity_issuer_grants() from public, anon, authenticated;
create trigger revoke_visitor_identity_issuer_grants before update or delete on public.api_keys
  for each row execute function public.revoke_visitor_identity_issuer_grants();

-- An email/OTP path cannot grant a token-only lead, even if CRM email is edited.
create function public.guard_external_identity_grant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.revoked_at is null and exists (
    select 1 from public.visitor_external_identities where lead_id = new.lead_id
  ) and not exists (
    select 1 from public.visitor_identity_token_redemptions r
      join public.visitor_external_identities i on i.id = r.identity_id
      where r.session_id = new.session_id and r.site_id = new.site_id
        and r.visitor_id = new.visitor_id and i.lead_id = new.lead_id
        and r.token_hash = new.trusted_token_hash
        and r.epoch = coalesce((select epoch from public.visitor_identity_session_state
          where session_id = new.session_id), 0)
  ) then raise exception using errcode = '42501', message = 'external_identity_token_required'; end if;
  return new;
end;
$$;
revoke all on function public.guard_external_identity_grant() from public, anon, authenticated;
create trigger guard_external_identity_grant before insert or update on public.visitor_session_identity_grants
  for each row execute function public.guard_external_identity_grant();

alter table public.visitor_identity_session_state enable row level security;
alter table public.visitor_identity_session_state force row level security;
alter table public.visitor_external_identities enable row level security;
alter table public.visitor_external_identities force row level security;
alter table public.visitor_identity_token_redemptions enable row level security;
alter table public.visitor_identity_token_redemptions force row level security;
revoke all on public.visitor_identity_session_state, public.visitor_external_identities,
  public.visitor_identity_token_redemptions from public, anon, authenticated;
grant all on public.visitor_identity_session_state, public.visitor_external_identities,
  public.visitor_identity_token_redemptions to service_role;

create function public.exchange_visitor_identity_token(
  p_site_id uuid, p_session_id uuid, p_visitor_id uuid,
  p_issuer text, p_subject text, p_epoch bigint, p_jti uuid,
  p_issued_at bigint, p_expires_at bigint, p_token_hash text,
  p_name text default null, p_email text default null, p_key_id uuid default null,
  p_key_fingerprint text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.visitor_sessions%rowtype;
  v_identity public.visitor_external_identities%rowtype;
  v_redemption public.visitor_identity_token_redemptions%rowtype;
  v_grant public.visitor_session_identity_grants%rowtype;
  v_epoch bigint;
  v_owner uuid;
  v_lead uuid;
  v_key_expiry timestamptz;
  v_now timestamptz;
begin
  perform public.assert_visitor_identity_service_role();
  -- Match logout lock order; serialize all grants against the canonical session.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  select * into v_session from public.visitor_sessions
    where id = p_session_id and site_id = p_site_id and visitor_id = p_visitor_id for update;
  v_now := clock_timestamp();
  if not found or not coalesce(v_session.is_active, false) then
    return jsonb_build_object('status', 'invalid_session');
  end if;
  if p_issued_at is null or p_expires_at is null or p_expires_at - p_issued_at <> 90
    or to_timestamp(p_issued_at) > v_now or to_timestamp(p_expires_at) <= v_now
    or p_jti is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_subject is null or length(p_subject) not between 1 and 255
    or length(p_name) > 200 or length(p_email) > 320
    or p_issuer is null or not (
      p_issuer = 'integration:' || p_site_id::text
      or (p_issuer = 'supabase:rnjgeloamtszdjplmqxy'
        and p_site_id = '9be0a6a2-5567-41bf-ad06-cb4014f0faf2'::uuid)
    ) then return jsonb_build_object('status', 'invalid_token');
  end if;
  select epoch into v_epoch from public.visitor_identity_session_state where session_id = p_session_id;
  if p_epoch is null or p_epoch <> coalesce(v_epoch, 0) then
    return jsonb_build_object('status', 'revoked');
  end if;
  if p_issuer = 'integration:' || p_site_id::text then
    -- Credential revocation fences even unconsumed tokens. Namespace stays stable.
    select expires_at into v_key_expiry from public.api_keys
      where id = p_key_id and site_id = p_site_id and status = 'active'
        and encode(sha256(convert_to(key_hash, 'UTF8')), 'hex') = p_key_fingerprint
        and 'identity:issue' = any(scopes) and expires_at > v_now for share;
    if not found then return jsonb_build_object('status', 'revoked'); end if;
  elsif p_key_id is not null or p_key_fingerprint is not null then
    return jsonb_build_object('status', 'invalid_token');
  end if;

  select * into v_grant from public.visitor_session_identity_grants where session_id = p_session_id for update;
  v_now := clock_timestamp();
  if to_timestamp(p_expires_at) <= v_now or v_key_expiry <= v_now then
    return jsonb_build_object('status', 'revoked');
  end if;
  select * into v_redemption from public.visitor_identity_token_redemptions where jti = p_jti;
  if found then
    -- Retry is valid only while the exact grant remains active; never reinsert it.
    if v_redemption.site_id = p_site_id and v_redemption.session_id = p_session_id
      and v_redemption.visitor_id = p_visitor_id and v_redemption.epoch = p_epoch
      and v_redemption.token_hash = p_token_hash and v_redemption.expires_at > v_now
      and v_grant.revoked_at is null and v_grant.expires_at > v_now
      and v_grant.trusted_token_hash = p_token_hash and v_session.lead_id = v_grant.lead_id then
      return jsonb_build_object('status', 'verified', 'lead_id', v_grant.lead_id, 'expires_at', v_grant.expires_at);
    end if;
    return jsonb_build_object('status', 'revoked');
  end if;

  -- The namespace excludes the credential id so API-key rotation is transparent.
  perform pg_advisory_xact_lock(hashtextextended(
    p_site_id::text || ':' || p_issuer || ':' || p_subject, 1));
  v_now := clock_timestamp();
  if to_timestamp(p_expires_at) <= v_now or v_key_expiry <= v_now then
    return jsonb_build_object('status', 'revoked');
  end if;
  select * into v_identity from public.visitor_external_identities
    where site_id = p_site_id and issuer = p_issuer and external_user_id = p_subject;
  -- Even an expired grant retains the identity boundary until explicit logout.
  if v_session.lead_id is not null and
    (v_identity.id is null or v_identity.lead_id <> v_session.lead_id) then
    return jsonb_build_object('status', 'identity_conflict');
  end if;
  if v_identity.id is null then
    select user_id into v_owner from public.sites where id = p_site_id;
    if v_owner is null then return jsonb_build_object('status', 'invalid_site'); end if;
    v_lead := gen_random_uuid();
    -- Do not look up, merge, or claim an email-matching lead. Keeping asserted email
    -- private also prevents legacy email-only new-lead/OTP flows from claiming it.
    insert into public.leads(id, site_id, user_id, name, status, origin)
      values(v_lead, p_site_id, v_owner, coalesce(p_name, 'Verified visitor'), 'new', 'server_identity');
    insert into public.visitor_external_identities(site_id, issuer, external_user_id, lead_id, display_name, asserted_email)
      values(p_site_id, p_issuer, p_subject, v_lead, p_name, p_email) returning * into v_identity;
  end if;
  insert into public.visitor_identity_token_redemptions(
    jti, site_id, session_id, visitor_id, identity_id, issuer_key_id, epoch, token_hash, expires_at
  ) values(p_jti, p_site_id, p_session_id, p_visitor_id, v_identity.id, p_key_id, p_epoch, p_token_hash, to_timestamp(p_expires_at));
  insert into public.visitor_session_identity_grants(
    site_id, session_id, visitor_id, lead_id, trusted_token_hash, granted_at, expires_at, revoked_at, updated_at
  ) values(p_site_id, p_session_id, p_visitor_id, v_identity.lead_id, p_token_hash, v_now,
    least(v_now + interval '15 minutes', v_key_expiry), null, v_now)
  on conflict(session_id) do update set
    site_id = excluded.site_id, visitor_id = excluded.visitor_id, lead_id = excluded.lead_id,
    trusted_token_hash = excluded.trusted_token_hash, granted_at = excluded.granted_at,
    expires_at = excluded.expires_at, revoked_at = null, updated_at = excluded.updated_at;
  update public.visitor_sessions set lead_id = v_identity.lead_id,
    identified_at = (extract(epoch from v_now) * 1000)::bigint, updated_at = v_now
    where id = p_session_id;
  update public.visitor_identity_challenges set cancelled_at = v_now, updated_at = v_now
    where session_id = p_session_id and consumed_at is null and cancelled_at is null;
  return jsonb_build_object('status', 'verified', 'lead_id', v_identity.lead_id,
    'expires_at', least(v_now + interval '15 minutes', v_key_expiry));
end;
$$;

create or replace function public.revoke_visitor_session_identity(p_site_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz;
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  perform 1 from public.visitor_sessions where id = p_session_id and site_id = p_site_id for update;
  if not found then return jsonb_build_object('status', 'invalid_session'); end if;
  v_now := clock_timestamp();
  insert into public.visitor_identity_session_state(session_id, epoch) values(p_session_id, 1)
    on conflict(session_id) do update set epoch = public.visitor_identity_session_state.epoch + 1;
  update public.visitor_session_identity_grants
    set revoked_at = v_now, trusted_token_hash = null, updated_at = v_now
    where site_id = p_site_id and session_id = p_session_id and revoked_at is null;
  update public.visitor_identity_challenges set cancelled_at = v_now, updated_at = v_now
    where site_id = p_site_id and session_id = p_session_id and consumed_at is null and cancelled_at is null;
  update public.visitor_sessions set lead_id = null, identified_at = null, updated_at = v_now
    where site_id = p_site_id and id = p_session_id;
  return jsonb_build_object('status', 'revoked');
end;
$$;

revoke all on function public.exchange_visitor_identity_token(uuid, uuid, uuid, text, text, bigint, uuid, bigint, bigint, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.exchange_visitor_identity_token(uuid, uuid, uuid, text, text, bigint, uuid, bigint, bigint, text, text, text, uuid, text)
  to service_role;
revoke all on function public.revoke_visitor_session_identity(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_visitor_session_identity(uuid, uuid) to service_role;
commit;