import { randomUUID } from 'node:crypto';
import { createProcurementTools } from '../tools';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import mapping from '@/app/api/agents/tools/router/tool-screen-map.json';
import { TOOL_CATEGORIES } from '@/app/api/agents/tools/router/assistantProtocol';

jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ assertToolScreenAccess: jest.fn() }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));

const scope: { siteId: string; userId: string } = { siteId: randomUUID(), userId: randomUUID() };
const requestId = randomUUID();
const requirementId = randomUUID();
const rpc = jest.fn();
const tool = (name: string, bound = scope) => createProcurementTools(bound, { rpc }).find(t => t.name === `procurement_${name}`)!;
const document = () => ({
  title: 'Equipment', description: 'Office equipment', request_id: null, currency: 'MXN', visibility: 'private', global_visible: false,
  participation: 'invitation_only', opening_policy: 'after_close', participation_deadline: '2030-02-01T12:00:00Z', opening_at: '2030-02-02T12:00:00Z',
  requirements: [{ id: requirementId, description: 'Laptops', quantity: 2, unit: 'unit', unit_net_minor: 10000, catalog_item_id: null }],
});

beforeEach(() => { jest.clearAllMocks(); (assertToolScreenAccess as jest.Mock).mockResolvedValue(undefined); rpc.mockResolvedValue({ id: requestId }); });

it('registers every tool with commerce discovery, actor binding and screen permissions', () => {
  expect(createProcurementTools(scope)).toHaveLength(6);
  for (const definition of createProcurementTools(scope)) {
    expect(TOOL_CATEGORIES[definition.name]).toBe('commerce');
    expect((mapping.tools as any)[definition.name]).toMatchObject({ requiresUser: true, bindActor: true });
    expect((mapping.tools as any)[definition.name]).not.toHaveProperty('adminOnly');
    expect(definition.parameters).toMatchObject({ type: 'object', required: ['action'], additionalProperties: false });
    expect(definition.parameters.properties.action.enum.length).toBeGreaterThan(0);
    expect(JSON.stringify(definition.parameters)).not.toContain('p_plan');
    expect(definition.parameters.properties).not.toHaveProperty('site_id');
    expect(definition.parameters.properties).not.toHaveProperty('user_id');
  }
});

it('executes only allowlisted operations and strips the optional thought field', async () => {
  const response = await tool('tenders').execute({ action: 'save', expected_version: 0, document: document(), thought_process: 'Create a draft' });
  expect(response).toMatchObject({ success: true, operation: 'tenders.save' });
  expect(rpc).toHaveBeenCalledWith('tenders.save', { expected_version: 0, document: document() });
  expect(assertToolScreenAccess).toHaveBeenCalledWith('procurement_tenders', scope);
});

it('keeps creation revision zero valid in root JSON schema as well as action branches', () => {
  const schema = tool('tenders').parameters;
  expect(schema.properties.expected_version.anyOf).toEqual(expect.arrayContaining([expect.objectContaining({ minimum: 0 })]));
  expect(schema.oneOf.find((branch: any) => branch.properties.action.const === 'save')?.properties.expected_version.minimum).toBe(0);
});

it.each([
  { action: 'list', site_id: randomUUID() }, { action: 'list', user_id: randomUUID() },
  { action: 'publish', id: requestId, expected_version: 1, plan: { stages: [] } },
  { action: 'save', expected_version: 0, document: { ...document(), status: 'published' } },
  { action: '__proto__' }, { action: 'constructor' }, { action: 'execute_sql', sql: 'select 1' },
  { action: 'list', limit: 101 }, { action: 'list', offset: -1 }, { action: 'list', limit: 1.5 },
])('rejects forged authority, unrestricted operations and invalid pagination: %j', async args => {
  await expect(tool('tenders').execute(args)).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});

it('requires real host identity, including when called outside the router', async () => {
  await expect(tool('tenders', { siteId: scope.siteId, userId: '' }).execute({ action: 'list' })).rejects.toThrow('verified');
  expect(rpc).not.toHaveBeenCalled();
});

it('denies revoked permission before database effects', async () => {
  (assertToolScreenAccess as jest.Mock).mockRejectedValue(new Error('denied'));
  await expect(tool('tenders').execute({ action: 'list' })).rejects.toThrow('denied');
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  { expected_version: 1, document: document() },
  { id: requestId, expected_version: 0, document: document() },
  { id: requestId, document: document() },
  { expected_version: 0, document: { ...document(), global_visible: true } },
  { expected_version: 0, document: { ...document(), opening_at: '2030-01-01T00:00:00Z' } },
  { expected_version: 0, document: { ...document(), requirements: [...document().requirements, ...document().requirements] } },
  { expected_version: 0, document: { ...document(), requirements: [{ ...document().requirements[0], unit_net_minor: Number.MAX_SAFE_INTEGER }] } },
])('requires safe draft versions, visibility, dates and totals', async args => {
  await expect(tool('tenders').execute({ action: 'save', ...args })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});

it('distinguishes eligibility invitation from notification and preserves version', async () => {
  const args = { id: requestId, expected_version: 4, supplier_id: randomUUID(), status: 'invited' };
  await tool('tenders').execute({ action: 'participant', ...args });
  expect(rpc).toHaveBeenCalledWith('tenders.participant', args);
  expect(tool('tenders').description).toContain('DO NOT send email');
});

it('validates free-text estimates without overriding catalog pricing', async () => {
  const valid = { action: 'save', expected_revision: 0, document: { title: 'Service', currency: 'MXN', lines: [{ catalog_item_id: null, description: 'Consulting', quantity: 1, unit_estimate_minor: 100, tax_ids: [] }] } };
  await tool('requests').execute(valid);
  expect(rpc).toHaveBeenCalledTimes(1);
  rpc.mockClear();
  await expect(tool('requests').execute({ ...valid, document: { ...valid.document, lines: [{ ...valid.document.lines[0], catalog_item_id: randomUUID() }] } })).rejects.toThrow();
  await expect(tool('requests').execute({ ...valid, document: { ...valid.document, lines: [{ ...valid.document.lines[0], tax_ids: undefined }] } })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});

it('requires explicit stable receipt idempotency and rejects duplicate or fractional lines', async () => {
  const receipt = { order_id: randomUUID(), idempotency_key: randomUUID(), note: 'Accepted service', lines: [{ item_id: randomUUID(), quantity: 1 }] };
  await tool('orders').execute({ action: 'receive', document: receipt });
  await tool('orders').execute({ action: 'receive', document: receipt });
  expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  rpc.mockClear();
  for (const invalid of [{ ...receipt, idempotency_key: undefined }, { ...receipt, lines: [...receipt.lines, ...receipt.lines] }, { ...receipt, lines: [{ ...receipt.lines[0], quantity: 0.5 }] }]) {
    await expect(tool('orders').execute({ action: 'receive', document: invalid })).rejects.toThrow();
  }
  expect(rpc).not.toHaveBeenCalled();
});

it('does not retry or turn failed persistence into success', async () => {
  rpc.mockRejectedValue(new Error('conflict'));
  await expect(tool('tenders').execute({ action: 'transition', id: requestId, expected_version: 1, transition: 'close' })).rejects.toThrow('conflict');
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('normalizes UUIDs before dispatch and catches duplicates regardless of letter case', async () => {
  const upper = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
  await tool('tenders').execute({ action: 'get', id: upper });
  expect(rpc).toHaveBeenCalledWith('tenders.get', { id: upper.toLowerCase() });
  rpc.mockClear();
  const row = { ...document().requirements[0], id: upper };
  await expect(tool('tenders').execute({ action: 'save', expected_version: 0,
    document: { ...document(), requirements: [row, { ...row, id: upper.toLowerCase() }] },
  })).rejects.toThrow('Duplicate');
  expect(rpc).not.toHaveBeenCalled();
});