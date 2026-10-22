import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { generatePromptImageWorkflow } from '../workflow';
import { GET } from '../../../icon/prompt/[...prompt]/route';
import { start } from 'workflow/api';
import { hasAuthenticatedPrincipal, isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import { getPromptHash, downloadFromCache } from '@/lib/services/image/promptImageCache';
import { acquireLock } from '@/lib/security/upstash-rest';

jest.mock('workflow/api', () => ({ start: jest.fn() }));
jest.mock('../steps', () => ({ generateImageStep: jest.fn(), cacheGeneratedImageStep: jest.fn() }));
jest.mock('@/lib/services/image/promptImageCache', () => ({ getPromptHash: jest.fn(() => 'icon-hash'), downloadFromCache: jest.fn() }));
jest.mock('@/lib/services/image/resolveSiteFromRequirementUrl', () => ({ resolveSiteFromRequirementUrl: jest.fn() }));
jest.mock('@/lib/security/request-rate-limit', () => ({ hasAuthenticatedPrincipal: jest.fn(), isInternalServiceRequest: jest.fn() }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/security/upstash-rest', () => ({ acquireLock: jest.fn(), releaseLock: jest.fn() }));

const context = { params: Promise.resolve({ prompt: ['cat'] }) };
function request(siteId = 'tenant') {
  const url = new URL('https://backend.example.test/api/public/icon/prompt/cat');
  url.searchParams.set('site_id', siteId);
  return new NextRequest(url, { headers: { origin: 'https://app.makinari.com', referer: 'https://app.makinari.com/page' } });
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getPromptHash).mockReturnValue('icon-hash');
  jest.mocked(hasAuthenticatedPrincipal).mockReturnValue(true);
  jest.mocked(isInternalServiceRequest).mockReturnValue(false);
  jest.mocked(canAccessSite).mockResolvedValue(true);
  jest.mocked(acquireLock).mockResolvedValue({ state: 'acquired', token: randomBytes(24).toString('hex') });
});

it('rejects unsigned icon cache misses with both forged app headers', async () => {
  jest.mocked(hasAuthenticatedPrincipal).mockReturnValue(false);
  expect((await GET(request(), context)).status).toBe(401);
  expect(start).not.toHaveBeenCalled();
  expect(downloadFromCache).not.toHaveBeenCalled();
});
it('requires tenant access before serving even existing icon cache', async () => {
  jest.mocked(canAccessSite).mockResolvedValue(false);
  expect((await GET(request(), context)).status).toBe(403);
  expect(downloadFromCache).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
it('uses the same separated paid/non-paid workflow for icon misses', async () => {
  jest.mocked(downloadFromCache).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ buffer: Buffer.from('icon'), mimeType: 'image/png' });
  jest.mocked(start).mockResolvedValue({ returnValue: Promise.resolve({ status: 'completed' }) } as any);
  const response = await GET(request(), context);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(start).toHaveBeenCalledWith(generatePromptImageWorkflow, [expect.objectContaining({ siteId: 'tenant', hash: 'icon-hash', prompt: expect.stringContaining('app icon of cat') })]);
});
it('does not turn user plus app origin into system-funded icon generation', async () => {
  expect((await GET(request('00000000-0000-0000-0000-000000000000'), context)).status).toBe(403);
  expect(start).not.toHaveBeenCalled();
  expect(acquireLock).not.toHaveBeenCalled();
});