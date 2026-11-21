import { randomBytes, randomUUID } from 'node:crypto';
import { routeTools, toolsRouterTool, withToolsRouter, type RoutedTool } from '../assistantProtocol';
import { NATIVE_ARGUMENT_SCHEMA } from '../tool-routing-policy';

jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));
jest.mock('../screen-access', () => ({
  ...jest.requireActual('../screen-access'),
  loadToolScreenAccess: async () => ({ isAdmin: false, blockedScreens: [] }),
}));

const privateValue = () => randomBytes(24).toString('hex');
function definition(parameters: RoutedTool['parameters'], name = 'generate_image') {
  return { name, description: 'Tool', parameters, execute: jest.fn(async (..._args: unknown[]) => ({ success: true })) };
}
function rejected(output: unknown, argument_issue: object) {
  expect(output).toMatchObject({ success: false, code: 'INVALID_TOOL_ARGUMENTS', argument_issue,
    recovery: { action: 'fix_arguments', message: expect.any(String) }, executed: false, effectStarted: false, automatic_retry: false });
  expect(output).not.toHaveProperty('parameters');
}

test.each([['required', {}, 'arguments.count'], ['type', { count: '9' }, 'arguments.count'],
  ['maximum', { count: 4 }, 'arguments.count'], ['minimum', { count: -1 }, 'arguments.count'],
  ['enum', { count: 1, mode: 'other' }, 'arguments.mode'],
  ['maxItems', { count: 1, edits: [{}, {}] }, 'arguments.edits'],
  ['required', { count: 2, edits: [{}] }, 'arguments.edits[0].text'],
  ['maxLength', { count: 0, edits: [{ text: 'longer' }] }, 'arguments.edits[0].text'],
] as const)('detects %s before dispatch (%#)', async (rule, args, path) => {
  const hidden = privateValue();
  const tool = definition({ type: 'object', required: ['count'], properties: {
    count: { type: 'integer', minimum: 0, maximum: 3, description: hidden }, mode: { enum: ['slow', hidden] },
    edits: { type: 'array', maxItems: 1, items: { type: 'object', required: ['text'], properties: { text: { maxLength: 5 } } } },
  } });
  const router = toolsRouterTool([tool]);
  const output = await router.execute({ action: 'call', name: tool.name, args });
  rejected(output, { path, rule });
  expect(JSON.stringify(output)).not.toContain(hidden);
  expect(tool.execute).not.toHaveBeenCalled();
  expect(await router.execute({ action: 'call', name: tool.name, args: '{"count":3}' })).toMatchObject({ success: true });
  expect(tool.execute).toHaveBeenCalledTimes(1);
});

test('invalid object encodings never disclose values, private schema, or JS parse diagnostics', async () => {
  const secret = privateValue(), schemaMarker = privateValue();
  const tool = definition({ type: 'object', description: schemaMarker });
  const router = toolsRouterTool([tool]);
  for (const args of [secret, `{"key":${secret}}`, `["${secret}"]`, [secret], JSON.stringify(secret), 5, false, 'false', 'null']) {
    const output = await router.execute({ action: 'call', name: tool.name, args });
    rejected(output, { path: 'arguments', rule: 'json_object' });
    const text = JSON.stringify(output);
    for (const marker of [secret, schemaMarker]) expect(text).not.toContain(marker);
    expect(text).not.toMatch(/SyntaxError|Unexpected token|position \d+/i);
  }
  expect(tool.execute).not.toHaveBeenCalled();
});

test('retains historical no-argument forms while checking required arguments on the empty object', async () => {
  const tool = definition({ type: 'object', additionalProperties: false });
  const router = toolsRouterTool([tool]);
  for (const args of [undefined, null, '', '  ', {}, '{}']) {
    expect(await router.execute({ action: 'call', name: tool.name, args })).toMatchObject({ success: true });
    expect(tool.execute).toHaveBeenLastCalledWith({});
  }
});

test('validates supplied alternatives, not the union of their required fields', async () => {
  const shape = (key: string, type: string) => ({ type: 'object', required: [key], properties: { [key]: { type } }, additionalProperties: false });
  const tool = definition({ type: 'object', oneOf: [shape('id', 'integer'), shape('slug', 'string')] });
  const router = toolsRouterTool([tool]);
  for (const args of [{ id: 1 }, { slug: 'source' }]) {
    expect(await router.execute({ action: 'call', name: tool.name, args })).toMatchObject({ success: true });
  }
  rejected(await router.execute({ action: 'call', name: tool.name, args: { id: 2, slug: 'both' } }), { rule: 'choice' });
  expect(tool.execute).toHaveBeenCalledTimes(2);
});

test('native wire compatibility defers ambiguous string/structured fields without coercing or masking another issue', async () => {
  const tool = definition({ type: 'object', properties: { data: { type: 'string' }, labels: { type: 'array' }, count: { minimum: 1 } } });
  const router = toolsRouterTool([tool]);
  const args = Object.freeze({ data: Object.freeze({ body: 'document' }), labels: '["tag"]', count: 1 });
  expect(await router.execute({ action: 'call', name: tool.name, args })).toMatchObject({ success: true });
  expect(tool.execute.mock.calls[0][0]).toBe(args);
  rejected(await router.execute({ action: 'call', name: tool.name, args: { ...args, count: 0 } }), { path: 'arguments.count', rule: 'minimum' });
  expect(tool.execute).toHaveBeenCalledTimes(1);
});

test('unsupported alternatives defer to the decorated handler; typed failures and effects are retained', async () => {
  const receipt = { success: false, executed: true, error: { code: 'PARTIAL_WRITE' }, completed: 1 };
  const execute = jest.fn(async () => receipt);
  const parameters = { anyOf: [{ type: 'object', required: ['value'] }, { $ref: '#/unhandled' }] };
  const tool = { ...definition(parameters), execute };
  const output = await toolsRouterTool([tool]).execute({ action: 'call', name: tool.name, args: {} });
  expect(output).toMatchObject({ success: false, name: tool.name });
  expect(output).toHaveProperty('result', receipt);
  expect(output).not.toHaveProperty('recovery');
  expect(output).not.toHaveProperty('executed');
  expect(execute).toHaveBeenCalledTimes(1);
});

test('uses host-declared execution alternatives without publishing them, populating ids, or copying outer metadata to the tool', async () => {
  const host = randomUUID();
  const params = { type: 'object', properties: { source: { type: 'string' } }, required: ['source'], additionalProperties: false };
  const native = definition(params);
  const execute = jest.fn(async (args: unknown) => ({ host, args }));
  const [router] = routeTools([{ ...native, execute, [NATIVE_ARGUMENT_SCHEMA]: { anyOf: [params, { type: 'object',
    properties: { alias: { type: 'string', description: host } }, required: ['alias'], additionalProperties: false }] } }]);
  const describe = await router.execute({ action: 'describe', name: native.name });
  expect(describe.parameters).toEqual(params);
  expect(JSON.stringify(describe)).not.toContain(host);
  const args = Object.freeze({ alias: 'source' });
  const output = await router.execute({ action: 'call', name: native.name, args, thought_process: 'Read source' });
  expect(output).toMatchObject({ success: true, result: { host, args } });
  expect(execute.mock.calls[0][0]).toBe(args);
  expect(native.execute).not.toHaveBeenCalled();
  expect(router.parameters.required).not.toContain('thought_process');
});

test.each(['default', 'explicit'])('always-on preflight (%s) preserves host results, metadata, and additional execution arguments', async partition => {
  const params = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  const tool = definition(params, 'webSearch');
  const direct = partition === 'default' ? routeTools([tool])[0] : withToolsRouter([tool], new Set([tool.name]))[0];
  rejected(await direct.execute({}), { rule: 'required', path: 'arguments.query' });
  expect(tool.execute).not.toHaveBeenCalled();
  const input = Object.freeze({ query: 'test', thought_process: 'Check source' });
  const binding = Object.freeze({ actor: randomUUID() });
  const receipt = { success: true, results: [] };
  tool.execute.mockResolvedValue(receipt);
  expect(await direct.execute(input, binding)).toBe(receipt);
  expect(tool.execute.mock.calls[0][0]).toBe(input);
  expect(tool.execute.mock.calls[0][1]).toBe(binding);
  expect(direct.parameters.required).toEqual(['query']);
  expect(params.properties).not.toHaveProperty('thought_process');
});


test('direct dispatch leaves host-owned stops as exceptions, not argument errors or synthetic receipts', async () => {
  const params = { type: 'object', required: ['query'], properties: { query: { type: 'string' } } };
  const tool = definition(params, 'webSearch');
  const [direct] = routeTools([tool]);
  for (const error of [new Error('Host stopped'), Object.assign(new Error('Ownership changed'), { name: 'RecoveryError' })]) {
    tool.execute.mockRejectedValueOnce(error);
    await expect(direct.execute({ query: 'test' })).rejects.toBe(error);
  }
  expect(tool.execute).toHaveBeenCalledTimes(2);
});
