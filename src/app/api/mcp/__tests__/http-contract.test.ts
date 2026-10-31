import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getAllowedOrigins } from '../../../../../cors.config.js';

// These are the only application boundaries replaced. No catalog imports can
// initialize providers/DB clients, and no credential comes from the environment.
type Principal = { internal: boolean; userId: string | null; siteId: string | null };
const credentials = new Map<string, Principal>();
const resolvePrincipal = jest.fn(async (request: Request) => {
  const authorization = request.headers.get('authorization');
  const key = request.headers.get('x-api-key')
    || (authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  return credentials.get(key) ?? null;
});
const accessSite = jest.fn(async (principal: Principal, siteId: string) => principal.siteId === siteId);
const execute = jest.fn(async (context: { siteId: string; userId?: string; instanceId: string }, args: unknown) => ({ ...context, args }));
const catalog = jest.fn((siteId: string, userId: string | undefined, instanceId: string) => [{
  name: 'contract_echo', description: 'Offline context echo',
  parameters: z.object({ message: z.string() }),
  execute: (args: unknown) => execute({ siteId, userId, instanceId }, args),
}]);
jest.unstable_mockModule('@/app/api/robots/instance/assistant/utils', () => ({ getAssistantTools: catalog }));
jest.unstable_mockModule('@/lib/security/tool-request-principal', () => ({
  resolveToolRequestPrincipal: resolvePrincipal, canToolPrincipalAccessSite: accessSite,
}));
jest.unstable_mockModule('@/lib/mcp/remote-client', () => ({ shouldUseRemoteApi: () => false }));

let POST: typeof import('../route').POST;
let GET: typeof import('../route').GET;
beforeAll(async () => { ({ POST, GET } = await import('../route')); });

const siteId = randomUUID();
const userId = randomUUID();
const instanceId = randomUUID();
const credential = randomBytes(32).toString('hex');
const clients: Client[] = [];
const transports: StreamableHTTPClientTransport[] = [];
let closeServer: ReturnType<typeof jest.spyOn>;
let closeTransport: ReturnType<typeof jest.spyOn>;

function headers(overrides: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${credential}`,
    'x-mcp-site-id': siteId, 'x-mcp-instance-id': instanceId,
    accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    ...overrides,
  };
}
function rpc(method: string, params: unknown = {}, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method, params };
}
function post(body: unknown, overrides: Record<string, string> = {}) {
  return POST(new NextRequest('https://example.invalid/api/mcp', {
    method: 'POST', headers: headers(overrides), body: JSON.stringify(body),
  }));
}
const call = () => rpc('tools/call', { name: 'contract_echo', arguments: { message: 'hello' } });

// SDK fetch never reaches the global network implementation. Every request is
// converted to a real NextRequest and dispatched to the exported route handlers.
function sdk(overrides: Record<string, string> = {}) {
  const exchanges: { method: string; request: Request; response: Response }[] = [];
  const fetchAdapter: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const recordedRequest = request.clone();
    const nextRequest = new NextRequest(request);
    const response = request.method === 'POST' ? await POST(nextRequest)
      : request.method === 'GET' ? await GET(nextRequest)
      : new Response(null, { status: 405, headers: { Allow: 'POST' } });
    exchanges.push({ method: request.method, request: recordedRequest, response: response.clone() });
    return response;
  };
  const client = new Client({ name: 'offline-contract', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://example.invalid/api/mcp'), {
    fetch: fetchAdapter, requestInit: { headers: headers(overrides) },
  });
  clients.push(client);
  transports.push(transport);
  return { client, transport, exchanges };
}

beforeEach(() => {
  jest.clearAllMocks();
  credentials.clear();
  credentials.set(credential, { internal: false, siteId, userId });
  closeServer = jest.spyOn(Server.prototype, 'close');
  closeTransport = jest.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'close');
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network forbidden in offline contract suite'); });
});
afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await Promise.all(transports.splice(0).map(transport => transport.close()));
  } finally {
    jest.restoreAllMocks();
  }
});

describe('real SDK Streamable HTTP offline contract', () => {
  it('initializes, negotiates, lists and calls through the SDK fetch adapter', async () => {
    const { client, transport, exchanges } = sdk({ 'x-mcp-user-id': randomUUID() });
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: 'uncodie-tools', version: '1.0.0' });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    const init = exchanges.find(exchange => exchange.method === 'POST')!;
    expect(await init.request.json()).toMatchObject({ method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
    expect(await init.response.json()).toMatchObject({ jsonrpc: '2.0', result: { protocolVersion: LATEST_PROTOCOL_VERSION } });
    expect(transport.sessionId).toBeUndefined();
    const listed = await client.listTools();
    expect(listed.tools).toEqual([expect.objectContaining({
      name: 'contract_echo', description: 'Offline context echo',
      inputSchema: expect.objectContaining({ type: 'object', required: ['message'] }),
    })]);
    const result = await client.callTool({ name: 'contract_echo', arguments: { message: 'hello' } });
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ siteId, userId, instanceId, args: { message: 'hello' } });
    expect(execute).toHaveBeenCalledTimes(1);
    const posts = exchanges.filter(exchange => exchange.method === 'POST');
    expect(posts.map(exchange => exchange.response.status)).toEqual([200, 202, 200, 200]);
    for (const exchange of posts.slice(1)) {
      expect(exchange.request.headers.get('mcp-protocol-version')).toBe(LATEST_PROTOCOL_VERSION);
      expect(exchange.response.headers.has('mcp-session-id')).toBe(false);
    }
    expect(exchanges.some(exchange => exchange.method === 'GET' && exchange.response.status === 405)).toBe(true);
    expect(closeServer).toHaveBeenCalledTimes(posts.length);
    expect(closeTransport).toHaveBeenCalledTimes(posts.length);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([...SUPPORTED_PROTOCOL_VERSIONS, '2099-01-01'])('negotiates initialize version %s', async requested => {
    const response = await post(rpc('initialize', {
      protocolVersion: requested, capabilities: {}, clientInfo: { name: 'offline', version: '1' },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} }, serverInfo: { name: 'uncodie-tools', version: '1.0.0' },
    } });
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it('returns a JSON-RPC method-not-found error without executing tools', async () => {
    const response = await post(rpc('not/a/method', {}, 'unknown-method'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 'unknown-method', error: { code: -32601 } });
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { jsonrpc: '1.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: {}, method: 'tools/list' }])(
    'rejects invalid JSON-RPC message %j', async body => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
      expect(execute).not.toHaveBeenCalled();
      expect(closeServer).toHaveBeenCalledTimes(1);
      expect(closeTransport).toHaveBeenCalledTimes(1);
    });

  it('preserves the route malformed JSON error before constructing the server', async () => {
    const response = await POST(new NextRequest('https://example.invalid/api/mcp', {
      method: 'POST', headers: headers(), body: '{',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body.' });
    expect(catalog).not.toHaveBeenCalled();
    expect(closeServer).not.toHaveBeenCalled();
  });

  it.each(['', 'application/json', 'text/event-stream', '*/*'])('requires both response media types (Accept: %s)', async accept => {
    const response = await post(call(), { accept });
    expect(response.status).toBe(406);
    expect(await response.json()).toMatchObject({ error: { code: -32000 } });
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'text/plain', 'application/jsonp'])('rejects unsupported Content-Type %s', async contentType => {
    const response = await post(call(), { 'content-type': contentType });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: -32000 } });
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it('accepts JSON content-type parameters and a supported protocol header', async () => {
    const response = await post(call(), { 'content-type': 'application/json; charset=utf-8', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ result: { isError: false } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported protocol headers before tool execution', async () => {
    const response = await post(call(), { 'mcp-protocol-version': '2099-01-01' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32000, message: expect.stringContaining('Unsupported protocol version') } });
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it.each(['notifications/initialized', 'notifications/cancelled'])('accepts %s with empty 202', async method => {
    const response = await post({ jsonrpc: '2.0', method, params: method.endsWith('cancelled') ? { requestId: 42 } : {} });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeTransport).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'invalid', 'scheme'])('denies %s credentials before context or catalog work', async mode => {
    const response = await post(call(), {
      authorization: mode === 'missing' ? '' : `${mode === 'scheme' ? 'Basic' : 'Bearer'} ${randomBytes(32).toString('hex')}`,
      'x-mcp-site-id': 'invalid',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.text()).not.toContain('MCP_SITE_ID');
    expect(accessSite).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('admits explicitly resolved X-API-Key principals', async () => {
    const response = await post(call(), { authorization: '', 'x-api-key': credential });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('allows an internal principal to forward an explicit actor without sharing context', async () => {
    credentials.set(credential, { internal: true, siteId, userId: null });
    const actor = randomUUID();
    const response = await post(call(), { 'x-mcp-user-id': actor });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: false } });
    expect(execute).toHaveBeenCalledWith({ siteId, userId: actor, instanceId }, { message: 'hello' });
  });

  it('supports the explicit default instance sentinel without environment configuration', async () => {
    const response = await post(call(), { 'x-mcp-instance-id': 'default' });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ siteId, userId, instanceId: 'default' }, { message: 'hello' });
  });

  it.each(['x-mcp-site-id', 'x-mcp-instance-id'])('denies malformed %s before authorization/catalog execution', async header => {
    const response = await post(call(), { [header]: 'invalid' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining(header) });
    expect(accessSite).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies cross-site access before constructing tools', async () => {
    const otherSite = randomUUID();
    const response = await post(call(), { 'x-mcp-site-id': otherSite });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Site access denied' });
    expect(accessSite).toHaveBeenCalledWith({ internal: false, siteId, userId }, otherSite);
    expect(catalog).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).not.toHaveBeenCalled();
  });

  it('GET advertises no standalone SSE stream and constructs no server', async () => {
    const response = await GET(new NextRequest('https://example.invalid/api/mcp'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(catalog).not.toHaveBeenCalled();
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it.each(getAllowedOrigins())('admits the actual CORS allowlist Origin %s', async origin => {
    const response = await post(call(), { origin });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, ...getAllowedOrigins()])('returns GET 405 for absent or allowlisted Origin %s', async origin => {
    const response = await GET(new NextRequest('https://example.invalid/api/mcp', {
      headers: origin === undefined ? {} : { origin },
    }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['https://example.invalid', 'null', `${getAllowedOrigins()[0]}.example.invalid`])('rejects GET Origin %s before creating a connection', async origin => {
    const response = await GET(new NextRequest('https://example.invalid/api/mcp', { headers: { origin } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Origin not allowed' });
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(closeServer).not.toHaveBeenCalled();
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it.each(['https://example.invalid', 'null', `${getAllowedOrigins()[0]}.example.invalid`])('denies unlisted Origin %s before auth or execution', async origin => {
    const response = await post(call(), { origin });
    expect(response.status).toBe(403);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps concurrent SDK requests in independent site/user/instance contexts', async () => {
    const second = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID() };
    const secondCredential = randomBytes(32).toString('hex');
    credentials.set(secondCredential, { internal: false, siteId: second.siteId, userId: second.userId });
    const a = sdk();
    const b = sdk({ authorization: `Bearer ${secondCredential}`, 'x-mcp-site-id': second.siteId, 'x-mcp-instance-id': second.instanceId });
    await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
    let release!: () => void;
    const bothEntered = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    execute.mockImplementationOnce(async (context, args) => {
      if (++entered === 2) release();
      await bothEntered;
      return { ...context, args };
    }).mockImplementationOnce(async (context, args) => {
      if (++entered === 2) release();
      await bothEntered;
      return { ...context, args };
    });
    const results = await Promise.all([a.client.callTool({ name: 'contract_echo', arguments: { message: 'first' } }),
      b.client.callTool({ name: 'contract_echo', arguments: { message: 'second' } })]);
    expect(results.map(result => JSON.parse((result.content as { text: string }[])[0].text))).toEqual([
      { siteId, userId, instanceId, args: { message: 'first' } },
      { ...second, args: { message: 'second' } },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(closeServer).toHaveBeenCalledTimes(6);
    expect(closeTransport).toHaveBeenCalledTimes(6);
  });

  it('closes the server and its real transport when handleRequest throws', async () => {
    const failure = new Error('synthetic transport failure');
    jest.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(failure);
    await expect(post(call())).rejects.toBe(failure);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('closes the server even if connect throws', async () => {
    const failure = new Error('synthetic connect failure');
    jest.spyOn(Server.prototype, 'connect').mockRejectedValueOnce(failure);
    await expect(post(call())).rejects.toBe(failure);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});