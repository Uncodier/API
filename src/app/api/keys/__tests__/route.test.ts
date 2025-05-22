import { NextRequest } from 'next/server';
import { POST, GET, DELETE } from '../route';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';

// Mock environment variables
process.env.ENCRYPTION_KEY = 'test_encryption_key_32_bytes_length!!';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

// Mock session
jest.mock('@/lib/auth/session', () => ({
  getSession: jest.fn().mockResolvedValue({
    user: {
      id: 'test-user-id'
    }
  })
}));

// Mock ApiKeyService
jest.mock('@/lib/services/api-keys/ApiKeyService', () => ({
  ApiKeyService: {
    createApiKey: jest.fn(),
    listApiKeys: jest.fn(),
    revokeApiKey: jest.fn(),
    generateApiKey: jest.fn()
  }
}));

// Mock Supabase client
jest.mock('@/lib/database/supabase-client', () => ({
  supabase: {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { role: 'admin' },
        error: null
      })
    })
  }
}));

describe('/api/keys route', () => {
  const testUserId = 'test-user-id';
  const testSiteId = '123e4567-e89b-12d3-a456-426614174000';
  
  // Request body válido para reutilizar en los tests
  const validRequestBody = {
    name: 'Test API Key',
    scopes: ['read', 'write'],
    site_id: testSiteId,
    expirationDays: 90
  };
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/keys', () => {
    it('should create a new API key with proper encryption', async () => {
      // Mock API key creation
      const mockApiKey = 'test_abcdef123456';
      const mockResponse = {
        apiKey: mockApiKey,
        id: 'new-key-id',
        prefix: 'test',
        expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
      };
      
      (ApiKeyService.createApiKey as jest.Mock).mockResolvedValue(mockResponse);
      (ApiKeyService.generateApiKey as jest.Mock).mockReturnValue(mockApiKey);

      // Create request
      const request = new NextRequest('http://localhost:3000/api/keys', {
        method: 'POST',
        body: JSON.stringify(validRequestBody)
      });

      // Execute request
      const response = await POST(request);
      const responseData = await response.json();

      // Verify response
      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.data).toHaveProperty('apiKey');
      expect(responseData.data.apiKey).toBe(mockApiKey);

      // Verify service calls
      expect(ApiKeyService.createApiKey).toHaveBeenCalledWith(
        testUserId,
        validRequestBody
      );
    });

    it('should validate request parameters', async () => {
      const invalidBody = {
        name: '', // nombre vacío
        scopes: [], // scopes vacío
        site_id: 'invalid-uuid'
      };

      const request = new NextRequest('http://localhost:3000/api/keys', {
        method: 'POST',
        body: JSON.stringify(invalidBody)
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('GET /api/keys', () => {
    it('should list API keys with decrypted prefixes', async () => {
      // Mock API keys list
      const mockApiKeys = [
        {
          id: 'key-1',
          name: 'Test Key 1',
          prefix: 'test',
          status: 'active',
          expires_at: new Date(Date.now() + 86400000).toISOString()
        },
        {
          id: 'key-2',
          name: 'Test Key 2',
          prefix: 'prod',
          status: 'expired',
          expires_at: new Date(Date.now() - 86400000).toISOString()
        }
      ];

      (ApiKeyService.listApiKeys as jest.Mock).mockResolvedValue(mockApiKeys);

      const request = new NextRequest(`http://localhost:3000/api/keys?site_id=${testSiteId}`);
      const response = await GET(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.data).toHaveLength(2);
      expect(responseData.data[0]).toHaveProperty('prefix', 'test');
      expect(responseData.data[0]).not.toHaveProperty('key_hash');

      // Verify service calls
      expect(ApiKeyService.listApiKeys).toHaveBeenCalledWith(testUserId, testSiteId);
    });

    it('should require site_id parameter', async () => {
      const request = new NextRequest('http://localhost:3000/api/keys');
      const response = await GET(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('DELETE /api/keys', () => {
    it('should revoke API key and invalidate hash', async () => {
      const keyId = 'test-key-id';
      (ApiKeyService.revokeApiKey as jest.Mock).mockResolvedValue(true);

      const request = new NextRequest(
        `http://localhost:3000/api/keys?id=${keyId}&site_id=${testSiteId}`
      );

      const response = await DELETE(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('API key revoked successfully');

      // Verify service calls
      expect(ApiKeyService.revokeApiKey).toHaveBeenCalledWith(testUserId, keyId, testSiteId);
    });

    it('should require key_id parameter', async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/keys?site_id=${testSiteId}`
      );

      const response = await DELETE(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('Error handling', () => {
    it('should handle service errors gracefully', async () => {
      (ApiKeyService.createApiKey as jest.Mock).mockRejectedValue(
        new Error('Service error')
      );

      const request = new NextRequest('http://localhost:3000/api/keys', {
        method: 'POST',
        body: JSON.stringify(validRequestBody)
      });

      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('SYSTEM_ERROR');
    });

    it('should handle missing authentication', async () => {
      require('@/lib/auth/session').getSession.mockResolvedValueOnce(null);

      const request = new NextRequest('http://localhost:3000/api/keys');
      const response = await GET(request);
      const responseData = await response.json();

      expect(response.status).toBe(401);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('UNAUTHORIZED');
    });
  });
}); 