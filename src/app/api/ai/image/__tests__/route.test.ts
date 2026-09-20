import { describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: jest.fn(async () => null),
  getAuthenticatedRateIdentity: jest.fn(() => 'user:test'),
  isInternalServiceRequest: jest.fn(() => false),
}));
jest.mock('@/lib/security/site-access', () => ({
  canAccessSite: jest.fn(async () => true),
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
    PRICING: { IMAGE_GENERATION: 0.1 },
    validateCredits: jest.fn(async () => true),
    deductCredits: jest.fn(async () => ({ success: true })),
  },
}));
jest.mock('../provider-azure', () => ({ generateWithAzure: jest.fn() }));
jest.mock('../provider-gemini', () => ({ generateWithGemini: jest.fn() }));
jest.mock('../provider-vercel', () => ({ generateWithVercelGateway: jest.fn() }));

import { POST } from '../route';

describe('AI image route', () => {
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
