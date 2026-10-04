import { NextRequest } from 'next/server';
import { GET } from '../[...prompt]/route';
import { start } from 'workflow/api';
import { downloadVideoFromCache } from '@/lib/services/video/promptVideoCache';

jest.mock('workflow/api', () => ({ start: jest.fn() }));
jest.mock('../workflow', () => ({ generatePromptVideoWorkflow: jest.fn() }));
jest.mock('@/lib/services/video/promptVideoCache', () => ({ getVideoPromptHash: jest.fn(), downloadVideoFromCache: jest.fn() }));
jest.mock('@/lib/services/image/resolveSiteFromRequirementUrl', () => ({ resolveSiteFromRequirementUrl: jest.fn() }));
jest.mock('@/lib/security/request-rate-limit', () => ({ hasAuthenticatedPrincipal: jest.fn() }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/security/upstash-rest', () => ({ acquireLock: jest.fn(), releaseLock: jest.fn() }));

it.each(['azure', 'gemini', 'vercel'])('rejects direct provider query %s without opening a workflow', async provider => {
  const url = new URL('https://api.example.test/api/public/video/prompt/cat');
  url.searchParams.set('provider', provider);
  url.searchParams.set('model', 'raw-deployment');
  const response = await GET(new NextRequest(url), { params: Promise.resolve({ prompt: ['cat'] }) });
  expect(response.status).toBe(400);
  expect(start).not.toHaveBeenCalled();
  expect(downloadVideoFromCache).not.toHaveBeenCalled();
});