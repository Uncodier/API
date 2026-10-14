import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { workspaceOpenFailure } from '../workspace-open-failure';
import { workspaceProviderDiagnostic } from '../workspace-provider-diagnostic';

it('extracts only allowlisted validation constants, never echoed credentials or submitted values', () => {
  const username = randomBytes(12).toString('hex'); const password = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const url = new URL('https://provider.example.invalid/request'); url.username = username; url.password = password;
  url.searchParams.set('access_token', token);
  const error = { response: { status: 400, url: url.href, headers: { authorization: `Bearer ${token}` } },
    message: token, cause: new Error(password), text: username,
    json: { error: { code: 'bad_request', message: `Invalid request: networkPolicy.subnets.deny must use IPv4 CIDR ${url.href}`,
      errors: [{ instancePath: `/tags/${token}`, keyword: 'maxLength', message: `tags value ${password} too long` }],
      token, body: { env: { password }, headers: { authorization: token } } } } };
  const result = workspaceOpenFailure(error, 'create');
  expect(result.message).toContain('HTTP 400'); expect(result.message).toContain('operation=create');
  expect(result.message).toContain('provider_code=bad_request');
  expect(result.message).toContain('fields=networkPolicy,subnets,deny,tags');
  expect(result.message).toContain('rules=maxLength,ipv4,cidr');
  for (const secret of [username, password, token, url.href, encodeURIComponent(password)]) expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.message).not.toContain('provider.example.invalid');
});

it('does not echo unknown codes, nested data, SDK text or untrusted operation labels', () => {
  const secret = randomBytes(24).toString('hex');
  const error = { message: 'name must match pattern', text: secret,
    json: { error: { code: secret, metadata: { message: 'image required' } } } };
  expect(workspaceProviderDiagnostic(error, 'get')).toBe(' [workspace-v1 operation=get; provider_code=unclassified; fields=unclassified; rules=unclassified]');
  expect(workspaceProviderDiagnostic(error)).toBe('');
  expect(workspaceProviderDiagnostic(error, secret as 'get')).toBe('');
});

it.each([null, undefined, 'not JSON', [], { json: { error: null } }, { json: { error: { message: {}, errors: 'invalid' } } }])('handles malformed SDK metadata without serializing it: %p', error => {
  expect(workspaceProviderDiagnostic(error, 'get')).toContain('provider_code=unclassified');
});

it('bounds validation scanning and does not admit arbitrary numeric/submitted limits', () => {
  const error = { json: { error: { message: 'x'.repeat(2048) + ' name required',
    errors: Array.from({ length: 20 }, (_, i) => ({ message: i < 8 ? 'timeout must be less than 987654321' : 'image required' })) } } };
  const diagnostic = workspaceProviderDiagnostic(error, 'create');
  expect(diagnostic).toContain('fields=timeout'); expect(diagnostic).toContain('rules=maximum');
  expect(diagnostic).not.toContain('987654321'); expect(diagnostic).not.toContain('image');
  expect(diagnostic.length).toBeLessThan(1000);
});

it('recognizes missing snapshot separately from an otherwise unclassified HTTP 400', () => {
  expect(workspaceProviderDiagnostic({ json: { error: { code: 'bad_request', message: 'Cannot resume sandbox: no snapshot available.' } } }, 'get'))
    .toContain('rules=snapshotMissing');
});

it('reads the real installed SDK APIError JSON contract using fake transport only', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { randomBytes } from 'node:crypto';
    import { Sandbox } from '@vercel/sandbox';
    globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
    const token = randomBytes(24).toString('hex');
    try {
      await Sandbox.create({ token, teamId: 'offline-team', projectId: 'offline-project', name: 'offline-test',
        fetch: async () => new Response(JSON.stringify({ error: { code: 'bad_request',
          message: 'Invalid request: name must match pattern' } }), { status: 400 }) });
    } catch (error) { console.log(JSON.stringify({ response: { status: error.response?.status }, json: error.json })); }
  `], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, NODE_ENV: 'test', CI: '1' } });
  const result = workspaceOpenFailure(JSON.parse(output), 'create');
  expect(result.message).toContain('HTTP 400'); expect(result.message).toContain('fields=name; rules=pattern');
});