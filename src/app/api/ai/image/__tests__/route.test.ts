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
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    PRICING: { IMAGE_GENERATION: 0.1 },
    validateCredits: jest.fn(async () => true),
    deductCredits: jest.fn(async () => ({ success: true })),
  },
}));
jest.mock('../provider-azure', () => ({ generateWithAzure: jest.fn() }));

import { GET, POST } from '../route';
import { generateWithAzure } from '../provider-azure';
import { CreditService } from '@/lib/services/billing/CreditService';
import { mediaInstanceBelongsToSite } from '@/lib/services/ai/media-instance-access';

describe('AI image route', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it.each(['openrouter', 'gemini', 'vercel'])('rejects non-Azure provider %s before generation or billing', async provider => {
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111', provider, model: 'raw-deployment' }),
    }));
    expect(response.status).toBe(400);
    expect(generateWithAzure).not.toHaveBeenCalled();
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });
  it('rejects foreign instance asset links before generation or billing', async () => {
    jest.mocked(mediaInstanceBelongsToSite).mockResolvedValueOnce(false);
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111', instance_id: '22222222-2222-4222-8222-222222222222' }),
    }));
    expect(response.status).toBe(403);
    expect(generateWithAzure).not.toHaveBeenCalled();
    expect(CreditService.validateCredits).not.toHaveBeenCalled();
  });
  it('defaults to Azure and charges only actual successful outputs', async () => {
    jest.mocked(generateWithAzure).mockResolvedValueOnce({ provider: 'azure', images: [{ url: 'https://storage.example.test/a.png', b64_json: null }] });
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111', n: 2, model: 'image-deployment' }),
    }));
    expect(response.status).toBe(200);
    expect(generateWithAzure).toHaveBeenCalledWith(expect.objectContaining({ count: 2, model: 'image-deployment' }));
    expect(CreditService.validateCredits).toHaveBeenCalledWith(expect.any(String), 0.2);
    expect(CreditService.deductCredits).toHaveBeenCalledWith(expect.any(String), 0.1, 'image_generation', expect.any(String), expect.any(Object));
  });

  it('never falls back or charges when Azure fails', async () => {
    jest.mocked(generateWithAzure).mockRejectedValueOnce(new Error('upstream failed'));
    const response = await POST(new NextRequest('http://localhost/api/ai/image', {
      method: 'POST', body: JSON.stringify({ prompt: 'cat', site_id: '11111111-1111-4111-8111-111111111111' }),
    }));
    expect(response.status).toBe(500);
    expect(generateWithAzure).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
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
