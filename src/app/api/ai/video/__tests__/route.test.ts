import {
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { NextRequest } from 'next/server';

const mockCanAccessSite: any = jest.fn();

jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: jest.fn(async () => null),
  getAuthenticatedRateIdentity: jest.fn(() => 'user:test'),
  isInternalServiceRequest: jest.fn(() => false),
}));
jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: mockCanAccessSite,
}));
jest.mock('@/lib/services/ai/media-instance-access', () => ({ mediaInstanceBelongsToSite: jest.fn(async () => true) }));
jest.mock('@/lib/security/safe-remote-url', () => ({
  assertSafeRemoteUrl: jest.fn(async (url: string) => new URL(url)),
}));
jest.mock('@/lib/security/upstash-rest', () => ({
  acquireLock: jest.fn(async () => ({
    state: 'acquired',
    token: 'lock-token',
  })),
  releaseLock: jest.fn(async () => undefined),
  sha256: jest.fn(async () => 'site-hash'),
}));
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    PRICING: { VIDEO_GENERATION_MINUTE: 24 },
    validateCredits: jest.fn(async () => true),
    deductCredits: jest.fn(async () => ({ success: true })),
  },
}));
jest.mock('../provider-openrouter', () => ({ prepareOpenRouterVideo: jest.fn() }));
jest.mock('../openrouter-jobs', () => ({ startVideoJob: jest.fn(), resumeVideoJob: jest.fn() }));

import { POST, GET } from '../route';
import { prepareOpenRouterVideo } from '../provider-openrouter';
import { startVideoJob, resumeVideoJob } from '../openrouter-jobs';
import { CreditService } from '@/lib/services/billing/CreditService';
import { acquireLock } from '@/lib/security/upstash-rest';
import { mediaInstanceBelongsToSite } from '@/lib/services/ai/media-instance-access';

const validSiteId = '11111111-1111-4111-8111-111111111111';

describe('AI video route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanAccessSite.mockResolvedValue(true);
  });

  it('rejects cross-site generation', async () => {
    mockCanAccessSite.mockResolvedValue(false);
    const response = await POST(new NextRequest('http://localhost/api/ai/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', site_id: validSiteId }),
    }));
    expect(response.status).toBe(403);
  });

  it('rejects a foreign instance before opening a paid job', async () => {
    jest.mocked(mediaInstanceBelongsToSite).mockResolvedValueOnce(false);
    const response = await POST(new NextRequest('http://localhost/api/ai/video', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: validSiteId, instance_id: '22222222-2222-4222-8222-222222222222' }),
    }));
    expect(response.status).toBe(403);
    expect(prepareOpenRouterVideo).not.toHaveBeenCalled();
    expect(startVideoJob).not.toHaveBeenCalled();
  });

  it('defaults to async OpenRouter and leaves billing to completion, preserving the job id', async () => {
    jest.mocked(prepareOpenRouterVideo).mockResolvedValueOnce({ model: 'example/video', prompt: 'cat', duration: 4, aspect_ratio: '16:9' });
    jest.mocked(startVideoJob).mockResolvedValueOnce({ provider: 'openrouter', status: 'pending', job_id: validSiteId, videos: [], metadata: { model: 'example/video', generated_at: 'now' } });
    const response = await POST(new NextRequest('http://localhost/api/ai/video', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: validSiteId }),
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'pending', job_id: validSiteId });
    expect(startVideoJob).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it('authorizes polling before looking up a retained job', async () => {
    mockCanAccessSite.mockResolvedValueOnce(false);
    const response = await GET(new NextRequest(`http://localhost/api/ai/video?site_id=${validSiteId}&job_id=${validSiteId}`));
    expect(response.status).toBe(403);
    expect(resumeVideoJob).not.toHaveBeenCalled();
  });

  it('fails closed on missing generation admission', async () => {
    jest.mocked(prepareOpenRouterVideo).mockResolvedValueOnce({ model: 'example/video', prompt: 'cat', duration: 4, aspect_ratio: '16:9' });
    jest.mocked(acquireLock).mockResolvedValueOnce({ state: 'unconfigured' });
    const response = await POST(new NextRequest('http://localhost/api/ai/video', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: validSiteId }),
    }));
    expect(response.status).toBe(503);
    expect(startVideoJob).not.toHaveBeenCalled();
  });

  it('rejects insufficient credits before admitting or submitting a job', async () => {
    jest.mocked(prepareOpenRouterVideo).mockResolvedValueOnce({ model: 'example/video', prompt: 'cat', duration: 4, aspect_ratio: '16:9' });
    jest.mocked(CreditService.validateCredits).mockResolvedValueOnce(false);
    const response = await POST(new NextRequest('http://localhost/api/ai/video', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: validSiteId }),
    }));
    expect(response.status).toBe(402);
    expect(acquireLock).not.toHaveBeenCalled();
    expect(startVideoJob).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it('rejects unbounded requested durations', async () => {
    const response = await POST(new NextRequest('http://localhost/api/ai/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'test',
        site_id: validSiteId,
        duration_seconds: 61,
      }),
    }));
    expect(response.status).toBe(400);
  });

  it.each(['azure', 'gemini', 'vercel'])('rejects direct provider %s without submitting or billing', async provider => {
    const response = await POST(new NextRequest('http://localhost/api/ai/video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Transition between the linked UI frames',
        provider,
        model: 'raw-deployment',
        site_id: validSiteId,
        duration_seconds: 4,
        first_frame_url: 'https://example.com/start.png',
        last_frame_url: 'https://example.com/end.png',
      }),
    }));

    expect(response.status).toBe(400);
    expect(prepareOpenRouterVideo).not.toHaveBeenCalled();
    expect(startVideoJob).not.toHaveBeenCalled();
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });
});
