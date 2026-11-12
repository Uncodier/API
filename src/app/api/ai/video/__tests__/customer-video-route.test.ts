import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST, GET } from '../route';
import { executionRoutingHeaders } from '@/lib/services/ai/customer-routing-http';
import { prepareCustomerVideo } from '../customer-video';
import { startCustomerVideoJob } from '../customer-video-jobs';
import { startVideoJob, resumeVideoJob } from '../openrouter-jobs';
import { CreditService } from '@/lib/services/billing/CreditService';
import { resolveCustomerCredential, getCustomerSelection } from '@/lib/integrations/openrouter/store';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';

jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: jest.fn(async () => null),
  getAuthenticatedRateIdentity: () => 'principal', isInternalServiceRequest: () => true }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: async () => true }));
jest.mock('@/lib/services/ai/media-instance-access', () => ({ mediaInstanceBelongsToSite: async () => true }));
jest.mock('@/lib/security/tool-request-principal', () => ({ resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn() }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn(), getCustomerSelection: jest.fn() }));
jest.mock('@/lib/security/upstash-rest', () => ({ acquireLock: async () => ({ state: 'acquired', token: 'lock' }),
  releaseLock: jest.fn(), sha256: async () => 'site-hash' }));
jest.mock('../customer-video', () => ({ prepareCustomerVideo: jest.fn() }));
jest.mock('../customer-video-jobs', () => ({ startCustomerVideoJob: jest.fn() }));
jest.mock('../provider-openrouter', () => ({ prepareOpenRouterVideo: jest.fn() }));
jest.mock('../openrouter-jobs', () => ({ startVideoJob: jest.fn(), resumeVideoJob: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { PRICING: { VIDEO_GENERATION_MINUTE: 24 },
  validateCredits: jest.fn(), deductCredits: jest.fn() } }));
const siteId = '11111111-1111-4111-8111-111111111111';
const pin = { payer: 'customer' as const, siteId, connectionId: 'connection-a', policyVersion: 2, credentialVersion: 3 };
const prepared = { model: 'vendor/video', prompt: 'A garden', duration: 4, aspect_ratio: '16:9' };
const accepted = { provider: 'openrouter' as const, status: 'pending' as const, job_id: siteId, videos: [],
  metadata: { model: prepared.model, generated_at: 'now' } };
beforeEach(() => {
  jest.clearAllMocks(); process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  process.env.OPENROUTER_ROUTING_STORAGE_READY = 'true'; process.env.CUSTOMER_OPENROUTER_ENABLED = 'true';
  jest.mocked(resolveToolRequestPrincipal).mockResolvedValue({ internal: true } as any);
  jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(true);
  jest.mocked(getCustomerSelection).mockResolvedValue(pin as any);
  jest.mocked(resolveCustomerCredential).mockResolvedValue({} as any);
  jest.mocked(prepareCustomerVideo).mockResolvedValue(prepared);
  jest.mocked(startCustomerVideoJob).mockResolvedValue(accepted);
  jest.mocked(resumeVideoJob).mockResolvedValue(accepted);
});
async function request(options: { key?: string; ticket?: Record<string, string>; body?: object } = {}) {
  return new NextRequest('https://api.example.test/api/ai/video', { method: 'POST',
    headers: { 'Idempotency-Key': options.key ?? 'operation-1', ...options.ticket },
    body: JSON.stringify({ prompt: prepared.prompt, site_id: siteId, ...options.body }) });
}
it('authenticates actual signed host context and does not use platform admission', async () => {
  const ticket = await executionRoutingHeaders(pin, { path: '/api/ai/video', operationId: 'operation-1' });
  const response = await POST(await request({ ticket, body: { payer: 'platform', skip_billing: true } }));
  expect(response.status).toBe(202);
  expect(startCustomerVideoJob).toHaveBeenCalledWith(expect.anything(), prepared, 'operation-1');
  expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(resolveCustomerCredential).toHaveBeenCalledWith(pin);
  expect(CreditService.validateCredits).not.toHaveBeenCalled(); expect(startVideoJob).not.toHaveBeenCalled();
});
it('rejects tampered host tickets without customer or platform dispatch', async () => {
  expect((await POST(await request({ ticket: { 'x-host-inference-routing': 'invalid.signature' } }))).status).toBe(422);
  expect(prepareCustomerVideo).not.toHaveBeenCalled(); expect(startVideoJob).not.toHaveBeenCalled();
});
it('requires a stable operation key before catalog/provider I/O', async () => {
  expect((await POST(await request({ key: '' }))).status).toBe(400);
  expect(prepareCustomerVideo).not.toHaveBeenCalled();
});
it.each([401, 403])('denies principal/site with %s before resolving customer selection', async status => {
  if (status === 401) jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(null);
  else jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(false);
  expect((await POST(await request())).status).toBe(status);
  expect(getCustomerSelection).not.toHaveBeenCalled(); expect(startCustomerVideoJob).not.toHaveBeenCalled();
});
it('poll authorization never consults the current selected policy', async () => {
  jest.mocked(getCustomerSelection).mockRejectedValue(new Error('disconnected current selection'));
  const response = await GET(new NextRequest(`https://api.example.test/api/ai/video?site_id=${siteId}&job_id=${siteId}`));
  expect(response.status).toBe(202); expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(resumeVideoJob).toHaveBeenCalledWith(siteId, siteId);
});
it.each([401, 403])('denies terminal lookup to an unauthorized principal (%s)', async status => {
  if (status === 401) jest.mocked(resolveToolRequestPrincipal).mockResolvedValue(null);
  else jest.mocked(canToolPrincipalAccessSite).mockResolvedValue(false);
  const response = await GET(new NextRequest(`https://api.example.test/api/ai/video?site_id=${siteId}&job_id=${siteId}`));
  expect(response.status).toBe(status);
  expect(resumeVideoJob).not.toHaveBeenCalled(); expect(resolveCustomerCredential).not.toHaveBeenCalled();
});
it.each(['completed', 'failed'] as const)('serves authorized durable %s without current credentials', async status => {
  jest.mocked(resolveCustomerCredential).mockRejectedValue(new Error('revoked'));
  jest.mocked(resumeVideoJob).mockResolvedValue({ ...accepted, status });
  const response = await GET(new NextRequest(`https://api.example.test/api/ai/video?site_id=${siteId}&job_id=${siteId}`));
  expect(response.status).toBe(200);
  expect(resolveCustomerCredential).not.toHaveBeenCalled(); expect(getCustomerSelection).not.toHaveBeenCalled();
});