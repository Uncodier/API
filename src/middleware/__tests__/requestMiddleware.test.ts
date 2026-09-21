import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const mockApiKeyAuth: any = jest.fn();
const mockEnforceRequestRateLimit: any = jest.fn();

jest.mock('../../../cors.config.js', () => ({
  getAllowedHeaders: () => 'Content-Type, Authorization',
  getAllowedOrigins: () => ['https://app.makinari.com'],
}));
jest.mock('../apiKeyAuth', () => ({
  apiKeyAuth: mockApiKeyAuth,
}));
jest.mock('@/lib/security/request-rate-limit', () => ({
  enforceRequestRateLimit: mockEnforceRequestRateLimit,
}));

import requestMiddleware, {
  isPublicRequest,
  isWebhookPath,
} from '../requestMiddleware';
import { usesRouteLevelGenerationRateLimit } from '../requestRateLimits';

describe('request middleware route classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRequestRateLimit.mockResolvedValue(null);
  });

  it('keeps only read-only status routes public', () => {
    expect(isPublicRequest('/api/status', 'GET')).toBe(true);
    expect(isPublicRequest('/api/status/systems', 'GET')).toBe(true);
    expect(isPublicRequest('/api/status/webhook', 'POST')).toBe(false);
  });

  it('allows public delivery routes without making private AI routes public', () => {
    expect(isPublicRequest('/api/public/posts', 'GET')).toBe(true);
    expect(isPublicRequest('/api/tracking/email', 'GET')).toBe(true);
    expect(isPublicRequest('/api/visitors/segment', 'POST')).toBe(true);
    expect(isPublicRequest('/api/ai/text', 'POST')).toBe(false);
    expect(isPublicRequest('/api/ai/image/health', 'GET')).toBe(true);
  });

  it('recognizes only explicitly supported webhook surfaces', () => {
    expect(isWebhookPath('/api/integrations/stripe/webhook')).toBe(true);
    expect(isWebhookPath('/api/integrations/agentmail/webhook/message-received')).toBe(true);
    expect(isWebhookPath('/api/integrations/stripe/checkout')).toBe(false);
  });

  it('defers prompt image generation limits until after cache lookup', () => {
    expect(usesRouteLevelGenerationRateLimit(
      '/api/public/image/prompt/a%20cat',
      'GET',
    )).toBe(true);
    expect(usesRouteLevelGenerationRateLimit(
      '/api/public/video/prompt/a%20cat',
      'GET',
    )).toBe(false);
    expect(usesRouteLevelGenerationRateLimit(
      '/api/public/image/prompt/a%20cat',
      'POST',
    )).toBe(false);
  });

  it('applies dedicated delivery limits before prompt image cache lookup', async () => {
    const response = await requestMiddleware(new NextRequest(
      'https://api.makinari.com/api/public/image/prompt/a%20cat',
      { headers: { referer: 'https://preview.example.com' } },
    ));

    expect(response.status).toBe(200);
    expect(mockEnforceRequestRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRequestRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.any(NextRequest),
      expect.objectContaining({
        namespace: 'public-image-read',
        limit: 300,
        windowSeconds: 60,
      }),
    );
    expect(mockEnforceRequestRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.any(NextRequest),
      expect.objectContaining({
        namespace: 'public-image-read-global',
        identity: 'global',
        limit: 10_000,
      }),
    );
  });

  it('does not treat an allowed Origin as authentication', async () => {
    mockApiKeyAuth.mockResolvedValue(NextResponse.json(
      { error: 'API key required' },
      { status: 401 },
    ));
    const response = await requestMiddleware(new NextRequest(
      'https://api.makinari.com/api/ai/text',
      { headers: { origin: 'https://app.makinari.com' } },
    ));

    expect(response.status).toBe(401);
    expect(mockApiKeyAuth).toHaveBeenCalledTimes(1);
  });
});
