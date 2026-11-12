import { randomBytes, randomUUID } from 'node:crypto';
import { executionRoutingHeaders, resolveHttpExecutionRouting, authorizeInferenceRequest,
  withHttpExecutionRouting } from '../customer-routing-http';
import { getExecutionRouting, getCustomerOperationKey, getCustomerCapability, withCustomerCapability,
  withCustomerOperation, type ExecutionRoutingReference } from '../customer-routing';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { resolveCustomerCredential, getCustomerSelection } from '@/lib/integrations/openrouter/store';
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn() }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn(), getCustomerSelection: jest.fn() }));
const siteId = randomUUID();
const routing: ExecutionRoutingReference = { payer: 'customer', siteId, connectionId: randomUUID(), policyVersion: 1, credentialVersion: 1 };
const original = process.env.SERVICE_API_KEY;
beforeEach(() => {
  jest.resetAllMocks();
  process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userId: randomUUID(), siteId });
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(true);
  jest.mocked(resolveCustomerCredential).mockResolvedValue({} as any);
});
afterAll(() => { if (original === undefined) delete process.env.SERVICE_API_KEY; else process.env.SERVICE_API_KEY = original; });

it('authenticates credentials and site access before accepting signed host routing', async () => {
  const headers = await executionRoutingHeaders(routing, { path: '/api/ai/text', operationId: 'turn:1' });
  const request = new Request('https://api.example.test/api/ai/text', { headers });
  expect((await authorizeInferenceRequest(request, siteId)).routing).toEqual(routing);
  await withHttpExecutionRouting(request, routing, async () => {
    expect(getExecutionRouting()).toEqual(routing);
    expect(getCustomerOperationKey()).toBe('turn:1:0');
  });
  expect(resolveCustomerCredential).toHaveBeenCalledWith(routing);
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(false);
  await expect(authorizeInferenceRequest(request, siteId)).rejects.toMatchObject({ status: 403 });
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(null);
  await expect(authorizeInferenceRequest(request, siteId)).rejects.toMatchObject({ status: 401 });
});

it('rejects tampering, cross-site, wrong destination, expired ticket and key rotation', async () => {
  const headers = await executionRoutingHeaders(routing, { path: '/api/ai/text' });
  const request = new Request('https://api.example.test/api/ai/text', { headers });
  await expect(resolveHttpExecutionRouting(request, randomUUID())).rejects.toThrow();
  await expect(resolveHttpExecutionRouting(new Request('https://api.example.test/api/ai/audio', { headers }), siteId)).rejects.toThrow();
  const tampered = { ...headers, 'x-host-inference-routing': headers['x-host-inference-routing'] + 'x' };
  await expect(resolveHttpExecutionRouting(new Request(request.url, { headers: tampered }), siteId)).rejects.toThrow();
  const time = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
  await expect(resolveHttpExecutionRouting(request, siteId)).rejects.toThrow();
  time.mockRestore();
  process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  await expect(resolveHttpExecutionRouting(request, siteId)).rejects.toThrow();
});

it('preserves disabled-rollout global without reading schema; rejects body/header identity claims', async () => {
  const request = new Request('https://api.example.test/api/ai/text', { headers: { 'x-payer': 'customer' } });
  expect(await resolveHttpExecutionRouting(request, siteId)).toEqual({ payer: 'platform', siteId });
  expect(getCustomerSelection).not.toHaveBeenCalled();
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(null);
  await expect(authorizeInferenceRequest(request, siteId)).rejects.toMatchObject({ status: 401 });
});

it('carries host summary intent and stable child operation namespace, never body flags', async () => {
  const headers = await withCustomerOperation('durable-parent', () => withCustomerCapability('summary', () =>
    executionRoutingHeaders(routing, { path: '/api/ai/text' })));
  const request = new Request('https://api.example.test/api/ai/text', { headers });
  await withHttpExecutionRouting(request, routing, async () => {
    expect(getCustomerCapability()).toBe('summary');
    expect(getCustomerOperationKey()).toBe('durable-parent:0:0');
  });
  await withHttpExecutionRouting(request, routing, async () => {
    expect(getCustomerOperationKey()).toBe('durable-parent:0:0');
  });
  await expect(withHttpExecutionRouting(request, { payer: 'platform', siteId }, async () => true)).rejects.toThrow();
});

it('pins platform selection despite a newly selected customer connection', async () => {
  const platform = { payer: 'platform' as const, siteId };
  const headers = await executionRoutingHeaders(platform, { path: '/api/ai/text' });
  const request = new Request('https://api.example.test/api/ai/text', { headers });
  expect(await resolveHttpExecutionRouting(request, siteId)).toEqual(platform);
  await withHttpExecutionRouting(request, platform, async () => expect(getExecutionRouting()).toEqual(platform));
  expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(resolveCustomerCredential).not.toHaveBeenCalled();
});

it('denies site-less external callers and signed site-less internal requests', async () => {
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: false, userId: randomUUID(), siteId: null });
  await expect(authorizeInferenceRequest(new Request('https://api.example.test/api/ai/text'))).rejects.toMatchObject({ status: 400 });
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: true, userId: null, siteId: null });
  const headers = await executionRoutingHeaders(routing, { path: '/api/ai/text' });
  await expect(authorizeInferenceRequest(new Request('https://api.example.test/api/ai/text', { headers }))).rejects.toMatchObject({ status: 400 });
  expect((await authorizeInferenceRequest(new Request('https://api.example.test/api/ai/text'))).routing).toBeUndefined();
});