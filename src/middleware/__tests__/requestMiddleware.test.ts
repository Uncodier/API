import { describe, expect, it, jest } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';

const mockApiKeyAuth: any = jest.fn();

jest.mock('../../../cors.config.js', () => ({
  getAllowedHeaders: () => 'Content-Type, Authorization',
  getAllowedOrigins: () => ['https://app.makinari.com'],
}));
jest.mock('../apiKeyAuth', () => ({
  apiKeyAuth: mockApiKeyAuth,
}));

import requestMiddleware, {
  isPublicRequest,
  isWebhookPath,
} from '../requestMiddleware';

describe('request middleware route classification', () => {
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
