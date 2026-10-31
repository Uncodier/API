import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mcpContextSchema } from '../context';

const cwd = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = join(cwd, 'stdio-server.cjs');
const require = createRequire(import.meta.url);
const { evaluate } = require(fixture) as {
  evaluate: (path: string, dependencies: Record<string, unknown>, globals?: Record<string, unknown>) => unknown;
};
const siteId = randomUUID();
const resources: Client[] = [];

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function setup(context: Record<string, unknown> = { siteId }) {
  // SDK transport merges defaults even when env is supplied. Blank every default
  // explicitly, inheriting only PATH (no HOME, USER, NODE_OPTIONS or credentials).
  const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, '']));
  if (process.env.PATH) env.PATH = process.env.PATH;
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fixture, JSON.stringify(context)], cwd, env, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'offline-stdio-contract', version: '1.0.0' });
  resources.push(client);
  let stdout = '';
  // Inspect the SDK-owned child only for raw wire and natural EOF assertions;
  // all protocol traffic remains on the real SDK client/transport.
  const connect = client.connect(transport).then(() => undefined);
  // start() spawns synchronously before connect's first await.
  const child = (transport as unknown as { _process: ChildProcess })._process;
  child.stdout!.on('data', chunk => { stdout += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  async function observe() {
    await bounded(connect, 'SDK initialization');
    return { client, transport, child, exit, stdout: () => stdout, stderr: () => stderr };
  }
  return { observe, connect, exit, stdout: () => stdout, stderr: () => stderr };
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map(client => bounded(client.close(), 'cleanup')));
});

describe('real offline MCP stdio subprocess', () => {
  it('initializes the SDK, advertises schemas, calls tools, and emits JSON-RPC only on stdout', async () => {
    const session = await setup().observe();
    expect(session.client.getServerVersion()).toEqual({ name: 'uncodie-tools', version: '1.0.0' });
    expect(session.client.getServerCapabilities()).toMatchObject({ tools: {} });
    const catalog = await bounded(session.client.listTools(), 'list');
    expect(catalog.tools.map(tool => tool.name)).toEqual([
      'fixture_context', 'fixture_echo', 'fixture_plain', 'fixture_throw', 'fixture_string',
    ]);
    expect(catalog.tools.find(tool => tool.name === 'fixture_echo')!.inputSchema).toMatchObject({
      type: 'object', properties: { message: { type: 'string' }, count: { type: 'integer', default: 1 } }, required: ['message'],
    });
    const result = await bounded(session.client.callTool({ name: 'fixture_echo', arguments: { message: 'offline' } }), 'call');
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: JSON.stringify({ message: 'offline', count: 1, executions: 1 }) }] });
    expect(await session.client.callTool({ name: 'fixture_string' })).toMatchObject({
      isError: false, content: [{ type: 'text', text: 'plain string result' }],
    });
    await bounded(session.client.close(), 'clean SDK close');
    expect(await bounded(session.exit, 'child exit')).toEqual({ code: 0, signal: null });
    const lines = session.stdout().trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      const message = JSON.parse(line);
      expect(message.jsonrpc).toBe('2.0');
      expect(message).toHaveProperty('id');
      expect('result' in message || 'error' in message).toBe(true);
    }
    expect(session.stdout()).not.toContain('fixture:');
    expect(session.stderr()).toContain('fixture:catalog-created');
    expect(session.stderr()).toContain('fixture:eof-closed');
  });

  it('rejects unknown tools, invalid Zod/JSON-schema arguments and execution failures without crashing', async () => {
    const { client } = await setup().observe();
    await expect(bounded(client.request({ method: 'fixture/unknown' }, ListToolsResultSchema), 'unsupported method'))
      .rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    for (const params of [
      { name: 'fixture_ech', arguments: {} },
      { name: 'fixture_echo', arguments: {} },
      { name: 'fixture_echo', arguments: { message: 42 } },
      { name: 'fixture_echo', arguments: { message: 'ok', count: 0 } },
      { name: 'fixture_echo', arguments: { message: 'ok', extra: true } },
      { name: 'fixture_plain', arguments: {} },
      { name: 'fixture_plain', arguments: { value: '1' } },
      { name: 'fixture_plain', arguments: { value: 0 } },
      { name: 'fixture_plain', arguments: { value: 1, extra: true } },
      { name: 'fixture_throw', arguments: {} },
    ]) {
      const result = await bounded(client.callTool(params), params.name);
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.any(String) }] });
    }
    // No invalid call reached execute; the same process remains usable.
    expect(await client.callTool({ name: 'fixture_plain', arguments: { value: 2 } })).toMatchObject({
      isError: false, content: [{ text: JSON.stringify({ value: 2, executions: 1 }) }],
    });
    expect((await client.listTools()).tools).toHaveLength(5);
  });

  it.each([
    { siteId },
    { siteId, instanceId: 'default' },
    { siteId: ` ${siteId} `, instanceId: ` ${randomUUID()} `, userId: 'offline-user' },
    { siteId, instanceId: randomUUID(), customTools: [{ name: 'fixture-custom' }] },
  ])('matches shared context normalization and preserves factory scope: %j', async context => {
    const { client } = await setup(context).observe();
    const result = await client.callTool({ name: 'fixture_context' });
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
      ...mcpContextSchema.parse(context), userId: 'userId' in context ? context.userId : null,
      customTools: 'customTools' in context ? context.customTools : [],
    });
  });

  it('naturally exits on stdin EOF without SIGTERM/SIGKILL and within a bounded timeout', async () => {
    const session = await setup().observe();
    await session.client.listTools();
    session.child.stdin!.end();
    expect(await bounded(session.exit, 'EOF natural exit')).toEqual({ code: 0, signal: null });
    expect(session.stderr()).toContain('fixture:eof-closed');
  });

  it.each([
    {}, { siteId: 'default' }, { siteId: '' }, { siteId: null },
    { siteId, instanceId: '' }, { siteId, instanceId: null }, { siteId, instanceId: 'not-an-instance' },
  ])('fails before catalog/provider evaluation for invalid context: %j', async context => {
    const session = setup(context);
    await expect(bounded(session.connect, 'invalid initialization')).rejects.toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(await bounded(session.exit, 'invalid context exit')).toEqual({ code: 1, signal: null });
    expect(session.stdout()).toBe('');
    expect(session.stderr()).toContain('fixture:startup-failed Invalid MCP context');
    expect(session.stderr()).not.toContain('fixture:catalog-created');
    expect(session.stderr()).not.toContain('Unexpected fixture import');
  });
});

describe('isolated real stdio entrypoint bootstrap (only dependencies mocked)', () => {
  function bootstrap(env: Record<string, string>, failure?: Error) {
    const stdin = new EventEmitter();
    const exit = jest.fn();
    const error = jest.fn();
    const transport = { onclose: undefined as undefined | (() => void) };
    const capturedEnvironments: Record<string, string>[] = [];
    const connect = jest.fn(async (_transport: unknown) => { if (failure) throw failure; });
    const createMcpServer = jest.fn((_site: string, _user: string | undefined, _instance: string) => ({ connect }));
    const dependencies = {
      '@modelcontextprotocol/sdk/server/stdio.js': { StdioServerTransport: class { constructor() { return transport; } } },
      '@/lib/mcp/context': { DEFAULT_MCP_INSTANCE_ID: 'default' },
      '@/lib/mcp/server': { get createMcpServer() { capturedEnvironments.push({ ...env }); return createMcpServer; } },
    };
    evaluate('mcp-server/index.ts', dependencies, {
      process: { env, stdin, exit }, console: { error },
    });
    return { stdin, exit, error, transport, connect, createMcpServer, capturedEnvironments };
  }

  it('requires site context before importing the catalog and writes diagnostics only to stderr', () => {
    // Real process.exit terminates evaluation; model that rather than allowing
    // the VM to fall through into main() after a missing required site.
    const exit = jest.fn((_code: number) => { throw new Error('isolated exit'); });
    const error = jest.fn();
    expect(() => evaluate('mcp-server/index.ts', {
      '@modelcontextprotocol/sdk/server/stdio.js': { StdioServerTransport: class {} },
      '@/lib/mcp/context': { DEFAULT_MCP_INSTANCE_ID: 'default' },
    }, { process: { env: {}, exit }, console: { error } })).toThrow('isolated exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('MCP_SITE_ID is required'));
  });

  it.each([undefined, 'http://offline.test:4321'])('sets API URLs before dynamic server evaluation: %s', async apiUrl => {
    const env: Record<string, string> = { MCP_SITE_ID: siteId };
    if (apiUrl) env.API_URL = apiUrl;
    const state = bootstrap(env);
    await new Promise(resolve => setImmediate(resolve));
    expect(state.createMcpServer).toHaveBeenCalledWith(siteId, undefined, 'default');
    expect(state.connect).toHaveBeenCalledWith(state.transport);
    expect(state.capturedEnvironments[0]).toMatchObject(Object.fromEntries([
      'API_URL', 'NEXT_PUBLIC_API_SERVER_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_APP_URL',
    ].map(key => [key, apiUrl ?? 'http://localhost:3000'])));
    state.transport.onclose!();
    state.stdin.emit('close');
    expect(state.exit.mock.calls).toEqual([[0], [0]]);
  });

  it('forwards explicit user/instance and reports connection failure with exit 1', async () => {
    const instanceId = randomUUID();
    const failure = new Error('offline connect failure');
    const state = bootstrap({ MCP_SITE_ID: siteId, MCP_USER_ID: 'offline-user', MCP_INSTANCE_ID: instanceId }, failure);
    await new Promise(resolve => setImmediate(resolve));
    expect(state.createMcpServer).toHaveBeenCalledWith(siteId, 'offline-user', instanceId);
    expect(state.error).toHaveBeenCalledWith('MCP server failed to connect:', failure);
    expect(state.exit).toHaveBeenCalledWith(1);
  });
});