import { NextRequest, NextResponse } from 'next/server';
const mockKeyAuth = jest.fn();
const mockLimit = jest.fn();
jest.mock('../../../../../cors.config.js', () => ({
  getAllowedHeaders: () => 'content-type, authorization, x-visitor-session-token',
  getAllowedOrigins: () => ['https://app.makinari.com'],
}));
jest.mock('@/middleware/apiKeyAuth', () => ({ apiKeyAuth: (...args: unknown[]) => mockKeyAuth(...args) }));
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: (...args: unknown[]) => mockLimit(...args) }));
import requestMiddleware from '@/middleware/requestMiddleware';
import { requestRatePolicy } from '@/middleware/requestRateLimits';

describe('identity routes own their authentication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLimit.mockResolvedValue(null);
    mockKeyAuth.mockResolvedValue(NextResponse.json({}, { status: 401 }));
  });

  it.each([
    '/api/visitors/identity/token', '/api/visitors/identity/token/current-user',
    '/api/visitors/session/11111111-1111-4111-8111-111111111111/identify/token',
  ])('passes %s to route auth without global/service shortcuts or spoofed metadata', async path => {
    const response = await requestMiddleware(new NextRequest(`http://localhost${path}`, {
      method: 'POST', headers: { 'x-api-key': 'untrusted', 'x-api-key-data': '{"isService":true}', 'x-auth-user-id': 'spoofed', 'x-auth-validated': 'true' },
    }));
    expect(response.status).toBe(200);
    expect(mockLimit).toHaveBeenCalled();
    expect(mockKeyAuth).not.toHaveBeenCalled();
    expect(response.headers.get('x-middleware-request-x-auth-user-id')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-api-key-data')).toBeNull();
  });

  it('does not extend issuer auth bypass to arbitrary descendants', async () => {
    const response = await requestMiddleware(new NextRequest('http://localhost/api/visitors/identity/token/unrelated', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(mockKeyAuth).toHaveBeenCalled();
  });

  it('separates shared BFF issuance admission from tracking ingestion', () => {
    expect(requestRatePolicy('/api/visitors/identity/token/current-user', false)).toMatchObject({ namespace: 'identity-current-user-admission', limit: 1200 });
    expect(requestRatePolicy('/api/visitors/track', false)).toMatchObject({ namespace: 'tracking', limit: 300 });
  });
});