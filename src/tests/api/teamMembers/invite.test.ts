import { NextRequest } from 'next/server';
import { POST, GET } from '@/app/api/teamMembers/invite/route';
import { sendGridService } from '@/lib/services/sendgrid-service';

// Mock SendGrid service
jest.mock('@/lib/services/sendgrid-service', () => ({
  sendGridService: {
    sendEmail: jest.fn()
  }
}));

// Mock validateApiKey
jest.mock('@/lib/api-keys', () => ({
  validateApiKey: jest.fn()
}));

const mockSendGridService = sendGridService as jest.Mocked<typeof sendGridService>;

describe('/api/teamMembers/invite', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    (process.env as any).NODE_ENV = originalEnv;
  });

  const createMockRequest = (body: any, headers: Record<string, string> = {}) => {
    const request = new NextRequest('http://localhost:3000/api/teamMembers/invite', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body)
    });
    return request;
  };

  describe('Authentication in Development', () => {
    beforeEach(() => {
      (process.env as any).NODE_ENV = 'development';
    });

    it('should allow requests without API key in development', async () => {
      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [{
          email: 'test@example.com',
          name: 'Test User',
          role: 'view',
          position: 'Developer'
        }]
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should work without any authentication headers in development', async () => {
      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [{
          email: 'test@example.com',
          name: 'Test User',
          role: 'admin',
          position: 'Manager'
        }]
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });
  });

  describe('Authentication in Production', () => {
    beforeEach(() => {
      (process.env as any).NODE_ENV = 'production';
    });

    it('should reject requests without API key in production', async () => {
      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [{
          email: 'test@example.com',
          name: 'Test User',
          role: 'view',
          position: 'Developer'
        }]
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.message).toContain('authentication headers');
    });

    it('should reject requests with invalid API credentials in production', async () => {
      const { validateApiKey } = require('@/lib/api-keys');
      validateApiKey.mockReturnValue(false);

      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [{
          email: 'test@example.com',
          name: 'Test User',
          role: 'view',
          position: 'Developer'
        }]
      }, {
        'x-api-key': 'invalid-key',
        'x-api-secret': 'invalid-secret'
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
    });

    it('should accept requests with valid API credentials in production', async () => {
      const { validateApiKey } = require('@/lib/api-keys');
      validateApiKey.mockReturnValue(true);

      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [{
          email: 'test@example.com',
          name: 'Test User',
          role: 'view',
          position: 'Developer'
        }]
      }, {
        'x-api-key': 'valid-key',
        'x-api-secret': 'valid-secret'
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(validateApiKey).toHaveBeenCalledWith('valid-key', 'valid-secret');
    });
  });

  describe('Request validation', () => {
    beforeEach(() => {
      (process.env as any).NODE_ENV = 'development'; // Skip auth for validation tests
    });

    it('should reject requests without siteName', async () => {
      const request = createMockRequest({
        teamMembers: [
          {
            email: 'test@example.com',
            name: 'Test User',
            role: 'view',
            position: 'Developer'
          }
        ]
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toContain('siteName is required');
    });

    it('should reject requests without teamMembers', async () => {
      const request = createMockRequest({
        siteName: 'test-site'
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toContain('teamMembers must be an array');
    });

    it('should reject requests with empty teamMembers array', async () => {
      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: []
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toContain('At least one team member is required');
    });

    it('should reject invalid email format', async () => {
      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [
          {
            email: 'invalid-email',
            name: 'Test User',
            role: 'view',
            position: 'Developer'
          }
        ]
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toContain('Validation errors');
      expect(data.errors).toContain('Member 1: invalid email format');
    });

    it('should reject invalid roles', async () => {
      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [
          {
            email: 'test@example.com',
            name: 'Test User',
            role: 'invalid-role',
            position: 'Developer'
          }
        ]
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toContain('Validation errors');
      expect(data.errors?.[0]).toContain('role must be one of: view, create, delete, admin');
    });

    it('should reject missing required fields', async () => {
      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [
          {
            email: 'test@example.com',
            // missing name, role, position
          }
        ]
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toContain('Validation errors');
      expect(data.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('name is required'),
          expect.stringContaining('role must be one of'),
          expect.stringContaining('position is required')
        ])
      );
    });

    it('should reject wrong content type', async () => {
      const request = createMockRequest(
        { siteName: 'test-site', teamMembers: [] },
        { 'content-type': 'text/plain' }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toContain('Content-Type');
    });
  });

  describe('Email sending', () => {
    beforeEach(() => {
      (process.env as any).NODE_ENV = 'development'; // Skip auth for email tests
    });

    const validRequestBody = {
      siteName: 'Test Project',
      teamMembers: [
        {
          email: 'john@example.com',
          name: 'John Doe',
          role: 'create' as const,
          position: 'Developer'
        },
        {
          email: 'jane@example.com',
          name: 'Jane Smith',
          role: 'admin' as const,
          position: 'Manager'
        }
      ]
    };

    it('should send invitations successfully', async () => {
      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = createMockRequest(validRequestBody);
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBe('All invitations sent successfully');
      expect(data.data.totalMembers).toBe(2);
      expect(data.data.successfulInvites).toBe(2);
      expect(data.data.failedInvites).toBe(0);

      // Verify SendGrid was called for each member
      expect(mockSendGridService.sendEmail).toHaveBeenCalledTimes(2);
      
      // Verify the first call
      expect(mockSendGridService.sendEmail).toHaveBeenNthCalledWith(1, {
        to: 'john@example.com',
        subject: 'You\'re invited to join Test Project on Uncodie',
        html: expect.stringContaining('John Doe'),
        categories: ['team-invitation', 'transactional'],
        customArgs: {
          siteId: 'Test Project',
          memberRole: 'create',
          invitationType: 'team-member'
        }
      });
    });

    it('should handle partial failures', async () => {
      mockSendGridService.sendEmail
        .mockResolvedValueOnce({
          success: true,
          messageId: 'test-message-id-1'
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'SendGrid API error'
        });

      const request = createMockRequest(validRequestBody);
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(207); // Multi-status
      expect(data.success).toBe(false);
      expect(data.message).toContain('1 invitations sent successfully, 1 failed');
      expect(data.data.successfulInvites).toBe(1);
      expect(data.data.failedInvites).toBe(1);
      expect(data.data.results).toHaveLength(2);
      expect(data.data.results[0].success).toBe(true);
      expect(data.data.results[1].success).toBe(false);
    });

    it('should handle complete failure', async () => {
      mockSendGridService.sendEmail.mockResolvedValue({
        success: false,
        error: 'SendGrid API error'
      });

      const request = createMockRequest(validRequestBody);
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.message).toBe('All invitations failed');
      expect(data.data.successfulInvites).toBe(0);
      expect(data.data.failedInvites).toBe(2);
    });

    it('should handle SendGrid exceptions', async () => {
      mockSendGridService.sendEmail.mockRejectedValue(new Error('Network error'));

      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [validRequestBody.teamMembers[0]]
      });
      
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.data.results[0].error).toBe('Network error');
    });
  });

  describe('Email content validation', () => {
    beforeEach(() => {
      (process.env as any).NODE_ENV = 'development';
    });

    it('should generate correct email content for different roles', async () => {
      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = createMockRequest({
        siteName: 'my-awesome-site',
        teamMembers: [
          {
            email: 'admin@example.com',
            name: 'Admin User',
            role: 'admin' as const,
            position: 'Chief Technology Officer'
          }
        ]
      });

      await POST(request);

      const emailCall = mockSendGridService.sendEmail.mock.calls[0][0];
      expect(emailCall.html).toContain('Admin User');
      expect(emailCall.html).toContain('my-awesome-site');
      expect(emailCall.html).toContain('Chief Technology Officer');
      expect(emailCall.html).toContain('Admin (Owner privileges)');
      expect(emailCall.html).toContain('admin@example.com');
      expect(emailCall.html).toContain('/signup');
    });

    it('should use correct sign up URL', async () => {
      const originalEnv = process.env.NEXT_PUBLIC_APP_URL;
      (process.env as any).NEXT_PUBLIC_APP_URL = 'https://custom.uncodie.com';

      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = createMockRequest({
        siteName: 'test-site',
        teamMembers: [{
          email: 'test@example.com',
          name: 'Test User',
          role: 'view' as const,
          position: 'Tester'
        }]
      });

      await POST(request);

      const emailCall = mockSendGridService.sendEmail.mock.calls[0][0];
      expect(emailCall.html).toContain('https://custom.uncodie.com/signup');

      // Restore original env
      if (originalEnv) {
        (process.env as any).NEXT_PUBLIC_APP_URL = originalEnv;
      } else {
        delete (process.env as any).NEXT_PUBLIC_APP_URL;
      }
    });
  });

  describe('GET endpoint', () => {
    it('should return API information in development', async () => {
      (process.env as any).NODE_ENV = 'development';
      
      const request = new NextRequest('http://localhost:3000/api/teamMembers/invite', {
        method: 'GET'
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.message).toBe('Team Members Invite API');
      expect(data.environment).toBe('development');
      expect(data.authentication).toContain('disabled in development');
    });

    it('should return API information in production', async () => {
      (process.env as any).NODE_ENV = 'production';
      
      const request = new NextRequest('http://localhost:3000/api/teamMembers/invite', {
        method: 'GET'
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.message).toBe('Team Members Invite API');
      expect(data.environment).toBe('production');
      expect(data.authentication).toContain('required in production');
    });
  });
}); 