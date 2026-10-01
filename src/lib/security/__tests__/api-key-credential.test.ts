import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { extractApiKeyCredential, isServiceApiKeyCredential } from '../api-key-credential';

const credential = 'test-only-service-credential';
const previousKey = process.env.SERVICE_API_KEY;
beforeEach(() => { process.env.SERVICE_API_KEY = credential; });
afterEach(() => {
  if (previousKey === undefined) delete process.env.SERVICE_API_KEY;
  else process.env.SERVICE_API_KEY = previousKey;
});

describe('shared API-key credential extraction and verification', () => {
  it.each([
    [{ 'x-api-key': credential }, credential, true],
    [{ authorization: `Bearer ${credential}` }, credential, true],
    [{ authorization: credential }, credential, true],
    [{ 'x-api-key': credential, authorization: 'Bearer wrong' }, credential, true],
    [{ 'x-api-key': 'wrong', authorization: `Bearer ${credential}` }, 'wrong', false],
    [{ 'x-api-key': '', authorization: `Bearer ${credential}` }, credential, true],
    [{ authorization: `bearer ${credential}` }, `bearer ${credential}`, false],
    [{ authorization: `Bearer  ${credential}` }, ` ${credential}`, false],
    [{ 'x-api-key-data': '{"isService":true}', 'x-auth-validated': 'true' }, null, false],
    [{}, null, false],
  ] as Array<[Record<string, string>, string | null, boolean]>)('extracts %j with the established precedence', async (headers, expected, service) => {
    const extracted = extractApiKeyCredential({ headers: new Headers(headers) });
    expect(extracted).toBe(expected);
    expect(await isServiceApiKeyCredential(extracted)).toBe(service);
  });

  it.each([
    null, '', credential.slice(0, -1), `${credential}x`, `x${credential.slice(1)}`,
    credential.toUpperCase(), `${credential}\0`, `${credential},${credential}`,
  ])('rejects missing credentials, prefixes, length mismatches and altered values (%j)', async value => {
    expect(await isServiceApiKeyCredential(value)).toBe(false);
  });

  it('trims only the configured service key, preserving authentication semantics', async () => {
    process.env.SERVICE_API_KEY = `  ${credential}\n`;
    expect(await isServiceApiKeyCredential(credential)).toBe(true);
    expect(await isServiceApiKeyCredential(` ${credential}`)).toBe(false);
  });

  it('re-reads configuration instead of retaining credentials after rotation', async () => {
    expect(await isServiceApiKeyCredential(credential)).toBe(true);
    process.env.SERVICE_API_KEY = 'test-only-rotated-credential';
    expect(await isServiceApiKeyCredential(credential)).toBe(false);
    expect(await isServiceApiKeyCredential('test-only-rotated-credential')).toBe(true);
    delete process.env.SERVICE_API_KEY;
    expect(await isServiceApiKeyCredential(credential)).toBe(false);
  });
});