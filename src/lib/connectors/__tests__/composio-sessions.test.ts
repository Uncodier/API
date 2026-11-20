import { describeConnectorTool, executeConnectorTool, hashConnectorSchema, validateConnectorArguments } from '../composio-sessions';
import { ConnectorError } from '../types';
import { accountFixture, connectorFixture, jsonResponse, providerFixture, secret, toolFixture } from './composio-fixtures';

describe('Composio explicit version-pinned REST execution', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock; });
  afterEach(() => { global.fetch = originalFetch; });
  const baseInput = () => ({ credential: { apiKey: secret(), revision: 'a'.repeat(64) },
    connector: connectorFixture(), provider: providerFixture(), toolSlug: 'GMAIL_FETCH_EMAILS' });
  async function prepared() {
    const input = baseInput();
    fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture()));
    const descriptor = await describeConnectorTool(input);
    fetchMock.mockClear();
    return { ...input, input: { max_results: 5 }, allowedTools: ['GMAIL_FETCH_EMAILS'], requiredScopes: ['email.read'],
      toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash, beforeDispatch: jest.fn(async () => undefined) };
  }
  const executionResponses = (data: unknown = { messages: [] }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture()))
      .mockResolvedValueOnce(jsonResponse(accountFixture()))
      .mockResolvedValueOnce(jsonResponse({ successful: true, error: null, data, log_id: 'log_one' }));
  };

  it('describes a single provider tool without sessions, automatic auth or eager tool catalogue', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture()));
    const descriptor = await describeConnectorTool(baseInput());
    expect(descriptor).toMatchObject({ slug: 'GMAIL_FETCH_EMAILS', toolkitSlug: 'gmail', toolkitVersion: '20261119_00', scopes: ['email.read'] });
    expect(descriptor.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://backend.composio.dev/api/v3.1/tools/GMAIL_FETCH_EMAILS');
  });

  it('has deterministic hashes independent of JSON object property order', () => {
    expect(hashConnectorSchema({ type: 'object', properties: { a: { type: 'string' } } }))
      .toBe(hashConnectorSchema({ properties: { a: { type: 'string' } }, type: 'object' }));
  });

  it('pins exact account, user and concrete version; invokes fresh authority after metadata and before dispatch', async () => {
    const input = await prepared(); executionResponses();
    input.beforeDispatch.mockImplementation(async () => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(await executeConnectorTool(input)).toMatchObject({ successful: true, data: { messages: [] }, logId: 'log_one' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain('/tools/GMAIL_FETCH_EMAILS?version=20261119_00');
    expect(fetchMock.mock.calls[2][0]).toBe('https://backend.composio.dev/api/v3.1/tools/execute/GMAIL_FETCH_EMAILS');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      connected_account_id: 'ca_one', user_id: 'site_one', version: '20261119_00', arguments: { max_results: 5 },
    });
    expect(input.beforeDispatch).toHaveBeenCalledTimes(1);
  });

  it('takes an argument snapshot so mutation during reauthorization cannot change dispatch', async () => {
    const input = await prepared(); executionResponses();
    input.beforeDispatch.mockImplementation(async () => { input.input.max_results = 999; });
    await executeConnectorTool(input);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).arguments).toEqual({ max_results: 5 });
  });

  it('binds the documented Gmail mailbox field to me without accepting caller overrides', async () => {
    const base = baseInput();
    const original = toolFixture();
    const tool = { ...original, input_parameters: { ...original.input_parameters,
      properties: { ...original.input_parameters.properties, user_id: { type: 'string', default: 'me' } },
    } };
    fetchMock.mockResolvedValueOnce(jsonResponse(tool));
    const descriptor = await describeConnectorTool(base);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(tool)).mockResolvedValueOnce(jsonResponse(accountFixture()))
      .mockResolvedValueOnce(jsonResponse({ successful: true, error: null, data: {} }));
    await executeConnectorTool({ ...base, input: { max_results: 5 }, allowedTools: [base.toolSlug], requiredScopes: ['email.read'],
      toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash, beforeDispatch: async () => undefined });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).arguments).toEqual({ max_results: 5, user_id: 'me' });
    fetchMock.mockClear();
    await expect(executeConnectorTool({ ...base, input: { user_id: 'me' }, allowedTools: [base.toolSlug], requiredScopes: ['email.read'],
      toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash, beforeDispatch: async () => undefined }))
      .rejects.toMatchObject({ effectStarted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not dispatch on fresh revocation, and reports proven no effect', async () => {
    const input = await prepared(); executionResponses();
    input.beforeDispatch.mockRejectedValue(new ConnectorError('ACCESS_DENIED', 'Access changed.', 403));
    await expect(executeConnectorTool(input)).rejects.toMatchObject({ code: 'ACCESS_DENIED', executed: false, effectStarted: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(call => call[1].method === 'GET')).toBe(true);
  });

  it.each(['latest', 'stable', 'default', ''])('requires pinned version instead of %s before provider contact', async toolkitVersion => {
    const input = await prepared();
    await expect(executeConnectorTool({ ...input, toolkitVersion })).rejects.toMatchObject({ executed: false, effectStarted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires exact local binding and allowlist with a fresh-authorization callback', async () => {
    const input = await prepared();
    const attempts = [
      { ...input, allowedTools: [] },
      { ...input, allowedTools: ['GMAIL_SEND_EMAIL'] },
      { ...input, provider: { ...input.provider, project_id: 'foreign_project' } },
      { ...input, credential: { ...input.credential, revision: 'b'.repeat(64) } },
      { ...input, connector: { ...input.connector, revocation_pending: true } },
      { ...input, connector: { ...input.connector, enabled: false } },
      { ...input, beforeDispatch: undefined as never },
    ];
    for (const attempt of attempts) await expect(executeConnectorTool(attempt)).rejects.toMatchObject({ effectStarted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { slug: 'GMAIL_SEND_EMAIL' }, { toolkit: { slug: 'slack' } }, { version: 'latest' },
    { version: '20261120_00' }, { no_auth: true }, { is_deprecated: true },
    { input_parameters: { $ref: 'https://schemas.example.test/tool' } },
  ])('rejects changed or unsupported provider schema without execution', async change => {
    const input = await prepared();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...toolFixture(), ...change }));
    await expect(executeConnectorTool(input)).rejects.toMatchObject({ effectStarted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('detects changed schema or scopes at the same nominal version', async () => {
    const input = await prepared();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...toolFixture(), scopes: ['email.write'] }));
    await expect(executeConnectorTool(input)).rejects.toMatchObject({ code: 'CONNECTOR_SCHEMA_CHANGED', effectStarted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('verifies current provider scopes rather than relying on local cached grants', async () => {
    const input = await prepared();
    fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture()))
      .mockResolvedValueOnce(jsonResponse({ ...accountFixture(), state: { val: { scope: 'profile' } } }));
    await expect(executeConnectorTool(input)).rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_MISSING', effectStarted: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not assume new structured scope requirements are represented by flat scopes', async () => {
    const base = baseInput(); const tool = { ...toolFixture(), scope_requirements: { any_of: ['email.read'] } };
    fetchMock.mockResolvedValueOnce(jsonResponse(tool));
    const descriptor = await describeConnectorTool(base);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(tool)).mockResolvedValueOnce(jsonResponse(accountFixture()));
    await expect(executeConnectorTool({ ...base, input: {}, allowedTools: [base.toolSlug], requiredScopes: [], toolkitVersion: descriptor.toolkitVersion,
      schemaHash: descriptor.schemaHash, beforeDispatch: async () => undefined })).rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_UNSUPPORTED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enforces live reviewed scopes even when provider descriptor omits them', async () => {
    const base = baseInput(); const tool = { ...toolFixture(), scopes: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(tool));
    const descriptor = await describeConnectorTool(base);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(tool))
      .mockResolvedValueOnce(jsonResponse({ ...accountFixture(), state: { val: { scope: 'profile' } } }));
    await expect(executeConnectorTool({ ...base, input: {}, allowedTools: [base.toolSlug], requiredScopes: ['email.read'],
      toolkitVersion: descriptor.toolkitVersion, schemaHash: descriptor.schemaHash, beforeDispatch: async () => undefined }))
      .rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_MISSING', effectStarted: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { attachment: '/etc/private' }, { value: 'file:///etc/private' }, { value: 'https://internal.example.test/resource' },
    { value: '../private' }, { value: 'C:\\private' }, { callback_url: 'anything' },
    { custom_auth_params: {} }, { connected_account_id: 'other' }, { user_id: 'other' },
    { value: ['s3://bucket/file'] }, JSON.parse('{"__proto__":{}}'),
  ])('rejects file/URL/auth loading inputs before provider contact', async args => {
    const input = await prepared();
    await expect(executeConnectorTool({ ...input, input: args })).rejects.toMatchObject({ effectStarted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts ordinary bounded JSON arguments without coercion', () => {
    expect(() => validateConnectorArguments({ max_results: 5, query: 'in:inbox' })).not.toThrow();
  });

  it('passes a successful private instance envelope without interpreting the tool-specific payload', async () => {
    const input = await prepared(); const token = secret();
    const envelope = { successful: true, error: null, version: 'v1', log_id: 'log_one',
      data: [{ unknown_collection: [null, 'item'] }], logs: [{ message: 'completed', index: 1 }] };
    fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture())).mockResolvedValueOnce(jsonResponse(accountFixture()))
      .mockResolvedValueOnce(jsonResponse({ ...envelope, logs: [{ ...envelope.logs[0], access_token: token, echo: input.credential.apiKey }] }));
    const result = await executeConnectorTool({ ...input, instanceResponse: true });
    expect(result).toEqual({ ...envelope, logs: [{ ...envelope.logs[0], echo: '[redacted]' }] });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(input.credential.apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('strips returned credentials and never exposes a raw provider error on failed execution', async () => {
    const input = await prepared(); const accessToken = secret(); const refreshToken = secret();
    executionResponses({ rows: [{ subject: 'Welcome', access_token: accessToken, nested: { refresh_token: refreshToken } }],
      echoed_key: input.credential.apiKey, credential: accessToken });
    const result = await executeConnectorTool(input);
    const serialized = JSON.stringify(result);
    for (const value of [accessToken, refreshToken, input.credential.apiKey]) expect(serialized).not.toContain(value);
    expect(serialized).toContain('Welcome');
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture()))
      .mockResolvedValueOnce(jsonResponse(accountFixture()))
      .mockResolvedValueOnce(jsonResponse({ successful: false, error: accessToken, data: {} }));
    const error = await executeConnectorTool(input).catch(value => value);
    expect(error.code).toBe('CONNECTOR_OUTCOME_UNKNOWN');
    expect(error.effectStarted).not.toBe(false);
    expect(JSON.stringify(error)).not.toContain(accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a timed-out external dispatch and preserves unknown effect state', async () => {
    const input = await prepared();
    fetchMock.mockResolvedValueOnce(jsonResponse(toolFixture()))
      .mockResolvedValueOnce(jsonResponse(accountFixture()))
      .mockRejectedValueOnce(new Error(secret()));
    const error = await executeConnectorTool(input).catch(value => value);
    expect(error.code).toBe('CONNECTOR_OUTCOME_UNKNOWN');
    expect(error.effectStarted).not.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});