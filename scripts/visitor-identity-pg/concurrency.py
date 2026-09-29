"""Deterministic real-connection lock races, not mocked RPC concurrency."""
import json
import os
import select
import subprocess
import time
from run import uid


class Holder:
    """Keep an explicit transaction open until test workers are observed waiting."""
    def __init__(self, db, statement):
        self.db = db
        self.process = subprocess.Popen(db.command(), env=db.env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        db.children.append(self.process)
        self.process.stdin.write("set request.jwt.claim.role='service_role';begin;" + statement +
                                 "select 'fixture_lock_held';\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 10
        received = b''
        while time.monotonic() < deadline:
            if select.select([self.process.stdout], [], [], 0.1)[0]:
                received += os.read(self.process.stdout.fileno(), 4096)
                if b'fixture_lock_held\n' in received:
                    return
            if self.process.poll() is not None:
                raise AssertionError(self.process.stderr.read())
        self.process.kill()
        raise AssertionError('Timed out acquiring fixture lock')

    def release(self):
        out, err = self.process.communicate('commit;\n', timeout=15)
        assert self.process.returncode == 0, err or out


def worker(db, statement, name):
    env = dict(db.env, PGAPPNAME=name)
    process = subprocess.Popen(db.command() + ['-c', "set role service_role;"
                            "set request.jwt.claim.role='service_role';" + statement],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    db.children.append(process)
    return process


def blocked(db, names):
    quoted = ','.join("'" + n + "'" for n in names)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        count = db.sql("select count(*) from pg_stat_activity where "
                       f"application_name in ({quoted}) and wait_event_type='Lock';", role='postgres')
        if int(count) == len(names):
            return
        time.sleep(0.025)
    raise AssertionError('Workers did not reach expected real PostgreSQL lock waits')


def finish(process):
    out, err = process.communicate(timeout=20)
    assert process.returncode == 0, err or out
    return json.loads(out.strip().splitlines()[-1])


def session_lock(session):
    return f"select pg_advisory_xact_lock(hashtextextended('{session['session']}',0));"


def identity_lock(site, subject):
    return f"select pg_advisory_xact_lock(hashtextextended('{site}:integration:{site}:{subject}',1));"


def run(db):
    site, owner = uid(1), uid(3)
    key = db.key(site, owner)
    a, b = db.session(site), db.session(site)
    tokens = [db.token(a, 'parallel-mapping', key), db.token(b, 'parallel-mapping', key)]
    hold = Holder(db, identity_lock(site, 'parallel-mapping'))
    workers = [worker(db, db.exchange_sql(t), f'mapping-{i}') for i, t in enumerate(tokens)]
    blocked(db, ['mapping-0', 'mapping-1'])
    hold.release()
    results = [finish(w) for w in workers]
    db.check('concurrent first exchanges serialize one mapping/lead across sessions',
             all(r['status'] == 'verified' for r in results) and
             results[0]['lead_id'] == results[1]['lead_id'] and
             db.row_count('visitor_external_identities', "external_user_id='parallel-mapping'") == 1 and
             db.row_count('visitor_session_identity_grants', f"lead_id='{results[0]['lead_id']}'") == 2)

    same = db.session(site)
    token = db.token(same, 'parallel-jti', key)
    hold = Holder(db, session_lock(same))
    workers = [worker(db, db.exchange_sql(token), f'jti-{i}') for i in range(2)]
    blocked(db, ['jti-0', 'jti-1'])
    hold.release()
    results = [finish(w) for w in workers]
    db.check('concurrent exact-token duplicate is idempotent with identical grant expiry',
             results[0] == results[1] and results[0]['status'] == 'verified' and
             db.row_count('visitor_identity_token_redemptions', f"jti='{token['jti']}'") == 1)

    # Force both legal linearizations, rather than depending on scheduler luck.
    before = db.session(site)
    pre_token = db.token(before, 'logout-wins', key)
    hold = Holder(db, db.logout_sql(before))
    waiting = worker(db, db.exchange_sql(pre_token), 'logout-first')
    blocked(db, ['logout-first'])
    hold.release()
    db.check('concurrent logout commits first: unused old-epoch exchange rejects',
             finish(waiting)['status'] == 'revoked' and
             db.row_count('visitor_identity_token_redemptions', f"jti='{pre_token['jti']}'") == 0)

    after = db.session(site)
    post_token = db.token(after, 'exchange-wins', key)
    hold = Holder(db, db.exchange_sql(post_token))
    waiting = worker(db, db.logout_sql(after), 'exchange-first')
    blocked(db, ['exchange-first'])
    hold.release()
    logout = finish(waiting)
    db.check('concurrent exchange commits first: logout removes resulting access',
             logout['status'] == 'revoked' and db.exchange(post_token)['status'] == 'revoked' and
             db.scalar(f"(select lead_id is null from visitor_sessions where id='{after['session']}')") == 't' and
             db.scalar(f"(select revoked_at is not null from visitor_session_identity_grants "
                       f"where session_id='{after['session']}')") == 't')

    hold = Holder(db, session_lock(same))
    workers = [worker(db, db.logout_sql(same), f'logout-{i}') for i in range(2)]
    blocked(db, ['logout-0', 'logout-1'])
    hold.release()
    results = [finish(w) for w in workers]
    db.check('two concurrent logouts increment epoch without lost update',
             all(r['status'] == 'revoked' for r in results) and
             db.scalar(f"(select epoch from visitor_identity_session_state where session_id='{same['session']}')") == '2')

    key_a, key_b = db.key(site, owner), db.key(site, owner)
    revoking = db.session(site)
    revoke_token = db.token(revoking, 'revoke-first', key_a)
    hold = Holder(db, f"update api_keys set status='revoked' where id='{key_a}';")
    waiting = worker(db, db.exchange_sql(revoke_token), 'revoke-key-first')
    blocked(db, ['revoke-key-first'])
    hold.release()
    db.check('concurrent key revocation commits first: unused token rejects', finish(waiting)['status'] == 'revoked')

    granting = db.session(site)
    grant_token = db.token(granting, 'grant-before-revoke', key_b)
    hold = Holder(db, db.exchange_sql(grant_token))
    waiting = worker(db, f"update api_keys set status='revoked' where id='{key_b}';select '{{}}'::jsonb;", 'grant-key-first')
    blocked(db, ['grant-key-first'])
    hold.release()
    finish(waiting)
    db.check('concurrent exchange commits before key revoke: trigger revokes new grant without deadlock',
             db.exchange(grant_token)['status'] == 'revoked' and
             db.scalar(f"(select revoked_at is not null from visitor_session_identity_grants "
                       f"where session_id='{granting['session']}')") == 't')

    # Valid initially, expires while blocked: refresh the wall clock after each wait.
    for stage in ('key', 'identity'):
        delayed = db.session(site)
        subject = 'delayed-' + stage
        issued = int(time.time()) - 87
        expiring = db.token(delayed, subject, key, issued=issued, expires=issued + 90)
        lock = (f"select 1 from api_keys where id='{key}' for update;" if stage == 'key'
                else identity_lock(site, subject))
        hold = Holder(db, lock)
        waiting = worker(db, db.exchange_sql(expiring), 'expiry-' + stage)
        blocked(db, ['expiry-' + stage])
        time.sleep(max(0, expiring['expires'] - time.time()) + 0.15)
        hold.release()
        # The v2 credential lock may delay entering the original helper. Expiry
        # is then detected by its admission check instead of its post-lock check.
        result = finish(waiting)
        db.check('token expiring during ' + stage + ' lock wait cannot grant',
                 result['status'] in ('revoked', 'invalid_token') and
                 db.row_count('visitor_identity_token_redemptions', f"jti='{expiring['jti']}'") == 0)