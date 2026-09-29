#!/usr/bin/env python3
"""Real PG17 integration checks. No network, packages, app config, or remote DB."""
import hashlib
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BIN = Path(os.environ.get('PG17_BIN', '/opt/homebrew/bin'))
MIGRATIONS = [
    '20260917210000_visitor_identity_verification.sql',
    '20260917233000_visitor_identity_verification_hardening.sql',
    '20260918013500_reuse_active_visitor_identity_challenge.sql',
    '20260929210000_visitor_identity_tokens.sql',
    '20260929221000_identity_credential_versions.sql',
]


def quoted(value):
    if value is None:
        return 'null'
    return "'" + str(value).replace("'", "''") + "'"


def uid(number):
    return str(uuid.UUID(int=number))


class Database:
    def __init__(self, env):
        self.env = env
        self.counter = 1000
        self.passed = 0
        self.children = []

    def new_id(self):
        self.counter += 1
        return uid(self.counter)

    def command(self):
        return [str(BIN / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']

    def sql(self, statement, role='service_role', claim=None, actor=None, error=None):
        prefix = f"set role {role}; set request.jwt.claim.role = {quoted(claim or role)};"
        if actor:
            prefix += f"set request.jwt.claim.sub = {quoted(actor)};"
        result = subprocess.run(self.command(), input=prefix + statement,
                                text=True, env=self.env, capture_output=True, timeout=25)
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr or result.stdout
            return result.stderr
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(self, name, condition):
        assert condition, name
        self.passed += 1
        print(f'PASS {self.passed:02d}: {name}', flush=True)

    def scalar(self, expression):
        return self.sql('select ' + expression + ';')

    def session(self, site):
        visitor, session = self.new_id(), self.new_id()
        self.sql(f"insert into visitors(id, first_seen_at, last_seen_at) values('{visitor}',1,1);"
                 f"insert into visitor_sessions(id,visitor_id,site_id,started_at,last_activity_at) "
                 f"values('{session}','{visitor}','{site}',1,1);")
        return {'site': site, 'session': session, 'visitor': visitor}

    def key(self, site, owner, changes=''):
        key = self.new_id()
        self.sql(f"insert into api_keys(id,name,key_hash,prefix,user_id,site_id,scopes,expires_at) "
                 f"values('{key}','Fixture issuer','not-a-real-key','fixture','{owner}',"
                 f"'{site}',array['identity:issue'],clock_timestamp()+interval '1 hour');" +
                 (f"update api_keys set {changes} where id='{key}';" if changes else ''))
        return key

    def token(self, session, subject, key=None, **changes):
        jti = self.new_id()
        issued = int(time.time())
        material = self.scalar(f"(select key_hash from api_keys where id='{key}')") if key else ''
        fingerprint = hashlib.sha256(material.encode()).hexdigest() if material else None
        version = self.scalar(f"(select identity_token_version from api_keys where id='{key}')") if key else None
        token = dict(session, subject=subject, key=key, fingerprint=fingerprint, version=version, jti=jti, epoch=0, issued=issued,
                     expires=issued + 90, issuer='integration:' + session['site'],
                     token_hash=hashlib.sha256(jti.encode()).hexdigest(), name='Fixture visitor',
                     email='asserted@example.invalid')
        token.update(changes)
        return token

    def exchange_sql(self, token):
        fields = ('site', 'session', 'visitor', 'issuer', 'subject', 'epoch', 'jti',
                  'issued', 'expires', 'token_hash', 'name', 'email', 'key', 'fingerprint', 'version')
        return 'select public.exchange_visitor_identity_token_v2(' + ','.join(
            quoted(token[field]) for field in fields) + ');'

    def exchange(self, token, **kwargs):
        import json
        return json.loads(self.sql(self.exchange_sql(token), **kwargs))

    def logout_sql(self, session):
        return ("select public.revoke_visitor_session_identity("
                f"'{session['site']}','{session['session']}');")

    def row_count(self, table, where):
        return int(self.scalar(f'(select count(*) from {table} where {where})'))


def main():
    version = subprocess.check_output([str(BIN / 'psql'), '--version'], text=True).strip()
    if ' 17.' not in version:
        raise RuntimeError('PostgreSQL 17 is required; set PG17_BIN to existing binaries')
    temp = Path(tempfile.mkdtemp(prefix='identity-pg-', dir='/tmp'))
    data, socket = temp / 'data', temp / 'socket'
    socket.mkdir(mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(LC_ALL='C', LANG='C', PGHOST=str(socket), PGPORT='55439', PGUSER='postgres', PGDATABASE='postgres',
               PGCONNECT_TIMEOUT='5', PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=12000',
               PGPASSFILE='/dev/null', PGSYSCONFDIR=str(temp))
    started = False
    db = None

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    previous = {s: signal.signal(s, interrupted) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        subprocess.run([str(BIN / 'initdb'), '-D', str(data), '-U', 'postgres',
                        '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'],
                       env=env, check=True, capture_output=True, text=True)
        boot = subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-l', str(temp / 'postgres.log'),
                        '-o', f"-k {socket} -p 55439 -c listen_addresses='' -c unix_socket_permissions=0700",
                        '-w', 'start'], env=env, capture_output=True, text=True)
        if boot.returncode:
            log = temp / 'postgres.log'
            raise RuntimeError(boot.stderr + (log.read_text() if log.exists() else boot.stdout))
        started = True
        db = Database(env)
        assert db.sql('show listen_addresses;', role='postgres') == ''
        print(f'{version}; private Unix socket only; cluster={temp}', flush=True)
        paths = [HERE / 'fixture.sql'] + [ROOT / 'supabase/migrations' / n for n in MIGRATIONS]
        for path in paths:
            snapshot = path.read_bytes()
            local_copy = temp / path.name
            local_copy.write_bytes(snapshot)
            result = subprocess.run(db.command() + ['-f', str(local_copy)], env=env,
                                    capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, f'{path.name}: {result.stderr}'
            print(f'APPLIED locally: {path.name} sha256={hashlib.sha256(snapshot).hexdigest()}', flush=True)
        if '--syntax-only' not in sys.argv:
            from sequential import run as sequential
            from concurrency import run as concurrency
            from credential_versions import run as credential_versions
            sequential(db)
            credential_versions(db)
            concurrency(db)
            print(f'SUCCESS: {db.passed} runtime assertions passed', flush=True)
    finally:
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        if db:
            for child in db.children:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
        if started or (data / 'postmaster.pid').exists():
            result = subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'],
                                    env=env, capture_output=True, text=True, timeout=30)
            if result.returncode:
                print(f'TEARDOWN FAILURE: inspect {temp}: {result.stderr}', file=sys.stderr)
                raise RuntimeError('Cluster stop failed; preserving data for investigation')
        shutil.rmtree(temp)
        print(f'TEARDOWN: stopped PG and removed {temp}', flush=True)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    main()