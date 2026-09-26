// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const from = jest.fn();
const hasAuthenticatedPrincipal = jest.fn();
const canAccessSite = jest.fn();
const readRedisJson = jest.fn();
const writeRedisJson = jest.fn();

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({ hasAuthenticatedPrincipal }));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite }));
jest.unstable_mockModule('@/lib/services/redis-json-cache', () => ({ readRedisJson, writeRedisJson }));

const { GET } = await import('../route');
const instanceId = '11111111-1111-4111-8111-111111111111';
const context = { params: Promise.resolve({ instanceId }) };
const request = () => new NextRequest(`https://api.example/api/workflows/${instanceId}/runs`);

beforeEach(() => {
  jest.clearAllMocks();
  hasAuthenticatedPrincipal.mockReturnValue(true);
  canAccessSite.mockResolvedValue(true);
  readRedisJson.mockResolvedValue({ success: true, runs: [{ payload: { message: 'private' } }] });
  from.mockImplementation((table: string) => {
    if (table !== 'remote_instances') throw new Error('Unexpected DB read');
    const query: any = {};
    query.select = jest.fn().mockReturnValue(query);
    query.eq = jest.fn().mockReturnValue(query);
    query.maybeSingle = jest.fn().mockResolvedValue({ data: { site_id: 'site-1' }, error: null });
    return query;
  });
});

it('denies unauthenticated and cross-tenant readers before reading cached message payloads', async () => {
  hasAuthenticatedPrincipal.mockReturnValueOnce(false);
  expect((await GET(request(), context)).status).toBe(401);
  expect(from).not.toHaveBeenCalled();
  canAccessSite.mockResolvedValueOnce(false);
  expect((await GET(request(), context)).status).toBe(403);
  expect(readRedisJson).not.toHaveBeenCalled();
});

it('returns cached runs only after authorizing the canonical instance site', async () => {
  const response = await GET(request(), context);
  expect(response.status).toBe(200);
  expect(canAccessSite).toHaveBeenCalledWith(expect.any(NextRequest), 'site-1');
  expect(readRedisJson).toHaveBeenCalledWith(`cache:workflow-runs:${instanceId}`);
});