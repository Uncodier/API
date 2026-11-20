import { describeConnectorTool, executeConnectorTool } from '../composio-sessions';
import { verifyAccountIdentity } from '../composio-accounts';
import { accountFixture, connectorFixture, providerFixture, toolFixture, jsonResponse, secret } from './composio-fixtures';

const originalFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => { jest.clearAllMocks(); global.fetch = fetchMock; });
afterAll(() => { global.fetch = originalFetch; });

it('rejects provider-disabled ACTIVE accounts before execution', async () => {
  const client = { request: jest.fn(async () => ({ ...accountFixture(), is_disabled: true })) };
  await expect(verifyAccountIdentity(client as any, { accountId: 'ca_one', userId: 'site_one', toolkitSlug: 'gmail', authConfigId: 'ac_one' }))
    .rejects.toMatchObject({ code: 'CONNECTOR_ACCOUNT_MISMATCH' });
});

it('preserves provider pagination while still removing authentication tokens', async () => {
  const base = { credential: { apiKey: secret(), revision: 'a'.repeat(64) }, connector: connectorFixture(), provider: providerFixture(), toolSlug: 'GMAIL_FETCH_EMAILS' };
  fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture()));
  const descriptor = await describeConnectorTool(base); fetchMock.mockReset();
  const sensitive = secret();
  fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture())).mockResolvedValueOnce(jsonResponse(accountFixture()))
    .mockResolvedValueOnce(jsonResponse({ successful: true, error: null, data: { messages: [{ id: 'one' }], nextPageToken: 'page-two', access_token: sensitive } }));
  const result = await executeConnectorTool({ ...base, input: {}, allowedTools: [base.toolSlug], requiredScopes: ['email.read'],
    toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash, beforeDispatch: async () => undefined });
  expect(result.data).toEqual({ messages: [{ id: 'one' }], nextPageToken: 'page-two' });
  expect(JSON.stringify(result)).not.toContain(sensitive);
});