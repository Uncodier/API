import { createHash, randomBytes } from 'node:crypto';
import { loadConnectorCredential } from '../access';
import { readProviderBinding } from '../provider-binding';

const from = jest.fn(); const decrypt = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: (...args: unknown[]) => from(...args) } }));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: (...args: unknown[]) => decrypt(...args) }));
const siteId = '11111111-1111-4111-8111-111111111111';
const otherSite = '22222222-2222-4222-8222-222222222222';
const originalEnv = { ...process.env };
const globalKey = randomBytes(32).toString('hex');
function query(data: unknown, error: unknown = null) {
  const result: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve) };
  for (const name of ['select','eq','is','abortSignal','maybeSingle']) result[name] = jest.fn(() => result);
  return result;
}
beforeEach(() => {
  jest.clearAllMocks(); process.env.COMPOSIO_API_KEY = globalKey; delete process.env.COMPOSIO_PROJECT_API_KEY;
  process.env.COMPOSIO_PROJECT_ID = 'platform_project'; process.env.CONNECTORS_WEB_ORIGIN = 'https://app.example.test';
  from.mockImplementation(() => query(null)); decrypt.mockReturnValue(randomBytes(32).toString('hex'));
});
afterAll(() => { process.env = originalEnv; });

it('uses platform credentials only when the site BYOK row is absent', async () => {
  const credential = await loadConnectorCredential(siteId);
  expect(credential).toEqual({ apiKey: globalKey, source: 'platform', revision: `platform:${createHash('sha256').update(globalKey).digest('hex')}` });
  expect(decrypt).not.toHaveBeenCalled();
  await expect(readProviderBinding(siteId, credential.revision)).resolves.toEqual({ projectId: 'platform_project', callbackUrl: 'https://app.example.test/connectors/callback' });
  await expect(readProviderBinding(otherSite, credential.revision)).resolves.toMatchObject({ projectId: 'platform_project' });
});

it('gives a site BYOK precedence over a global key', async () => {
  const encrypted = randomBytes(48).toString('hex'); const ownKey = randomBytes(32).toString('hex');
  from.mockImplementation(() => query({ encrypted_value: encrypted })); decrypt.mockReturnValue(ownKey);
  expect(await loadConnectorCredential(siteId)).toEqual({ apiKey: ownKey, source: 'byok', revision: createHash('sha256').update(encrypted).digest('hex') });
});

it('does not fall back on DB errors, malformed BYOK or decryption failures', async () => {
  from.mockImplementationOnce(() => query(null, { code: 'offline' }));
  await expect(loadConnectorCredential(siteId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  from.mockImplementationOnce(() => query({ encrypted_value: null }));
  await expect(loadConnectorCredential(siteId)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' });
  from.mockImplementationOnce(() => query({ encrypted_value: 'unreadable' })); decrypt.mockReturnValue(null);
  await expect(loadConnectorCredential(siteId)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' });
});

it('supports the legacy global env name and fails closed if neither exists', async () => {
  delete process.env.COMPOSIO_API_KEY; process.env.COMPOSIO_PROJECT_API_KEY = globalKey;
  expect((await loadConnectorCredential(siteId)).source).toBe('platform');
  delete process.env.COMPOSIO_PROJECT_API_KEY;
  await expect(loadConnectorCredential(siteId)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
});

it('rejects stale platform key revision and missing project binding for OAuth', async () => {
  const credential = await loadConnectorCredential(siteId);
  process.env.COMPOSIO_API_KEY = randomBytes(32).toString('hex');
  await expect(readProviderBinding(siteId, credential.revision)).rejects.toThrow('changed');
  delete process.env.COMPOSIO_PROJECT_ID;
  await expect(readProviderBinding(siteId, credential.revision)).rejects.toThrow('not configured');
});