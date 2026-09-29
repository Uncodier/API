-- Forward-only correction: all credential changes fence pending identity tokens.
-- Requires 20260929210000_visitor_identity_tokens.sql; no remote application here.
begin;

alter table public.api_keys
  add column identity_token_version uuid not null default gen_random_uuid();

create or replace function public.revoke_visitor_identity_issuer_grants()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_invalidated boolean;
begin
  if tg_op = 'INSERT' then
    -- A caller cannot select or resurrect a credential's version.
    new.identity_token_version := gen_random_uuid();
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_invalidated := true;
  else
    v_invalidated := new.status is distinct from old.status
      or new.site_id is distinct from old.site_id
      or new.user_id is distinct from old.user_id
      or new.lookup_hash is distinct from old.lookup_hash
      or new.key_hash is distinct from old.key_hash
      or new.scopes is distinct from old.scopes
      or new.expires_at is distinct from old.expires_at;
    -- Even restoring an earlier field value produces a fresh random version.
    -- Ordinary metadata/last_used_at updates do not revoke or rotate identity.
    new.identity_token_version := case when v_invalidated
      then gen_random_uuid() else old.identity_token_version end;
  end if;

  if v_invalidated then
    update public.visitor_session_identity_grants g
      set revoked_at = clock_timestamp(), trusted_token_hash = null, updated_at = clock_timestamp()
      where g.revoked_at is null and exists (
        select 1 from public.visitor_identity_token_redemptions r
          where r.issuer_key_id = old.id and r.session_id = g.session_id
            and r.token_hash = g.trusted_token_hash
      );
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger initialize_visitor_identity_issuer_version before insert on public.api_keys
  for each row execute function public.revoke_visitor_identity_issuer_grants();
revoke all on function public.revoke_visitor_identity_issuer_grants()
  from public, anon, authenticated;

-- Keep the original atomic implementation as an owner-only internal helper.
-- A direct service-role RPC must not bypass credential-version validation.
revoke all on function public.exchange_visitor_identity_token(
  uuid, uuid, uuid, text, text, bigint, uuid, bigint, bigint, text, text, text, uuid, text
) from public, anon, authenticated, service_role;

create function public.exchange_visitor_identity_token_v2(
  p_site_id uuid, p_session_id uuid, p_visitor_id uuid,
  p_issuer text, p_subject text, p_epoch bigint, p_jti uuid,
  p_issued_at bigint, p_expires_at bigint, p_token_hash text,
  p_name text default null, p_email text default null, p_key_id uuid default null,
  p_key_fingerprint text default null, p_key_version uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_visitor_identity_service_role();
  -- Preserve the session -> key -> grant lock order used by exchange and logout.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  perform 1 from public.visitor_sessions
    where id = p_session_id and site_id = p_site_id and visitor_id = p_visitor_id
      and is_active is true for update;
  if not found then return jsonb_build_object('status', 'invalid_session'); end if;

  if p_issuer = 'integration:' || p_site_id::text then
    perform 1 from public.api_keys
      where id = p_key_id and site_id = p_site_id
        and identity_token_version = p_key_version
        and status = 'active' and 'identity:issue' = any(scopes)
        and expires_at > clock_timestamp()
      for share;
    if not found then return jsonb_build_object('status', 'revoked'); end if;
  elsif p_key_version is not null then
    return jsonb_build_object('status', 'invalid_token');
  end if;

  -- This call executes as the migration/function owner. That is the only role
  -- with access to the unversioned helper after the REVOKE above.
  return public.exchange_visitor_identity_token(
    p_site_id, p_session_id, p_visitor_id, p_issuer, p_subject, p_epoch, p_jti,
    p_issued_at, p_expires_at, p_token_hash, p_name, p_email, p_key_id, p_key_fingerprint
  );
end;
$$;

revoke all on function public.exchange_visitor_identity_token_v2(
  uuid, uuid, uuid, text, text, bigint, uuid, bigint, bigint, text, text, text, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.exchange_visitor_identity_token_v2(
  uuid, uuid, uuid, text, text, bigint, uuid, bigint, bigint, text, text, text, uuid, text, uuid
) to service_role;

commit;