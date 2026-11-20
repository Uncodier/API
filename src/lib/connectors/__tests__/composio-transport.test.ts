import { COMPOSIO_MAX_RESPONSE_BYTES, COMPOSIO_TIMEOUT_MS, createComposioClient } from '../composio-transport';
import { jsonResponse, secret } from './composio-fixtures';

describe('Composio request-local transport', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock; });
  afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

  it('isolates concurrent site credentials and constructs headers anew per request', async () => {
    const keyA = secret(); const keyB = secret();
    fetchMock.mockImplementation(async () => jsonResponse({ items: [] }));
    const a = createComposioClient(keyA); const b = createComposioClient(keyB);
    await Promise.all([a.request('/toolkits'), b.request('/toolkits'), a.request('/auth_configs')]);
    const calls = fetchMock.mock.calls;
    expect(calls.map(call => call[1].headers['x-api-key'])).toEqual([keyA, keyB, keyA]);
    expect(calls[0][1].headers).not.toBe(calls[2][1].headers);
    expect(calls[0][0]).toBe('https://backend.composio.dev/api/v3.1/toolkits');
    expect(calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'error', credentials: 'omit' });
    expect(JSON.stringify(a)).not.toContain(keyA);
  });

  it.each([
    'https://attacker.test/toolkits', '//attacker.test/toolkits', '/toolkits/../org', '/toolkits/%2e%2e',
    '/toolkits\\evil', '/toolkits#fragment', '/toolkits?limit=101', '/toolkits?limit=0',
    '/toolkits?limit=1&limit=2', '/toolkits?url=https://attacker.test', '/toolkits?search=%00',
    '/tools/COMPOSIO_REMOTE_BASH_TOOL', '/tool_router/session/s/files', '/tools/execute/GMAIL_FETCH_EMAILS',
  ])('rejects unapproved read target %s without fetch', async path => {
    await expect(createComposioClient(secret()).request(path)).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects header injection, missing credentials, and serialization hooks', async () => {
    expect(() => createComposioClient(`${secret()}\r\nx-test: invalid`)).toThrow();
    expect(() => createComposioClient('')).toThrow();
    const getter = jest.fn();
    const body = Object.defineProperty({}, 'secret', { enumerable: true, get: getter });
    await expect(createComposioClient(secret()).request('/connected_accounts/link', { method: 'POST', body }))
      .rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    expect(getter).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized, cyclic, dangerous-key and non-JSON request bodies before dispatch', async () => {
    const client = createComposioClient(secret());
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const body of [cyclic, { x: 'x'.repeat(70_000) }, JSON.parse('{"__proto__":{}}'), { file: new Blob(['file']) }]) {
      await expect(client.request('/connected_accounts/link', { method: 'POST', body })).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])('never exposes HTTP %i response details or retries', async status => {
    const key = secret(); const privateValue = secret();
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: `${key} ${privateValue}` } }, status));
    const result = await createComposioClient(key).request('/toolkits').catch(error => error);
    if (!(result instanceof Error)) throw new Error('Expected a sanitized provider error');
    expect(`${result.message} ${JSON.stringify(result)}`).not.toContain(key);
    expect(`${result.message} ${JSON.stringify(result)}`).not.toContain(privateValue);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 408])('records write HTTP %i as outcome unknown without replay', async status => {
    fetchMock.mockResolvedValue(jsonResponse({ error: secret() }, status));
    await expect(createComposioClient(secret()).request('/connected_accounts/link', { method: 'POST', body: {} }))
      .rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps socket/redirect errors safely and never follows another origin', async () => {
    const key = secret();
    fetchMock.mockRejectedValue(new Error(`socket ${key} https://private.test`));
    await expect(createComposioClient(key).request('/connected_accounts/ca_one/revoke', { method: 'POST' }))
      .rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN', message: expect.not.stringContaining(key) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
  });

  it.each(['GET', 'POST'] as const)('bounds hanging %s fetch including implementations ignoring abort', async method => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const promise = createComposioClient(secret()).request(method === 'GET' ? '/toolkits' : '/connected_accounts/link', { method });
    const assertion = expect(promise).rejects.toMatchObject({ code: method === 'GET' ? 'PROVIDER_TIMEOUT' : 'CONNECTOR_OUTCOME_UNKNOWN' });
    await jest.advanceTimersByTimeAsync(COMPOSIO_TIMEOUT_MS);
    await assertion;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled response body, not merely receipt of headers', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start() { /* Intentionally stalled. */ } }), {
      headers: { 'content-type': 'application/json' },
    }));
    const assertion = expect(createComposioClient(secret()).request('/toolkits')).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(COMPOSIO_TIMEOUT_MS);
    await assertion;
  });

  it('enforces streaming byte limits without trusting Content-Length', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(COMPOSIO_MAX_RESPONSE_BYTES + 1), {
      headers: { 'content-type': 'application/json' },
    }));
    await expect(createComposioClient(secret()).request('/toolkits')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it.each([
    () => new Response('{not-json', { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(COMPOSIO_MAX_RESPONSE_BYTES + 1) } }),
  ])('does not claim a malformed successful write failed before effect', async response => {
    fetchMock.mockResolvedValue(response());
    await expect(createComposioClient(secret()).request('/connected_accounts/link', { method: 'POST' }))
      .rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});