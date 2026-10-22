import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: jest.fn(async () => null),
  getAuthenticatedRateIdentity: jest.fn(() => 'user:test'),
  isInternalServiceRequest: jest.fn(() => false),
}));
jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: jest.fn(async () => true),
}));
jest.mock('@/lib/services/ai/media-instance-access', () => ({ mediaInstanceBelongsToSite: jest.fn(async () => true) }));
jest.mock('@/lib/services/billing/image-credit-reservations', () => ({
  ...jest.requireActual<any>('@/lib/services/billing/image-credit-reservations'),
  holdImageCredits: jest.fn(async () => {}), dispatchImageCredits: jest.fn(async () => {}),
  settleImageCredits: jest.fn(async () => {}), releaseImageCredits: jest.fn(async () => {}),
  markImageCreditsPending: jest.fn(async () => {}),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock('../provider-azure', () => ({ generateWithAzure: jest.fn(), validateAzureImageOptions: jest.fn() }));

import { GET, POST } from '../route';
import { generateWithAzure } from '../provider-azure';
import { holdImageCredits, settleImageCredits, releaseImageCredits, markImageCreditsPending } from '@/lib/services/billing/image-credit-reservations';
import { mediaInstanceBelongsToSite } from '@/lib/services/ai/media-instance-access';
import { MediaRequestError } from '@/lib/services/image/media-request-error';

describe('AI image route', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it.each(['openrouter', 'gemini', 'vercel'])('rejects non-Azure provider %s before generation or billing', async provider => {
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111', provider, model: 'raw-deployment' }),
    }));
    expect(response.status).toBe(400);
    expect(generateWithAzure).not.toHaveBeenCalled();
    expect(holdImageCredits).not.toHaveBeenCalled();
    expect(settleImageCredits).not.toHaveBeenCalled();
  });
  it('rejects foreign instance asset links before generation or billing', async () => {
    jest.mocked(mediaInstanceBelongsToSite).mockResolvedValueOnce(false);
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111', instance_id: '22222222-2222-4222-8222-222222222222' }),
    }));
    expect(response.status).toBe(403);
    expect(generateWithAzure).not.toHaveBeenCalled();
    expect(holdImageCredits).not.toHaveBeenCalled();
  });
  it('defaults to Azure and charges only actual successful outputs', async () => {
    jest.mocked(generateWithAzure).mockImplementationOnce(async options => {
      await options.beforeDispatch?.();
      return { provider: 'azure', images: [{ url: 'https://storage.example.test/a.png', b64_json: null }] };
    });
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111', n: 2, model: 'image-deployment' }),
    }));
    expect(response.status).toBe(200);
    expect(generateWithAzure).toHaveBeenCalledWith(expect.objectContaining({ count: 2, model: 'image-deployment' }));
    expect(holdImageCredits).toHaveBeenCalledWith(expect.objectContaining({ siteId: expect.any(String) }), 2);
    expect(settleImageCredits).toHaveBeenCalledWith(expect.any(Object), 1, undefined, undefined);
  });

  it('never falls back or charges when Azure fails', async () => {
    jest.mocked(generateWithAzure).mockRejectedValueOnce(new Error('upstream failed'));
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111' }),
    }));
    expect(response.status).toBe(500);
    expect(generateWithAzure).toHaveBeenCalledTimes(1);
    expect(settleImageCredits).not.toHaveBeenCalled();
    expect(releaseImageCredits).toHaveBeenCalledWith(expect.any(Object), 'not_dispatched');
    expect(markImageCreditsPending).not.toHaveBeenCalled();
  });
  it('returns the safe configuration error as 503 without deducting credits', async () => {
    jest.mocked(generateWithAzure).mockRejectedValueOnce(new MediaRequestError('Invalid Azure image endpoint configuration', 503));
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111' }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Invalid Azure image endpoint configuration' });
    expect(generateWithAzure).toHaveBeenCalledTimes(1);
    expect(settleImageCredits).not.toHaveBeenCalled();
  });
  it('advertises only Azure image generation', async () => {
    expect(await (await GET()).json()).toMatchObject({ providers: ['azure'], default_provider: 'azure' });
  });
  it('rejects the system billing bypass for non-service callers', async () => {
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'test',
        site_id: '00000000-0000-0000-0000-000000000000',
      }),
    }));
    expect(response.status).toBe(403);
  });

  it('bounds prompt length before provider execution', async () => {
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'x'.repeat(10_001),
        site_id: '11111111-1111-4111-8111-111111111111',
      }),
    }));
    expect(response.status).toBe(400);
  });
});
