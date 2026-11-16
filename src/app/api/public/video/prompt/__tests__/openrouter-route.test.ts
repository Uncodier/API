import { NextRequest } from 'next/server';
import { GET } from '../[...prompt]/route';
import { start } from 'workflow/api';
import { downloadVideoFromCache } from '@/lib/services/video/promptVideoCache';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import { resolveHttpExecutionRouting } from '@/lib/services/ai/customer-routing-http';
import { acquireLock } from '@/lib/security/upstash-rest';
import type { GeneratePromptVideoInput } from '../workflow';

jest.mock('workflow/api', () => ({ start: jest.fn() }));
jest.mock('../workflow', () => ({ generatePromptVideoWorkflow: jest.fn() }));
jest.mock('@/lib/services/video/promptVideoCache', () => ({ getVideoPromptHash: jest.fn(), downloadVideoFromCache: jest.fn() }));
jest.mock('@/lib/services/image/resolveSiteFromRequirementUrl', () => ({ resolveSiteFromRequirementUrl: jest.fn() }));
jest.mock('@/lib/security/request-rate-limit', () => ({ hasAuthenticatedPrincipal: jest.fn() }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/services/ai/customer-routing-http', () => ({ resolveHttpExecutionRouting: jest.fn() }));
jest.mock('@/lib/security/upstash-rest', () => ({ acquireLock: jest.fn(), releaseLock: jest.fn() }));

beforeEach(() => jest.resetAllMocks());

it.each(['azure', 'vercel'])('rejects direct provider query %s without opening a workflow', async provider => {
  const url = new URL('https://api.example.test/api/public/video/prompt/cat');
  url.searchParams.set('provider', provider);
  url.searchParams.set('model', 'raw-deployment');
  const response = await GET(new NextRequest(url), { params: Promise.resolve({ prompt: ['cat'] }) });
  expect(response.status).toBe(400);
  expect(start).not.toHaveBeenCalled();
  expect(downloadVideoFromCache).not.toHaveBeenCalled();
});

it('rejects explicit platform OpenRouter after authoritative ownership and routing checks', async () => {
  jest.mocked(hasAuthenticatedPrincipal).mockReturnValue(true);
  jest.mocked(canAccessSite).mockResolvedValue(true);
  jest.mocked(resolveHttpExecutionRouting).mockResolvedValue({ payer: 'platform', siteId: 'site' });
  const url = new URL('https://example.invalid/api/public/video/prompt/cat');
  url.searchParams.set('provider', 'openrouter'); url.searchParams.set('site_id', 'site');
  expect((await GET(new NextRequest(url), { params: Promise.resolve({ prompt: ['cat'] }) })).status).toBe(400);
  expect(canAccessSite).toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled(); expect(downloadVideoFromCache).not.toHaveBeenCalled();
});

it('delegates default provider with eight-second duration to the owned workflow', async () => {
  jest.mocked(hasAuthenticatedPrincipal).mockReturnValue(true);
  jest.mocked(canAccessSite).mockResolvedValue(true);
  const executionRouting = { payer: 'platform' as const, siteId: 'site' };
  jest.mocked(resolveHttpExecutionRouting).mockResolvedValue(executionRouting);
  jest.mocked(acquireLock).mockResolvedValue({ state: 'acquired', token: 'offline-lock' });
  jest.mocked(start).mockResolvedValue({ returnValue: Promise.resolve({ status: 'pending', job_id: 'offline-job' }) } as any);
  const url = new URL('https://example.invalid/api/public/video/prompt/cat'); url.searchParams.set('site_id', 'site');
  expect((await GET(new NextRequest(url), { params: Promise.resolve({ prompt: ['cat'] }) })).status).toBe(202);
  const [, [input]] = jest.mocked(start).mock.calls[0] as unknown as [unknown, [GeneratePromptVideoInput]];
  expect(input).toMatchObject({ siteId: 'site', durationSeconds: 8, executionRouting });
  expect(input).not.toHaveProperty('provider');
});