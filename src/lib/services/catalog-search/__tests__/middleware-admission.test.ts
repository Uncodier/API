import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
const mockRate = jest.fn();
const mockAuth = jest.fn();
jest.mock('@/lib/security/request-rate-limit', () => ({ enforceRequestRateLimit: mockRate }));
jest.mock('@/middleware/apiKeyAuth', () => ({ apiKeyAuth: mockAuth }));
jest.mock('@/lib/security/upstash-rest', () => ({ getCachedJson: jest.fn(), setCachedJson: jest.fn(), sha256: async (value: string) => value }));
jest.mock('../../../../../cors.config.js', () => ({ getAllowedOrigins: () => [], getAllowedHeaders: () => '' }));
import middleware from '@/middleware/requestMiddleware';

describe('catalog BFF admission before the handler', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    jest.clearAllMocks(); process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
    Object.assign(process.env, { NODE_ENV: 'test' });
    mockAuth.mockImplementation(async () => NextResponse.next());
  });
  afterEach(() => { delete process.env.SERVICE_API_KEY; Object.assign(process.env, { NODE_ENV: previousNodeEnv }); });
  it('allows distinct shoppers behind the same egress without consuming the generic IP bucket', async () => {
    const counts = new Map<string, number>();
    mockRate.mockImplementation(async (_request: Request, policy: { namespace: string; limit: number }) => {
      const count = (counts.get(policy.namespace) || 0) + 1; counts.set(policy.namespace, count);
      return count > policy.limit ? NextResponse.json({ error: policy.namespace }, { status: 429 }) : null;
    });
    for (let n = 0; n < 301; n++) {
      const request = new NextRequest('https://example.invalid/api/catalog/search', { method: 'POST', headers: {
        'x-api-key': process.env.SERVICE_API_KEY!, 'x-vercel-forwarded-for': '192.0.2.1',
        'x-catalog-client-id': randomBytes(32).toString('hex'),
      } });
      expect((await middleware(request)).status).toBe(200);
    }
    expect(counts.has('api')).toBe(false);
    expect(counts.has('api-key-validation')).toBe(false);
    expect(mockAuth).toHaveBeenCalledTimes(301);
    expect(counts.get('service-expensive')).toBe(301);
  });
  it('does not grant the BFF path to a caller merely forging a shopper bucket', async () => {
    mockRate.mockResolvedValue(null);
    mockAuth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const request = new NextRequest('https://example.invalid/api/catalog/search', { method: 'POST', headers: {
      'x-api-key': randomBytes(24).toString('hex'), 'x-catalog-client-id': randomBytes(32).toString('hex'),
    } });
    expect((await middleware(request)).status).toBe(401);
    expect(mockRate.mock.calls.some(([, policy]) => policy.namespace === 'api')).toBe(true);
  });
});