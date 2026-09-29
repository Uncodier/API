import {
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { NextRequest } from 'next/server';

const mockCreate: any = jest.fn();
const mockFirstPartyUser: any = jest.fn();
const mockList: any = jest.fn();
const mockRevoke: any = jest.fn();
const mockMaybeSingle: any = jest.fn();
const mockEq: any = jest.fn(() => ({ eq: mockEq, maybeSingle: mockMaybeSingle }));
const mockSelect: any = jest.fn(() => ({ eq: mockEq }));
const mockClient = { from: jest.fn(() => ({ select: mockSelect })) };

jest.mock('@/lib/services/api-keys/ApiKeyService', () => ({
  ApiKeyService: {
    createApiKey: mockCreate,
    listApiKeys: mockList,
    revokeApiKey: mockRevoke,
  },
}));
jest.mock('@/lib/database/supabase-server', () => ({
  createSupabaseClient: jest.fn(() => mockClient),
}));
jest.mock('@/lib/services/visitor-identity/token-auth', () => ({
  authenticateFirstPartyUser: (...args: unknown[]) => mockFirstPartyUser(...args),
}));

import { DELETE, GET, POST } from '../route';

const userId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';
const authenticatedHeaders = {
  'content-type': 'application/json',
  'x-auth-user-id': userId,
};

describe('/api/keys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_KEY = 'test-encryption-key';
    mockMaybeSingle.mockResolvedValue({ data: { id: siteId }, error: null });
    mockFirstPartyUser.mockResolvedValue({ id: userId });
  });

  it('creates a key for the authenticated user', async () => {
    mockCreate.mockResolvedValue({
      apiKey: 'key_secret',
      id: 'key-id',
      prefix: 'key',
      expires_at: new Date().toISOString(),
    });
    const response = await POST(new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: authenticatedHeaders,
      body: JSON.stringify({
        name: 'Integration',
        scopes: ['read'],
        site_id: siteId,
      }),
    }));

    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ site_id: siteId }),
      expect.objectContaining({ client: mockClient }),
    );
  });

  it('lists keys without trusting a user_id query parameter', async () => {
    mockList.mockResolvedValue([{ id: 'key-id', prefix: 'key' }]);
    const response = await GET(new NextRequest(
      `http://localhost/api/keys?site_id=${siteId}`,
      { headers: authenticatedHeaders },
    ));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(userId, siteId);
  });

  it('revokes keys for the authenticated user', async () => {
    mockRevoke.mockResolvedValue(true);
    const response = await DELETE(new NextRequest(
      `http://localhost/api/keys?id=key-id&site_id=${siteId}`,
      { headers: authenticatedHeaders },
    ));

    expect(response.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith(userId, 'key-id', siteId);
  });

  it('rejects requests without trusted middleware identity', async () => {
    const response = await GET(new NextRequest(
      `http://localhost/api/keys?site_id=${siteId}&user_id=${userId}`,
    ));
    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('requires independent user authentication and site ownership to provision identity:issue', async () => {
    const response = await POST(new NextRequest('http://localhost/api/keys', {
      method: 'POST', headers: { ...authenticatedHeaders, authorization: 'Bearer test-user-token' },
      body: JSON.stringify({ name: 'Identity', scopes: ['identity:issue'], site_id: siteId }),
    }));
    expect(response.status).toBe(200);
    expect(mockFirstPartyUser).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledWith('user_id', userId);
  });

  it.each([null, undefined])('rejects non-site identity issuer provisioning', async site_id => {
    const response = await POST(new NextRequest('http://localhost/api/keys', {
      method: 'POST', headers: authenticatedHeaders,
      body: JSON.stringify({ name: 'Identity', scopes: ['identity:issue'], site_id }),
    }));
    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-owner even if the caller requests the issuer scope', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const response = await POST(new NextRequest('http://localhost/api/keys', {
      method: 'POST', headers: authenticatedHeaders,
      body: JSON.stringify({ name: 'Identity', scopes: ['identity:issue'], site_id: siteId }),
    }));
    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
