import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { NextRequest } from 'next/server';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

const siteId = randomUUID();
const instanceId = randomUUID();
const from = jest.fn();
const validateApiKey = jest.fn(async (_key: string) => ({ isValid: false }));
const reader = loadRuntimeModule<typeof import('@/lib/services/robot-instance/instance-history-reader')>(
  'src/lib/services/robot-instance/instance-history-reader.ts', {
    zod: { z }, '@/lib/database/supabase-client': { supabaseAdmin: { from } },
  });

// Run the actual catalog, history tool and router. Screen policy is isolated in
// router/screen-access.test.ts; these tests exercise context/transport only.
// Unrelated tool factories are inert; no .env, providers or live database.
function catalog() {
  const utilsPath = 'src/app/api/robots/instance/assistant/utils.ts';
  const dependencies: Record<string, unknown> = {};
  const source = ts.createSourceFile(utilsPath, readFileSync(path.resolve(utilsPath), 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    const bindings = statement.importClause?.namedBindings;
    const exports: Record<string, unknown> = {};
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        exports[name] = () => ({ name, description: name, parameters: { type: 'object', properties: {} },
          execute: () => { throw new Error('Unrelated tool must not execute'); } });
      }
    }
    dependencies[specifier] = exports;
  }
  dependencies['@/lib/services/robot-instance/instance-history-reader'] = reader;
  dependencies['@/app/api/agents/tools/instance_history/assistantProtocol'] = loadRuntimeModule(
    'src/app/api/agents/tools/instance_history/assistantProtocol.ts', {
      'zod-to-json-schema': { zodToJsonSchema },
      '@/lib/services/robot-instance/instance-history-reader': reader,
    });
  dependencies['@/lib/services/tool-execution-context'] = { readToolExecutionContext: () => undefined };
  // This factory returns a catalog fragment rather than one tool definition.
  dependencies['@/lib/procurement/tools'] = { createProcurementTools: () => [] };
  dependencies['@/lib/services/harness-diagnostics/tools'] = { refreshHarnessToolManifest: (tools: unknown) => tools };
  dependencies['@/app/api/agents/tools/router/assistantProtocol'] = loadRuntimeModule(
    'src/app/api/agents/tools/router/assistantProtocol.ts', {
      '@/lib/services/embeddings-service': {},
      './screen-access': {
        loadToolScreenAccess: async () => ({ isAdmin: true, blockedScreens: [] }),
        canUseToolScreen: () => true, assertToolScopeArgs: () => {}, guardToolScreen: (tool: unknown) => tool,
      },
    });
  return loadRuntimeModule<typeof import('@/app/api/robots/instance/assistant/utils')>(utilsPath, dependencies);
}
const utils = catalog();
jest.unstable_mockModule('@/app/api/robots/instance/assistant/utils', () => utils);
jest.unstable_mockModule('@/lib/services/api-keys/ApiKeyService', () => ({ ApiKeyService: { validateApiKey } }));
jest.unstable_mockModule('@/lib/security/tool-request-principal', () => ({
  resolveToolRequestPrincipal: async (request: Request) => {
    const credential = request.headers.get('x-api-key') || (request.headers.get('authorization')?.startsWith('Bearer ')
      ? request.headers.get('authorization')!.slice(7) : null);
    if (!credential) return null;
    if (credential === process.env.SERVICE_API_KEY) return { internal: true, userId: null, siteId: null };
    const result = await validateApiKey(credential);
    return result.isValid ? { internal: false, userId: randomUUID(), siteId } : null;
  },
  canToolPrincipalAccessSite: async () => true,
}));

let POST: typeof import('../route').POST;
let createMcpServer: typeof import('@/lib/mcp/server').createMcpServer;
beforeAll(async () => {
  ({ POST } = await import('../route'));
  ({ createMcpServer } = await import('@/lib/mcp/server'));
});

const envNames = ['MCP_SITE_ID', 'MCP_USER_ID', 'MCP_INSTANCE_ID', 'SERVICE_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'API_URL'];
const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));
function request(body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, headers: Record<string, string> = {}) {
  return new NextRequest('https://api.example.test/api/mcp', {
    method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${process.env.SERVICE_API_KEY}`, ...headers,
    }, body: JSON.stringify(body),
  });
}

describe('MCP context through the real HTTP transport and server', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of envNames) delete process.env[name];
    process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
    process.env.MCP_SITE_ID = siteId;
    from.mockImplementation(() => { throw new Error('Unexpected database access'); });
    validateApiKey.mockResolvedValue({ isValid: false });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected network access'); });
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each([undefined, 'default'])('initializes and lists tools without a real instance: %s', async instance => {
    if (instance !== undefined) process.env.MCP_INSTANCE_ID = instance;
    const initialized = await POST(request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'offline-test', version: '1.0' },
    } }));
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ result: { serverInfo: { name: 'uncodie-tools' } } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'tools' })]) } });
    const listing = await POST(request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'tools', arguments: { action: 'list', thought_process: '' },
    } }));
    const result = JSON.parse((await listing.json()).result.content[0].text);
    expect(result.tools.length).toBeGreaterThan(1);
    expect(result.tools.map((tool: { name: string }) => tool.name)).not.toContain('instance_history');
    const unavailable = await POST(request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'tools', arguments: { action: 'call', name: 'instance_history', args: { action: 'list' }, thought_process: '' },
    } }));
    expect(JSON.parse((await unavailable.json()).result.content[0].text)).toMatchObject({ success: false });
    expect(from).not.toHaveBeenCalled();
  });

  it('enables history for a UUID and preserves both database scope filters', async () => {
    const query: Record<string, any> = {};
    for (const method of ['select', 'eq', 'order', 'limit']) query[method] = jest.fn(() => query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    from.mockReturnValue(query);
    const response = await POST(request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'tools', arguments: { action: 'call', name: 'instance_history', args: { action: 'list' }, thought_process: '' },
    } }, { 'x-mcp-instance-id': instanceId }));
    expect(response.status).toBe(200);
    expect(JSON.parse((await response.json()).result.content[0].text)).toMatchObject({
      success: true, name: 'instance_history', result: { action: 'list', logs: [] },
    });
    expect(from).toHaveBeenCalledWith('instance_logs');
    expect(query.eq).toHaveBeenCalledWith('site_id', siteId);
    expect(query.eq).toHaveBeenCalledWith('instance_id', instanceId);
  });

  it.each(['x-mcp-site-id', 'x-mcp-instance-id'])('rejects malformed %s with 400 before building tools', async header => {
    for (const value of ['not-a-uuid', '']) {
      const response = await POST(request(undefined, { [header]: value }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(header);
    }
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['MCP_SITE_ID', 'MCP_INSTANCE_ID'])('rejects malformed server %s with 503', async name => {
    process.env[name] = 'not-a-uuid';
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain(name);
    expect(from).not.toHaveBeenCalled();
  });

  it('reports missing site configuration without throwing', async () => {
    delete process.env.MCP_SITE_ID;
    expect((await POST(request())).status).toBe(503);
    expect(from).not.toHaveBeenCalled();
  });

  it('normalizes UUID whitespace and uses explicit headers over invalid environment defaults', async () => {
    process.env.MCP_SITE_ID = 'invalid';
    process.env.MCP_INSTANCE_ID = 'invalid';
    const response = await POST(request(undefined, { 'x-mcp-site-id': ` ${siteId} `, 'x-mcp-instance-id': instanceId }));
    expect(response.status).toBe(200);
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects credentials before disclosing invalid context', async () => {
    process.env.MCP_SITE_ID = 'invalid';
    const response = await POST(request(undefined, { authorization: `Bearer ${randomBytes(32).toString('hex')}` }));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('MCP_SITE_ID');
    expect(from).not.toHaveBeenCalled();
  });

  it('still admits a validated DB API key and rejects an unsupported auth scheme', async () => {
    validateApiKey.mockResolvedValueOnce({ isValid: true });
    expect((await POST(request(undefined, { 'x-api-key': randomBytes(32).toString('hex') }))).status).toBe(200);
    validateApiKey.mockClear();
    expect((await POST(request(undefined, { authorization: `Basic ${randomBytes(32).toString('hex')}` }))).status).toBe(401);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('keeps invalid JSON a 400', async () => {
    const response = await POST(new NextRequest('https://api.example.test/api/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.SERVICE_API_KEY}` }, body: '{',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body.' });
  });

  it('guards stdio/shared factory contexts as well as HTTP', async () => {
    expect(() => createMcpServer(siteId, undefined, 'invalid')).toThrow(/Invalid MCP context/);
    expect(() => createMcpServer('invalid', undefined)).toThrow(/Invalid MCP context/);
    const server = createMcpServer(siteId, undefined);
    await server.close();
    expect(from).not.toHaveBeenCalled();
  });

  it('also builds schema-only workflow catalogs without instantiating history', () => {
    const tools = utils.getAssistantToolDefinitions('workflow-catalog', undefined, 'workflow-catalog');
    expect(tools.length).toBeGreaterThan(1);
    expect(tools.map(tool => tool.name)).not.toContain('instance_history');
    expect(from).not.toHaveBeenCalled();
  });
});