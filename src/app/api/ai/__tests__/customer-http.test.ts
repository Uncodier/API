import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { POST as text } from '../text/route';
import { POST as embeddings } from '../embeddings/route';
import { POST as summary } from '../summary/route';
import { POST as continuation } from '../text/continuation/route';
import { POST as instance } from '../../agents/tools/instance/route';
import { instanceCore } from '../../agents/tools/instance/core';
import { executionRoutingHeaders } from '@/lib/services/ai/customer-routing-http';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { resolveCustomerCredential, getCustomerSelection } from '@/lib/integrations/openrouter/store';
import { getCustomerOperationKey, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';
import { beginCustomerInference, recordCustomerInference } from '@/lib/services/billing/customer-inference-receipts';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn() }));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn(), getAuthenticatedRateIdentity: jest.fn() }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn(), getCustomerSelection: jest.fn() }));
jest.mock('@/lib/services/summary/SummaryGenerationService', () => ({ SummaryGenerationService: { summarize: jest.fn(), summarizeSource: jest.fn() } }));
jest.mock('@/lib/services/continuation-service', () => ({ continueJsonGeneration: jest.fn(), isIncompleteJson: jest.fn(), attemptJsonRepair: jest.fn() }));
jest.mock('../../agents/tools/instance/core', () => ({ instanceCore: jest.fn() }));
jest.mock('@/lib/services/billing/customer-inference-receipts', () => ({
  beginCustomerInference: jest.fn(), recordCustomerInference: jest.fn(), rejectCustomerInference: jest.fn(),
  CustomerReceiptError: class extends Error {},
}));

const siteId = randomUUID();
const routing: ExecutionRoutingReference = { payer: 'customer', siteId, connectionId: randomUUID(), policyVersion: 1, credentialVersion: 1 };
const create = jest.fn();
const original = { ...process.env };
let customerKey: string;
beforeEach(() => {
  jest.resetAllMocks();
  process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
  delete process.env.OPENROUTER_CUSTOMER_EXECUTION_ENABLED;
  customerKey = randomBytes(32).toString('hex');
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userId: randomUUID(), siteId });
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(true);
  jest.mocked(resolveCustomerCredential).mockResolvedValue({ apiKey: customerKey, capabilities: {
    text: { mode: 'manual', modelId: 'vendor/customer', status: 'available' },
    embedding: { mode: 'manual', modelId: 'openai/text-embedding-3-small', status: 'available', embeddingDimensions: 2 },
  }, catalog: [{ id: 'vendor/customer', contextLength: 100000, inputModalities:['text'],outputModalities:['text'],supportedParameters:[] }, { id: 'openai/text-embedding-3-small', contextLength: 100000 }] } as any);
  jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create } } }) as any);
  create.mockResolvedValue({ id: randomUUID(), choices: [{ message: { content: 'customer' } }] });
  jest.mocked(beginCustomerInference).mockImplementation(async () => {
    expect(getCustomerOperationKey()).toBe('durable-intent:0');
    return randomUUID();
  });
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...original }; jest.restoreAllMocks(); });

function request(path: string, body: object, headers: Record<string, string> = {}) {
  return new NextRequest(`https://api.example.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

it.each([
  ['/api/ai/text', text, { messages: [{ role: 'user', content: 'hello' }] }],
  ['/api/ai/embeddings', embeddings, { input: 'hello' }],
  ['/api/ai/summary', summary, { text: 'hello' }],
  ['/api/ai/text/continuation', continuation, { incompleteJson: '{' }],
  ['/api/agents/tools/instance', instance, { action: 'update', instance_id: randomUUID() }],
] as const)('authenticates and authorizes %s independently of middleware', async (path, route, body) => {
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(null);
  expect((await route(request(path, { ...body, site_id: siteId, user_id: randomUUID(), payer: 'platform' }))).status).toBe(401);
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userId: randomUUID(), siteId });
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(false);
  expect((await route(request(path, { ...body, site_id: randomUUID() }))).status).toBe(403);
  expect(create).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(resolveCustomerCredential).not.toHaveBeenCalled();
});

it('scopes instance auto-rename and removes body actor impersonation', async () => {
  const headers = await executionRoutingHeaders(routing, { path: '/api/agents/tools/instance', operationId: 'durable-intent' });
  jest.mocked(instanceCore).mockImplementation(async args => {
    expect(args.user_id).not.toBe('forged');
    expect(getCustomerOperationKey()).toBe('durable-intent:0');
    return { success: true } as any;
  });
  expect((await instance(request('/api/agents/tools/instance', { site_id: siteId, action: 'update', user_id: 'forged' }, headers))).status).toBe(200);
  expect(resolveCustomerCredential).toHaveBeenCalledWith(routing);
});

it('pins customer text credentials/model and signed operation across retry admission', async () => {
  const headers = await executionRoutingHeaders(routing, { path: '/api/ai/text', operationId: 'durable-intent' });
  const response = await text(request('/api/ai/text', { site_id: siteId, model: 'ignored/global', messages: [{ role: 'user', content: 'hello' }] }, headers));
  expect(response.status).toBe(200);
  expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: customerKey }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'vendor/customer', provider: { allow_fallbacks: false, require_parameters: true } }), expect.anything());
  expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(recordCustomerInference).toHaveBeenCalled();
});

it('dispatches embedding through customer credential and preserves the requested embedding space', async () => {
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: randomUUID(), model: 'openai/text-embedding-3-small', data: [{ index: 0, embedding: [0.1, 0.2] }] })));
  const headers = await executionRoutingHeaders(routing, { path: '/api/ai/embeddings', operationId: 'durable-intent' });
  const response = await embeddings(request('/api/ai/embeddings', { site_id: siteId, input: 'hello', dimensions: 2 }, headers));
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/embeddings', expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${customerKey}` }) }));
  expect(OpenAI).not.toHaveBeenCalled();
  expect(recordCustomerInference).toHaveBeenCalled();
});

it('does not fall back for revoked customer credentials', async () => {
  jest.mocked(resolveCustomerCredential).mockRejectedValue(new Error('revoked'));
  const headers = await executionRoutingHeaders(routing, { path: '/api/ai/text' });
  expect((await text(request('/api/ai/text', { site_id: siteId, messages: [{ role: 'user', content: 'hello' }] }, headers))).status).toBe(500);
  expect(OpenAI).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps gate-disabled global text without connection schema reads', async () => {
  expect((await text(request('/api/ai/text', { site_id: siteId, messages: [{ role: 'user', content: 'hello' }] }))).status).toBe(200);
  expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: process.env.OPENROUTER_API_KEY }));
  expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(resolveCustomerCredential).not.toHaveBeenCalled();
});