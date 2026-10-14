import { randomBytes } from 'node:crypto';
import { createRedactor, operationFingerprint, runtimeSecretValues, safeError } from '../security';

const synthetic = () => randomBytes(24).toString('hex');

describe('portable secret redaction and operation identity', () => {
  it('removes synthetic userinfo, bearer, signed query values, JWTs and known raw/encoded secrets independently', () => {
    const username = synthetic(); const password = synthetic(); const bearer = synthetic(); const signature = synthetic();
    const known = `${synthetic()} /+${synthetic()}`;
    const jwt = [Buffer.from(JSON.stringify({ alg: 'HS256', marker: synthetic() })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: synthetic() })).toString('base64url'), randomBytes(32).toString('base64url')].join('.');
    const url = new URL('https://example.invalid/receipt'); url.username = username; url.password = password; url.searchParams.set('signature', signature);
    const redact = createRedactor([known]);
    const output = redact(`${url}\nBearer ${bearer}\n${jwt}\n${known}\n${encodeURIComponent(known)}`);
    for (const value of [username, password, bearer, signature, jwt, known, encodeURIComponent(known)]) expect(output).not.toContain(value);
    expect(output).toContain('example.invalid/receipt');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('[REDACTED_JWT]');
  });

  it.each(['access_token', 'refresh_token', 'api_key', 'secret', 'signature', 'password'])('removes synthetic %s query values without corrupting public parameters', key => {
    const secret = synthetic(); const url = new URL('https://example.test/callback');
    url.searchParams.set('page', '2'); url.searchParams.set(key, secret); url.searchParams.set('format', 'json');
    const safe = createRedactor()(url.toString());
    expect(safe).not.toContain(secret); expect(safe).toContain('page=2'); expect(safe).toContain('format=json');
  });

  it('redacts longest exact values first and never serializes the host-known list', () => {
    const short = synthetic(); const long = short + synthetic(); const secrets = [short, long, '', long];
    const redact = createRedactor(secrets);
    const output = redact(`${long} ${short}`);
    expect(output).toBe('[REDACTED] [REDACTED]');
    expect(secrets).toEqual([short, long, '', long]);
    expect(JSON.stringify(redact)).toBeUndefined();
  });

  it('redacts escaped known values inside JSON without invalidating its syntax', () => {
    const secret = `${synthetic()}\n"${synthetic()}\\${synthetic()}`;
    const redact = createRedactor([secret]);
    const output = redact(JSON.stringify({ output: secret, public: 'retained' }));
    expect(JSON.parse(output)).toEqual({ output: '[REDACTED]', public: 'retained' });
    expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(redact(secret)).not.toContain(secret);
  });

  it('preserves ordinary email addresses, code and password/key field names rather than blocking arbitrary repo edits', () => {
    const source = "const email = 'maintainer@example.test'; const form = { password: input.password, api_key: settings.api_key };";
    const schema = JSON.stringify({ type: 'object', properties: { password: { type: 'string' }, email: { type: 'string' } } });
    const redact = createRedactor();
    expect(redact(source)).toBe(source); expect(redact(schema)).toBe(schema);
  });

  it('redacts errors before truncation and omits stacks and attached provider request objects', () => {
    const secret = synthetic(); const error = new Error(`${'x'.repeat(1980)} Bearer ${secret} ${'z'.repeat(3000)}`);
    Object.assign(error, { request: { authorization: secret } });
    const output = safeError(error, createRedactor([secret]));
    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output).not.toContain(secret); expect(output).not.toContain('authorization'); expect(output).not.toContain('at ');
    expect(safeError(`Bearer ${secret}`, createRedactor())).not.toContain(secret);
  });

  it('does not treat public short runtime configuration as secrets but includes credential-related values', () => {
    const privateKey = synthetic(); const token = synthetic(); const connection = synthetic(); const signing = synthetic();
    const values = runtimeSecretValues({ CI: '1', PORT: '3000', NODE_ENV: 'test', APP_NAME: 'example',
      PRIVATE_KEY: privateKey, SERVICE_TOKEN: token, DATABASE_URL: connection, JWT_SIGNING_KEY: signing });
    for (const secret of [privateKey, token, connection, signing]) expect(values).toContain(secret);
    for (const publicValue of ['1', '3000', 'test', 'example']) expect(values).not.toContain(publicValue);
    expect(createRedactor(values)('const count = 1; const port = 3000;')).toBe('const count = 1; const port = 3000;');
  });

  it('identifies equivalent nested operations regardless of object-key order without leaking arguments', () => {
    const credential = synthetic();
    const left = { z: [{ b: 2, a: 1 }], connection: { credential, region: 'local' } };
    const right = { connection: { region: 'local', credential }, z: [{ a: 1, b: 2 }] };
    const fingerprint = operationFingerprint('publish', left);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain(credential);
    expect(operationFingerprint('publish', right)).toBe(fingerprint);
    expect(operationFingerprint('inspect', right)).not.toBe(fingerprint);
    expect(operationFingerprint('publish', { ...right, z: [{ a: 1, b: 3 }] })).not.toBe(fingerprint);
    expect(operationFingerprint('publish', [1, 2])).not.toBe(operationFingerprint('publish', [2, 1]));
  });
});