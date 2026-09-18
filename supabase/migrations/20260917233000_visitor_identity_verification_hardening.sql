alter function public.assert_visitor_identity_service_role() set search_path = '';
alter function public.resend_visitor_identity_challenge(uuid, uuid, uuid, text) set search_path = '';
alter function public.grant_new_visitor_identity(uuid, uuid, uuid, uuid, text, text) set search_path = '';
alter function public.cancel_visitor_identity_challenge(uuid, uuid, uuid) set search_path = '';

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
set search_path = ''
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

  update public.visitor_session_identity_grants
  set revoked_at = v_now, trusted_token_hash = null, updated_at = v_now
  where session_id = p_session_id and revoked_at is null;
  update public.visitor_sessions
  set lead_id = null, identified_at = null, updated_at = v_now
  where id = p_session_id and site_id = p_site_id;
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

drop function if exists public.verify_consume_visitor_identity_challenge(
  uuid, uuid, uuid, text, text
);

create or replace function public.verify_consume_visitor_identity_challenge(
  p_challenge_id uuid,
  p_site_id uuid,
  p_session_id uuid,
  p_is_match boolean,
  p_trusted_token_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge public.visitor_identity_challenges%rowtype;
  v_session public.visitor_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_attempts integer;
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(
    p_session_id::text || ':' || p_challenge_id::text,
    0
  ));
  select * into v_session
  from public.visitor_sessions
  where id = p_session_id and site_id = p_site_id
  for update;
  if not found then
    return jsonb_build_object('status', 'invalid_session');
  end if;

  select * into v_challenge
  from public.visitor_identity_challenges
  where id = p_challenge_id and site_id = p_site_id and session_id = p_session_id
  for update;
  if not found
     or v_challenge.cancelled_at is not null
     or v_challenge.consumed_at is not null
     or v_challenge.expires_at <= v_now
     or v_challenge.attempts >= 5 then
    return jsonb_build_object('status', 'challenge_expired');
  end if;

  if not p_is_match then
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
  set consumed_at = v_now, updated_at = v_now
  where id = p_challenge_id;
  insert into public.visitor_session_identity_grants (
    site_id, session_id, visitor_id, lead_id, trusted_token_hash,
    granted_at, revoked_at, updated_at
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
  set lead_id = v_challenge.lead_id,
      identified_at = (extract(epoch from v_now) * 1000)::bigint,
      updated_at = v_now
  where id = p_session_id and site_id = p_site_id;
  update public.visitors
  set lead_id = v_challenge.lead_id, is_identified = true
  where id = v_challenge.visitor_id;
  return jsonb_build_object('status', 'verified', 'lead_id', v_challenge.lead_id);
end;
$$;

create or replace function public.revoke_visitor_session_identity(
  p_site_id uuid,
  p_session_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_visitor_identity_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  update public.visitor_session_identity_grants
  set revoked_at = v_now, trusted_token_hash = null, updated_at = v_now
  where site_id = p_site_id and session_id = p_session_id and revoked_at is null;
  update public.visitor_identity_challenges
  set cancelled_at = v_now, updated_at = v_now
  where site_id = p_site_id
    and session_id = p_session_id
    and consumed_at is null
    and cancelled_at is null;
  update public.visitor_sessions
  set lead_id = null, identified_at = null, updated_at = v_now
  where site_id = p_site_id and id = p_session_id;
  return jsonb_build_object('status', 'revoked');
end;
$$;

revoke all on function public.verify_consume_visitor_identity_challenge(
  uuid, uuid, uuid, boolean, text
) from public, anon, authenticated;
grant execute on function public.verify_consume_visitor_identity_challenge(
  uuid, uuid, uuid, boolean, text
) to service_role;
