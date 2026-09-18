create table if not exists public.visitor_identity_challenges (
  id uuid primary key,
  site_id uuid not null references public.sites(id) on delete cascade,
  session_id uuid not null references public.visitor_sessions(id) on delete cascade,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  normalized_email text not null,
  masked_email text not null,
  otp_hash text not null,
  request_ip_hash text,
  attempts integer not null default 0 check (attempts between 0 and 5),
  resend_count integer not null default 0 check (resend_count between 0 and 3),
  expires_at timestamptz not null,
  resend_available_at timestamptz not null,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.visitor_session_identity_grants (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  session_id uuid not null references public.visitor_sessions(id) on delete cascade,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  trusted_token_hash text,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id)
);

create index if not exists visitor_identity_challenges_lookup_idx
  on public.visitor_identity_challenges (site_id, session_id, id);
create index if not exists visitor_identity_challenges_email_rate_idx
  on public.visitor_identity_challenges (site_id, normalized_email, created_at desc);
create index if not exists visitor_identity_challenges_ip_rate_idx
  on public.visitor_identity_challenges (site_id, request_ip_hash, created_at desc)
  where request_ip_hash is not null;
create index if not exists visitor_identity_challenges_active_idx
  on public.visitor_identity_challenges (session_id, created_at desc)
  where consumed_at is null and cancelled_at is null;
create index if not exists visitor_session_identity_grants_active_idx
  on public.visitor_session_identity_grants (site_id, visitor_id, lead_id)
  where revoked_at is null;
create index if not exists visitor_session_identity_grants_token_idx
  on public.visitor_session_identity_grants (trusted_token_hash)
  where trusted_token_hash is not null and revoked_at is null;

alter table public.visitor_identity_challenges enable row level security;
alter table public.visitor_identity_challenges force row level security;
alter table public.visitor_session_identity_grants enable row level security;
alter table public.visitor_session_identity_grants force row level security;

revoke all on public.visitor_identity_challenges from public, anon, authenticated;
revoke all on public.visitor_session_identity_grants from public, anon, authenticated;
grant all on public.visitor_identity_challenges to service_role;
grant all on public.visitor_session_identity_grants to service_role;

create or replace function public.assert_visitor_identity_service_role()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
end;
$$;

revoke all on function public.assert_visitor_identity_service_role() from public, anon, authenticated;
grant execute on function public.assert_visitor_identity_service_role() to service_role;

create or replace function public.issue_visitor_identity_challenge(
  p_challenge_id uuid,
  p_site_id uuid,
  p_session_id uuid,
  p_visitor_id uuid,
  p_lead_id uuid,
  p_normalized_email text,
  p_masked_email text,
  p_otp_hash text,
  p_request_ip_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.visitor_sessions%rowtype;
  v_recent_count integer;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(
    p_site_id::text || ':' || lower(trim(p_normalized_email)) || ':' || p_session_id::text,
    0
  ));

  select * into v_session
  from public.visitor_sessions
  where id = p_session_id and site_id = p_site_id and visitor_id = p_visitor_id
  for update;
  if not found then
    return jsonb_build_object('status', 'invalid_session');
  end if;

  select count(*) into v_recent_count
  from public.visitor_identity_challenges
  where site_id = p_site_id
    and created_at > v_now - interval '1 hour'
    and (
      session_id = p_session_id
      or normalized_email = lower(trim(p_normalized_email))
      or (p_request_ip_hash is not null and request_ip_hash = p_request_ip_hash)
    );
  if v_recent_count >= 5 then
    return jsonb_build_object('status', 'rate_limited', 'retry_after', 3600);
  end if;

  update public.visitor_identity_challenges
  set cancelled_at = v_now, updated_at = v_now
  where session_id = p_session_id and consumed_at is null and cancelled_at is null;

  insert into public.visitor_identity_challenges (
    id, site_id, session_id, visitor_id, lead_id, normalized_email,
    masked_email, otp_hash, request_ip_hash, expires_at, resend_available_at
  ) values (
    p_challenge_id, p_site_id, p_session_id, p_visitor_id, p_lead_id,
    lower(trim(p_normalized_email)), p_masked_email, p_otp_hash, p_request_ip_hash,
    v_now + interval '10 minutes', v_now + interval '60 seconds'
  );

  return jsonb_build_object(
    'status', 'issued',
    'challenge_id', p_challenge_id,
    'masked_email', p_masked_email,
    'expires_at', v_now + interval '10 minutes',
    'resend_available_at', v_now + interval '60 seconds'
  );
end;
$$;

create or replace function public.resend_visitor_identity_challenge(
  p_challenge_id uuid,
  p_site_id uuid,
  p_session_id uuid,
  p_otp_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_challenge public.visitor_identity_challenges%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text || ':' || p_challenge_id::text, 0));
  select * into v_challenge
  from public.visitor_identity_challenges
  where id = p_challenge_id and site_id = p_site_id and session_id = p_session_id
  for update;

  if not found or v_challenge.cancelled_at is not null or v_challenge.consumed_at is not null
     or v_challenge.expires_at <= v_now then
    return jsonb_build_object('status', 'challenge_expired');
  end if;
  if v_challenge.resend_count >= 3 then
    return jsonb_build_object('status', 'resend_limit');
  end if;
  if v_challenge.resend_available_at > v_now then
    return jsonb_build_object(
      'status', 'cooldown',
      'retry_after', greatest(1, ceil(extract(epoch from v_challenge.resend_available_at - v_now)))
    );
  end if;

  update public.visitor_identity_challenges
  set otp_hash = p_otp_hash,
      attempts = 0,
      resend_count = resend_count + 1,
      expires_at = v_now + interval '10 minutes',
      resend_available_at = v_now + interval '60 seconds',
      updated_at = v_now
  where id = p_challenge_id;

  return jsonb_build_object(
    'status', 'resent',
    'challenge_id', p_challenge_id,
    'masked_email', v_challenge.masked_email,
    'email', v_challenge.normalized_email,
    'lead_id', v_challenge.lead_id,
    'expires_at', v_now + interval '10 minutes',
    'resend_available_at', v_now + interval '60 seconds'
  );
end;
$$;

create or replace function public.verify_consume_visitor_identity_challenge(
  p_challenge_id uuid,
  p_site_id uuid,
  p_session_id uuid,
  p_otp_hash text,
  p_trusted_token_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_challenge public.visitor_identity_challenges%rowtype;
  v_session public.visitor_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_attempts integer;
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text || ':' || p_challenge_id::text, 0));
  select * into v_session from public.visitor_sessions
  where id = p_session_id and site_id = p_site_id for update;
  if not found then return jsonb_build_object('status', 'invalid_session'); end if;

  select * into v_challenge from public.visitor_identity_challenges
  where id = p_challenge_id and site_id = p_site_id and session_id = p_session_id
  for update;
  if not found or v_challenge.cancelled_at is not null or v_challenge.consumed_at is not null
     or v_challenge.expires_at <= v_now or v_challenge.attempts >= 5 then
    return jsonb_build_object('status', 'challenge_expired');
  end if;

  if v_challenge.otp_hash <> p_otp_hash then
    v_attempts := v_challenge.attempts + 1;
    update public.visitor_identity_challenges
    set attempts = v_attempts,
        cancelled_at = case when v_attempts >= 5 then v_now else cancelled_at end,
        updated_at = v_now
    where id = p_challenge_id;
    return jsonb_build_object(
      'status', case when v_attempts >= 5 then 'attempt_limit' else 'invalid_code' end,
      'attempts_remaining', greatest(0, 5 - v_attempts)
    );
  end if;

  update public.visitor_identity_challenges
  set consumed_at = v_now, updated_at = v_now where id = p_challenge_id;
  insert into public.visitor_session_identity_grants (
    site_id, session_id, visitor_id, lead_id, trusted_token_hash, granted_at, revoked_at, updated_at
  ) values (
    p_site_id, p_session_id, v_challenge.visitor_id, v_challenge.lead_id,
    p_trusted_token_hash, v_now, null, v_now
  )
  on conflict (session_id) do update set
    site_id = excluded.site_id,
    visitor_id = excluded.visitor_id,
    lead_id = excluded.lead_id,
    trusted_token_hash = excluded.trusted_token_hash,
    granted_at = excluded.granted_at,
    expires_at = null,
    revoked_at = null,
    updated_at = excluded.updated_at;
  update public.visitor_sessions
  set lead_id = v_challenge.lead_id, identified_at = (extract(epoch from v_now) * 1000)::bigint,
      updated_at = v_now
  where id = p_session_id and site_id = p_site_id;
  update public.visitors set lead_id = v_challenge.lead_id, is_identified = true
  where id = v_challenge.visitor_id;
  return jsonb_build_object('status', 'verified', 'lead_id', v_challenge.lead_id);
end;
$$;

create or replace function public.grant_new_visitor_identity(
  p_site_id uuid,
  p_session_id uuid,
  p_visitor_id uuid,
  p_lead_id uuid,
  p_normalized_email text,
  p_trusted_token_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_canonical_lead uuid;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_site_id::text || ':' || lower(trim(p_normalized_email)), 0));
  perform 1 from public.visitor_sessions
  where id = p_session_id and site_id = p_site_id and visitor_id = p_visitor_id for update;
  if not found then return jsonb_build_object('status', 'invalid_session'); end if;

  select id into v_canonical_lead from public.leads
  where site_id = p_site_id and lower(trim(email)) = lower(trim(p_normalized_email))
  order by created_at asc nulls last, id asc limit 1 for update;
  if v_canonical_lead is null then return jsonb_build_object('status', 'lead_not_found'); end if;
  if v_canonical_lead <> p_lead_id then
    return jsonb_build_object('status', 'existing', 'lead_id', v_canonical_lead);
  end if;

  insert into public.visitor_session_identity_grants (
    site_id, session_id, visitor_id, lead_id, trusted_token_hash, granted_at, revoked_at, updated_at
  ) values (p_site_id, p_session_id, p_visitor_id, p_lead_id, p_trusted_token_hash, v_now, null, v_now)
  on conflict (session_id) do update set
    site_id = excluded.site_id, visitor_id = excluded.visitor_id, lead_id = excluded.lead_id,
    trusted_token_hash = excluded.trusted_token_hash, granted_at = excluded.granted_at,
    expires_at = null, revoked_at = null, updated_at = excluded.updated_at;
  update public.visitor_sessions
  set lead_id = p_lead_id, identified_at = (extract(epoch from v_now) * 1000)::bigint, updated_at = v_now
  where id = p_session_id;
  update public.visitors set lead_id = p_lead_id, is_identified = true where id = p_visitor_id;
  return jsonb_build_object('status', 'granted', 'lead_id', p_lead_id);
end;
$$;

create or replace function public.cancel_visitor_identity_challenge(
  p_challenge_id uuid, p_site_id uuid, p_session_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text || ':' || p_challenge_id::text, 0));
  update public.visitor_identity_challenges set cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_challenge_id and site_id = p_site_id and session_id = p_session_id
    and consumed_at is null and cancelled_at is null;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

create or replace function public.revoke_visitor_session_identity(
  p_site_id uuid, p_session_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_now timestamptz := clock_timestamp();
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  update public.visitor_session_identity_grants
  set revoked_at = v_now, trusted_token_hash = null, updated_at = v_now
  where site_id = p_site_id and session_id = p_session_id and revoked_at is null;
  update public.visitor_identity_challenges set cancelled_at = v_now, updated_at = v_now
  where site_id = p_site_id and session_id = p_session_id and consumed_at is null and cancelled_at is null;
  return jsonb_build_object('status', 'revoked');
end;
$$;

revoke all on function public.issue_visitor_identity_challenge(uuid, uuid, uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.resend_visitor_identity_challenge(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.verify_consume_visitor_identity_challenge(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.grant_new_visitor_identity(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.cancel_visitor_identity_challenge(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_visitor_session_identity(uuid, uuid) from public, anon, authenticated;
grant execute on function public.issue_visitor_identity_challenge(uuid, uuid, uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.resend_visitor_identity_challenge(uuid, uuid, uuid, text) to service_role;
grant execute on function public.verify_consume_visitor_identity_challenge(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.grant_new_visitor_identity(uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.cancel_visitor_identity_challenge(uuid, uuid, uuid) to service_role;
grant execute on function public.revoke_visitor_session_identity(uuid, uuid) to service_role;
