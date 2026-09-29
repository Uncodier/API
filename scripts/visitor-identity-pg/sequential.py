"""State-transition and privilege assertions against real migration functions."""
from run import quoted as q, uid


def run(db):
    site, other, owner = uid(1), uid(2), uid(3)
    support = '9be0a6a2-5567-41bf-ad06-cb4014f0faf2'
    db.sql(f"insert into sites(id,name,user_id) values('{site}','Local A','{owner}'),"
           f"('{other}','Local B','{uid(4)}'),('{support}','Local support','{owner}');")
    key = db.key(site, owner)
    existing = db.new_id()
    db.sql(f"insert into leads(id,site_id,user_id,name,email,status) values('{existing}',"
           f"'{site}','{owner}','Existing','asserted@example.invalid','new');")
    first, second = db.session(site), db.session(site)
    token = db.token(first, 'stable-subject', key)
    result = db.exchange(token)
    lead = result.get('lead_id')
    db.check('exchange verifies and creates a different lead than matching email',
             result['status'] == 'verified' and lead != existing)
    db.check('token-created lead email remains null; asserted email stays private',
             db.scalar(f"(select email is null from leads where id='{lead}')") == 't' and
             db.scalar(f"(select asserted_email from visitor_external_identities where lead_id='{lead}')")
             == 'asserted@example.invalid')
    db.check('atomic grant, session and redemption agree on lead and hash',
             db.scalar(f"exists(select 1 from visitor_session_identity_grants g "
                       f"join visitor_sessions s on s.id=g.session_id "
                       f"join visitor_identity_token_redemptions r on r.session_id=s.id "
                       f"where s.id='{first['session']}' and s.lead_id=g.lead_id "
                       f"and g.lead_id='{lead}' and s.identified_at is not null "
                       f"and g.trusted_token_hash=r.token_hash and g.revoked_at is null)") == 't')
    db.check('exact token retry preserves response and grant expiry', db.exchange(token) == result)
    rotated = db.key(site, owner)
    second_token = db.token(second, 'stable-subject', rotated)
    db.check('stable subject across sessions and replacement keys resolves same lead',
             db.exchange(second_token)['lead_id'] == lead and
             db.row_count('visitor_external_identities', "external_user_id='stable-subject'") == 1)
    third = db.session(site)
    other_lead = db.exchange(db.token(third, 'different-subject', key))['lead_id']
    db.check('same asserted email never merges two subjects', other_lead not in (lead, existing))
    db.check('bound session rejects subject replacement',
             db.exchange(db.token(first, 'different-subject', key))['status'] == 'identity_conflict')
    anonymous = db.session(site)
    db.sql(f"insert into visitor_identity_attributes(session_id,attributes) values("
           f"'{anonymous['session']}', '{{\"email\":\"asserted@example.invalid\",\"lead_id\":\"{lead}\"}}');")
    db.check('unverified attributes cannot claim a lead or grant',
             db.scalar(f"(select lead_id is null from visitor_sessions where id='{anonymous['session']}')") == 't'
             and db.row_count('visitor_session_identity_grants', f"session_id='{anonymous['session']}'") == 0)

    cases = [
        ('wrong site', dict(site=other), 'invalid_session'),
        ('wrong visitor', dict(visitor=anonymous['visitor']), 'invalid_session'),
        ('unknown session', dict(session=uid(999)), 'invalid_session'),
        ('wrong issuer', dict(issuer='integration:' + other), 'invalid_token'),
        ('missing subject', dict(subject=None), 'invalid_token'),
        ('overlong subject', dict(subject='x' * 256), 'invalid_token'),
        ('invalid hash', dict(token_hash='bad'), 'invalid_token'),
        ('future token', dict(issued=token['issued'] + 100, expires=token['expires'] + 100), 'invalid_token'),
        ('expired token', dict(issued=token['issued'] - 100, expires=token['expires'] - 100), 'invalid_token'),
        ('wrong TTL', dict(expires=token['expires'] + 1), 'invalid_token'),
        ('missing epoch', dict(epoch=None), 'revoked'),
        ('wrong epoch', dict(epoch=8), 'revoked'),
        ('missing integration key', dict(key=None), 'revoked'),
        ('unknown integration key', dict(key=uid(888)), 'revoked'),
        ('missing key fingerprint', dict(fingerprint=None), 'revoked'),
        ('wrong key fingerprint', dict(fingerprint='0' * 64), 'revoked'),
    ]
    for name, changes, status in cases:
        db.check(name + ' rejected', db.exchange(dict(token, **changes))['status'] == status)
    inactive = db.session(site)
    db.sql(f"update visitor_sessions set is_active=false where id='{inactive['session']}';")
    db.check('inactive session rejected', db.exchange(db.token(inactive, 'inactive', key))['status'] == 'invalid_session')
    db.check('cross-session same JTI rejected', db.exchange(dict(token, **second))['status'] == 'revoked')

    for label, changes, key_site in [
        ('revoked key', "status='revoked'", site),
        ('expired key', "expires_at=clock_timestamp()-interval '1 second'", site),
        ('wildcard-only key', "scopes=array['*']", site),
        ('cross-site key', '', other),
    ]:
        bad_key = db.key(key_site, owner, changes)
        db.check(label + ' rejects unused token',
                 db.exchange(db.token(anonymous, label, bad_key))['status'] == 'revoked')

    for label, mutation in [
        ('key revocation', "status='revoked'"),
        ('scope removal', "scopes=array['read']"),
        ('expiry shortening', "expires_at=clock_timestamp()+interval '30 minutes'"),
        ('null key status', 'status=null'),
        ('lookup material change', "lookup_hash='changed-fixture-lookup'"),
        ('key site change', f"site_id='{other}'"),
        ('key deletion', None),
    ]:
        local_key, session = db.key(site, owner), db.session(site)
        used = db.token(session, label, local_key)
        db.exchange(used)
        if mutation:
            db.sql(f"update api_keys set {mutation} where id='{local_key}';")
        else:
            db.sql(f"delete from api_keys where id='{local_key}';")
        db.check(label + ' revokes active grant and exact retry',
                 db.scalar(f"(select revoked_at is not null and trusted_token_hash is null "
                           f"from visitor_session_identity_grants where session_id='{session['session']}')") == 't'
                 and db.exchange(used)['status'] == 'revoked')
    capped_key = db.key(site, owner, "expires_at=clock_timestamp()+interval '5 minutes'")
    capped_session = db.session(site)
    capped = db.exchange(db.token(capped_session, 'capped', capped_key))
    db.check('grant expiry is capped to issuer key expiry',
             db.scalar(f"(select expires_at={q(capped['expires_at'])}::timestamptz from api_keys where id='{capped_key}')") == 't')

    rotating_key = db.key(site, owner)
    rotation_session, pending_session = db.session(site), db.session(site)
    active_material = db.token(rotation_session, 'material-rotation', rotating_key)
    unused_material = db.token(pending_session, 'material-rotation', rotating_key)
    mapped_lead = db.exchange(active_material)['lead_id']
    db.sql(f"update api_keys set key_hash='changed-fixture-material',lookup_hash='changed-lookup' where id='{rotating_key}';")
    db.check('in-place key material rotation revokes active and unused old-fingerprint tokens',
             db.exchange(active_material)['status'] == 'revoked' and
             db.exchange(unused_material)['status'] == 'revoked' and
             db.scalar(f"(select revoked_at is not null from visitor_session_identity_grants "
                       f"where session_id='{rotation_session['session']}')") == 't')
    db.check('fresh fingerprint after material rotation retains stable mapping',
             db.exchange(db.token(pending_session, 'material-rotation', rotating_key))['lead_id'] == mapped_lead)

    replacement = db.token(first, 'stable-subject', key)
    db.exchange(replacement)
    db.check('superseded token cannot restore or extend old grant', db.exchange(token)['status'] == 'revoked')
    db.sql(f"update visitor_session_identity_grants set expires_at=clock_timestamp()-interval '1 second' "
           f"where session_id='{first['session']}';")
    db.check('expired grant cannot be resurrected by exact retry', db.exchange(replacement)['status'] == 'revoked')
    db.check('expired grant retains subject boundary',
             db.exchange(db.token(first, 'switch-after-expiry', key))['status'] == 'identity_conflict')
    pending = db.token(second, 'stable-subject', rotated)
    db.sql(db.logout_sql(second))
    db.check('logout invalidates unused epoch-zero token and clears session',
             db.exchange(pending)['status'] == 'revoked' and
             db.scalar(f"(select lead_id is null and identified_at is null from visitor_sessions where id='{second['session']}')") == 't')
    db.check('logout invalidates consumed token',
             db.exchange(second_token)['status'] == 'revoked')
    db.check('fresh epoch can switch subjects after logout',
             db.exchange(db.token(second, 'different-subject', rotated, epoch=1))['lead_id'] == other_lead)
    db.sql(db.logout_sql(second))
    db.check('repeated logout increments epoch monotonically',
             db.scalar(f"(select epoch from visitor_identity_session_state where session_id='{second['session']}')") == '2')

    first_party = db.session(support)
    first_token = db.token(first_party, 'supabase-user', issuer='supabase:rnjgeloamtszdjplmqxy')
    db.check('first-party support issuer works without API key', db.exchange(first_token)['status'] == 'verified')
    db.check('first-party support issuer forbids integration key',
             db.exchange(dict(first_token, key=key))['status'] == 'invalid_token')
    db.check('first-party issuer cannot target arbitrary site',
             db.exchange(db.token(anonymous, 'wrong-support', issuer=first_token['issuer']))['status'] == 'invalid_token')

    for role in ('anon', 'authenticated'):
        db.sql(db.exchange_sql(token), role=role, error='permission denied for function')
        db.sql(db.logout_sql(first), role=role, error='permission denied for function')
        for table in ('visitor_identity_session_state', 'visitor_external_identities',
                      'visitor_identity_token_redemptions', 'visitor_identity_attributes'):
            db.sql(f'select * from {table};', role=role, error='permission denied for table')
            db.sql(f'delete from {table};', role=role, error='permission denied for table')
        db.check(role + ' cannot execute identity RPCs or read private tables', True)
    db.sql(db.exchange_sql(token), claim='authenticated', error='service_role_required')
    db.sql(db.logout_sql(first), claim='authenticated', error='service_role_required')
    db.check('service-role DB execution still requires service-role JWT claim', True)
    db.check('all new identity tables force RLS', db.sql("select bool_and(relrowsecurity and relforcerowsecurity) "
             "from pg_class where relname in ('visitor_identity_session_state','visitor_external_identities',"
             "'visitor_identity_token_redemptions','visitor_identity_attributes');", role='postgres') == 't')

    provisioning = ("insert into api_keys(name,key_hash,prefix,user_id,site_id,scopes,expires_at) "
                    f"values('Owner key','fixture','fixture','{owner}','{site}',array['identity:issue'],now()+interval '1 hour');")
    db.sql(provisioning, role='authenticated', actor=uid(4), error='identity_issuer_owner_required')
    db.sql(provisioning, role='authenticated', actor=owner)
    db.check('only site owner can provision identity:issue outside service role', True)

    # Force a failure after lead, mapping, and redemption writes, before the grant.
    db.sql("create function public.fixture_abort_grant() returns trigger language plpgsql as $$ "
           "begin if current_setting('fixture.fail_grant',true)='yes' then raise exception 'fixture_atomic_abort'; "
           "end if; return new; end $$; create trigger fixture_abort_grant before insert on "
           "visitor_session_identity_grants for each row execute function public.fixture_abort_grant();", role='postgres')
    atomic = db.token(db.session(site), 'atomic-failure', key)
    lead_count = db.row_count('leads', 'true')
    db.sql("set fixture.fail_grant='yes';" + db.exchange_sql(atomic), error='fixture_atomic_abort')
    db.check('grant failure rolls back lead, mapping, redemption and session atomically',
             db.row_count('leads', 'true') == lead_count and
             db.row_count('visitor_external_identities', "external_user_id='atomic-failure'") == 0 and
             db.row_count('visitor_identity_token_redemptions', f"jti='{atomic['jti']}'") == 0 and
             db.scalar(f"(select lead_id is null from visitor_sessions where id='{atomic['session']}')") == 't')
    db.sql('drop trigger fixture_abort_grant on visitor_session_identity_grants; drop function fixture_abort_grant();', role='postgres')
    db.check('same token succeeds after failed transaction rolls back', db.exchange(atomic)['status'] == 'verified')

    # Simulate CRM editing the token-only lead; both real legacy grant paths must deny.
    db.sql(f"update leads set email='edited@example.invalid' where id='{lead}';")
    new_session = db.session(site)
    db.sql(f"select grant_new_visitor_identity('{site}','{new_session['session']}',"
           f"'{new_session['visitor']}','{lead}','edited@example.invalid','otp-fixture');",
           error='external_identity_token_required')
    challenge = db.new_id()
    db.sql(f"select issue_visitor_identity_challenge('{challenge}','{site}','{new_session['session']}',"
           f"'{new_session['visitor']}','{lead}','edited@example.invalid','e***@example.invalid','fixture-hash');")
    db.sql(f"select verify_consume_visitor_identity_challenge('{challenge}','{site}',"
           f"'{new_session['session']}',true,'otp-fixture');", error='external_identity_token_required')
    db.check('new-lead and OTP paths cannot claim token-only lead after CRM email edit',
             db.row_count('visitor_session_identity_grants', f"session_id='{new_session['session']}'") == 0 and
             db.scalar(f"(select consumed_at is null from visitor_identity_challenges where id='{challenge}')") == 't')
    db.sql(db.logout_sql(new_session))
    db.check('logout cancels pending OTP challenge',
             db.scalar(f"(select cancelled_at is not null from visitor_identity_challenges where id='{challenge}')") == 't')