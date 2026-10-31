import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

const execute = jest.fn<(args: unknown) => unknown>();
let definitions: any[];
let remote = false;
const catalog = jest.fn((..._args: unknown[]) => definitions);
jest.unstable_mockModule('@/app/api/robots/instance/assistant/utils', () => ({ getAssistantTools: catalog }));
jest.unstable_mockModule('@/lib/mcp/remote-client', () => ({ shouldUseRemoteApi: () => remote }));
let createMcpServer: typeof import('../server').createMcpServer;
const clients: Client[] = [];
const servers: ReturnType<typeof createMcpServer>[] = [];
const envNames = ['API_URL', 'REST_API_KEY', 'SERVICE_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const saved = new Map(envNames.map(key => [key, process.env[key]]));
const siteId = randomUUID(); const userId = randomUUID(); const instanceId = randomUUID();

async function connect() {
  const server = createMcpServer(siteId, userId, instanceId);
  const client = new Client({ name: 'offline-contract', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  clients.push(client); servers.push(server);
  await server.connect(b); await client.connect(a);
  return client;
}
beforeAll(async () => { ({ createMcpServer } = await import('../server')); });
beforeEach(() => {
  remote = false; jest.clearAllMocks();
  for (const key of envNames) delete process.env[key];
  execute.mockReset().mockImplementation(args => args);
  definitions = [{ name: 'echo', description: 'Echo validated arguments', parameters: z.object({
    action: z.enum(['read', 'write']), count: z.number().int().min(1).max(3),
    nested: z.object({ enabled: z.boolean() }).strict(),
    label: z.string().trim().default('default'),
  }).strict(), execute }];
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected offline network access'));
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
  jest.restoreAllMocks();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('shared server through the real MCP SDK', () => {
  it('negotiates capabilities and discovers JSON schemas without executing tools', async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe('uncodie-tools');
    expect(client.getServerCapabilities()?.tools).toEqual({});
    const result = await client.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(execute).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(catalog).toHaveBeenCalledWith(siteId, userId, instanceId, []);
  });

  it('executes parsed Zod arguments including defaults and transforms once', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'echo', arguments: { action: 'read', count: 2, nested: { enabled: true }, label: ' trimmed ' } });
    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith({ action: 'read', count: 2, nested: { enabled: true }, label: 'trimmed' });
    await client.callTool({ name: 'echo', arguments: { action: 'read', count: 1, nested: { enabled: false } } });
    expect(execute).toHaveBeenLastCalledWith({ action: 'read', count: 1, nested: { enabled: false }, label: 'default' });
  });

  it.each([
    {}, { action: 'invalid', count: 1, nested: { enabled: true } },
    { action: 'read', count: '1', nested: { enabled: true } },
    { action: 'read', count: 0, nested: { enabled: true } },
    { action: 'read', count: 4, nested: { enabled: true } },
    { action: 'read', count: 1.5, nested: { enabled: true } },
    { action: 'read', count: 1, nested: { enabled: 'true' } },
    { action: 'read', count: 1, nested: { enabled: true, extra: true } },
    { action: 'read', count: 1, nested: { enabled: true }, site_id: randomUUID() },
  ])('rejects invalid Zod arguments before side effects: %j', async arguments_ => {
    const result = await (await connect()).callTool({ name: 'echo', arguments: arguments_ });
    expect(result.isError).toBe(true); expect(execute).not.toHaveBeenCalled();
  });

  it('supports strict discriminated action schemas', async () => {
    definitions[0].parameters = z.discriminatedUnion('action', [
      z.object({ action: z.literal('read'), id: z.string().uuid() }).strict(),
      z.object({ action: z.literal('write'), value: z.number() }).strict(),
    ]);
    const client = await connect();
    expect((await client.callTool({ name: 'echo', arguments: { action: 'read', id: randomUUID() } })).isError).toBe(false);
    execute.mockClear();
    expect((await client.callTool({ name: 'echo', arguments: { action: 'read', value: 3 } })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { quantity: '2', item: { id: 'ok' } }, { quantity: 0, item: { id: 'ok' } },
    { quantity: 2, item: { id: 7 } }, { quantity: 2, item: { id: 'ok' }, extra: 1 },
  ])('validates plain JSON Schema recursively: %j', async arguments_ => {
    definitions[0].parameters = { type: 'object', required: ['quantity', 'item'], additionalProperties: false,
      properties: { quantity: { type: 'integer', minimum: 1 }, item: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } };
    expect((await (await connect()).callTool({ name: 'echo', arguments: arguments_ })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('supports no-parameter tools and string/object results', async () => {
    definitions[0].parameters = undefined;
    execute.mockReturnValueOnce('done').mockReturnValueOnce({ saved: true });
    const client = await connect();
    expect((await client.callTool({ name: 'echo' })).content).toEqual([{ type: 'text', text: 'done' }]);
    expect((await client.callTool({ name: 'echo' })).content).toEqual([{ type: 'text', text: '{"saved":true}' }]);
  });

  it('serializes void results into a valid MCP text block', async () => {
    definitions[0].parameters = undefined; execute.mockReturnValue(undefined);
    expect((await (await connect()).callTool({ name: 'echo' })).content).toEqual([{ type: 'text', text: 'null' }]);
  });

  it('does not accept inherited property names as declared parameters', async () => {
    definitions[0].parameters = { type: 'object', properties: {} };
    const client = await connect();
    // SDK record validation itself rejects a constructor override on the wire.
    await expect(client.callTool({ name: 'echo', arguments: { constructor: 'override' } })).rejects.toMatchObject({ code: -32603 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps concurrent request ids and results independent', async () => {
    definitions[0].parameters = z.object({ value: z.number() });
    execute.mockImplementation(async (args: any) => { await Promise.resolve(); return { value: args.value }; });
    const client = await connect();
    const results = await Promise.all([1, 2, 3].map(value => client.callTool({ name: 'echo', arguments: { value } })));
    expect(results.map(result => (result.content as any[])[0].text)).toEqual(['{"value":1}', '{"value":2}', '{"value":3}']);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('suggests unknown tool names without executing anything', async () => {
    const result = await (await connect()).callTool({ name: 'ech' });
    expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain('echo');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unsupported protocol methods', async () => {
    const client = await connect();
    await expect(client.request({ method: 'unknown/method' }, z.object({}))).rejects.toMatchObject({ code: -32601 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('redacts execution errors and stays usable without retrying writes', async () => {
    const token = randomBytes(32).toString('hex'); const username = randomBytes(12).toString('hex');
    const password = randomBytes(12).toString('hex');
    process.env.REST_API_KEY = token;
    const url = new URL('https://example.invalid'); url.username = username; url.password = password;
    execute.mockImplementationOnce(() => { throw new Error(`Bearer ${token} ${url.href}`); });
    const client = await connect();
    const args = { action: 'write', count: 1, nested: { enabled: true } };
    const result = await client.callTool({ name: 'echo', arguments: args });
    expect(result.isError).toBe(true);
    for (const secret of [token, username, password]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: 'echo', arguments: args })).isError).toBe(false);
  });
});

describe('remote MCP proxy contract', () => {
  beforeEach(() => { remote = true; process.env.API_URL = 'https://api.example.invalid/'; process.env.REST_API_KEY = randomBytes(32).toString('hex'); });

  it('returns remote discovery and successful content without rewriting it', async () => {
    const tools = [{ name: 'remote_read', description: 'Remote authorized catalog', inputSchema: { type: 'object' as const } }];
    const content = [{ type: 'text' as const, text: '{"ok":true}' }];
    jest.mocked(fetch).mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 1, result: { tools } }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 2, result: { content, isError: false } }));
    const client = await connect();
    expect(await client.listTools()).toEqual({ tools });
    expect(await client.callTool({ name: 'remote_read', arguments: { limit: 1 } })).toEqual({ content, isError: false });
    expect(JSON.parse(String(jest.mocked(fetch).mock.calls[1][1]?.body))).toMatchObject({
      method: 'tools/call', params: { name: 'remote_read', arguments: { limit: 1 } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards host context/auth and preserves remote tool errors without local execution', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'denied' }], isError: true } }));
    const client = await connect();
    expect(await client.listTools()).toEqual({ tools: [] });
    expect((await client.callTool({ name: 'remote_only' })).isError).toBe(true);
    const [url, init] = jest.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.example.invalid/api/mcp');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      'x-mcp-site-id': siteId, 'x-mcp-user-id': userId, 'x-mcp-instance-id': instanceId,
      Authorization: `Bearer ${process.env.REST_API_KEY}`,
    } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['http', 'invalid-json', 'rpc-error', 'wrong-id', 'invalid-result', 'network'])
    ('fails closed for %s without leaking diagnostics or falling back to local tools', async kind => {
      const sensitive = randomBytes(24).toString('hex');
      const response = kind === 'http' ? new Response(sensitive, { status: 403 }) : kind === 'invalid-json' ? new Response(sensitive)
        : Response.json({ jsonrpc: '2.0', id: kind === 'wrong-id' ? 99 : 1,
          ...(kind === 'rpc-error' ? { error: { code: -32603, message: sensitive } } : { result: { tools: sensitive } }) });
      if (kind === 'network') jest.mocked(fetch).mockRejectedValue(new Error(sensitive));
      else jest.mocked(fetch).mockImplementation(async () => response.clone());
      const client = await connect();
      await expect(client.listTools()).rejects.toThrow('Remote MCP catalog unavailable');
      const result = await client.callTool({ name: 'echo', arguments: {} });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(sensitive);
      expect(fetch).toHaveBeenCalledTimes(2); expect(execute).not.toHaveBeenCalled();
    });
});