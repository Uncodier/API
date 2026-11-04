#!/usr/bin/env python3
"""Read-only live checks of the disabled foundation; never submits generation."""
import argparse
import json
import re
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--token-file', type=Path, required=True)
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.endpoint)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise SystemExit('An HTTPS endpoint without credentials or query is required')
    token = args.token_file.read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise SystemExit('Invalid credential file format')
    opener = urllib.request.build_opener(NoRedirect())
    checks = [('/healthz', False, 200), ('/readyz', True, 503),
              ('/v1/models', False, 401), ('/v1/videos/models', True, 200),
              ('/api/v1/videos/models', True, 200), ('/v1/videos/missing', True, 404),
              ('/v1/videos/missing/content', True, 404)]
    for path, auth, expected in checks:
        headers = {'Authorization': 'Bearer ' + token} if auth else {}
        request = urllib.request.Request(args.endpoint.rstrip('/') + path, headers=headers)
        try:
            response = opener.open(request, timeout=120)
        except urllib.error.HTTPError as error:
            response = error
        except (ValueError, OSError):
            raise SystemExit('Endpoint transport check failed; details suppressed to protect credentials') from None
        with response:
            status = response.code
            body = response.read(64 * 1024).decode()
        if token in body:
            raise SystemExit('Credential exposure detected')
        if status != expected:
            raise SystemExit(f'{path}: unexpected HTTP {status}')
        data = json.loads(body)
        if path.endswith('/models') and auth:
            assert data['data'] == [], 'Blocked foundation must not advertise models'
        if path == '/readyz':
            assert data['generation_enabled'] is False
        print(f'PASS {path}: HTTP {status}')


if __name__ == '__main__':
    main()