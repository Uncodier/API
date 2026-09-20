import {
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { NextRequest } from 'next/server';

const mockCreate: any = jest.fn();
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
});
