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
jest.mock('../generate-video', () => ({
  normalizeVideoDuration: jest.fn(() => 8),
  generateVideoWithGemini: jest.fn(),
}));

import { POST } from '../route';

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
});
