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
  v_existing public.visitor_identity_challenges%rowtype;
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
  where id = p_session_id
    and site_id = p_site_id
    and visitor_id = p_visitor_id
  for update;
  if not found then
    return jsonb_build_object('status', 'invalid_session');
  end if;

  select * into v_existing
  from public.visitor_identity_challenges
  where site_id = p_site_id
    and session_id = p_session_id
    and visitor_id = p_visitor_id
    and lead_id = p_lead_id
    and normalized_email = lower(trim(p_normalized_email))
    and consumed_at is null
    and cancelled_at is null
    and expires_at > v_now
  order by created_at desc
  limit 1
  for update;

  if found then
    return jsonb_build_object(
      'status', 'existing',
      'challenge_id', v_existing.id,
      'masked_email', v_existing.masked_email,
      'expires_at', v_existing.expires_at,
      'resend_available_at', v_existing.resend_available_at
    );
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
  where session_id = p_session_id
    and consumed_at is null
    and cancelled_at is null;

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
