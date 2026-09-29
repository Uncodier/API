"""Regression checks for pending assertions surviving credential changes."""
from run import quoted as q, uid
from concurrency import Holder, blocked, finish, worker


def run(db):
    site, owner = uid(1), uid(3)
    mutations = [
        ('lookup only', "lookup_hash='updated-index'", 'lookup_hash=null'),
        ('owner only', f"user_id='{uid(4)}'", f"user_id='{owner}'"),
        ('scope change', "scopes=array['identity:issue','read']", "scopes=array['identity:issue']"),
        ('expiry extension', "expires_at=expires_at+interval '1 hour'", "expires_at=expires_at-interval '1 hour'"),
        ('status cycle', "status='revoked'", "status='active'"),
    ]
    for label, change, revert in mutations:
        key = db.key(site, owner)
        active, pending = db.session(site), db.session(site)
        used, unused = db.token(active, label, key), db.token(pending, label, key)
        lead = db.exchange(used)['lead_id']
        db.sql(f"update api_keys set {change} where id='{key}';")
        db.check(label + ' changes credential version and invalidates unused assertion',
                 db.exchange(unused)['status'] == 'revoked' and
                 db.scalar(f"(select identity_token_version from api_keys where id='{key}')") != unused['version'])
        db.check(label + ' also revokes existing grant',
                 db.scalar(f"(select revoked_at is not null from visitor_session_identity_grants "
                           f"where session_id='{active['session']}')") == 't')
        db.sql(f"update api_keys set {revert} where id='{key}';")
        db.check(label + ' revert cannot resurrect old assertion', db.exchange(unused)['status'] == 'revoked')
        db.check(label + ' fresh assertion preserves immutable subject mapping',
                 db.exchange(db.token(pending, label, key))['lead_id'] == lead)

    key = db.key(site, owner)
    token = db.token(db.session(site), 'no-op-metadata', key)
    db.sql(f"update api_keys set name='Renamed key',updated_at=clock_timestamp(),"
           f"identity_token_version='{uid(99)}' where id='{key}';")
    db.check('metadata and caller version override do not rotate or replace version',
             db.scalar(f"(select identity_token_version from api_keys where id='{key}')") == token['version']
             and db.exchange(token)['status'] == 'verified')
    db.check('integration assertion must include version', db.exchange(dict(token, version=None))['status'] == 'revoked')
    legacy_sql = db.exchange_sql(token).replace('exchange_visitor_identity_token_v2', 'exchange_visitor_identity_token')
    legacy_sql = legacy_sql.replace(',' + q(token['version']) + ');', ');')
    db.sql(legacy_sql, error='permission denied for function')
    db.check('service role cannot bypass the wrapper using the old RPC', True)

    support = db.session('9be0a6a2-5567-41bf-ad06-cb4014f0faf2')
    first_party = db.token(support, 'first-party-version', issuer='supabase:rnjgeloamtszdjplmqxy')
    db.check('first-party tokens reject integration version fields',
             db.exchange(dict(first_party, version=uid(99)))['status'] == 'invalid_token')

    supplied = db.new_id()
    db.sql("insert into api_keys(id,name,key_hash,prefix,user_id,site_id,scopes,expires_at,identity_token_version) "
           f"values('{supplied}','Supplied version','fixture','fixture','{owner}','{site}',"
           f"array['identity:issue'],now()+interval '1 hour','{uid(99)}');")
    db.check('insert cannot choose a previously used credential version',
             db.scalar(f"(select identity_token_version from api_keys where id='{supplied}')") != uid(99))

    # Real independent connections: credential revision is checked under the
    # same row lock held until the complete grant transaction commits.
    key = db.key(site, owner)
    token = db.token(db.session(site), 'version-update-first', key)
    hold = Holder(db, f"update api_keys set lookup_hash='concurrent-change' where id='{key}';")
    pending = worker(db, db.exchange_sql(token), 'version-update-first')
    blocked(db, ['version-update-first'])
    hold.release()
    db.check('concurrent lookup-only change commits before exchange and rejects pending token',
             finish(pending)['status'] == 'revoked')

    key = db.key(site, owner)
    session = db.session(site)
    token = db.token(session, 'version-exchange-first', key)
    hold = Holder(db, db.exchange_sql(token))
    pending = worker(db, f"update api_keys set user_id='{uid(4)}' where id='{key}';select '{{}}'::jsonb;", 'version-exchange-first')
    blocked(db, ['version-exchange-first'])
    hold.release()
    finish(pending)
    db.check('concurrent owner change commits after exchange and revokes the completed grant',
             db.scalar(f"(select revoked_at is not null from visitor_session_identity_grants "
                       f"where session_id='{session['session']}')") == 't'
             and db.exchange(token)['status'] == 'revoked')