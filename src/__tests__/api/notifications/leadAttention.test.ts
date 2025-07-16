import { POST } from '@/app/api/notifications/leadAttention/route';
import { NextRequest } from 'next/server';

// Mock Supabase client
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
    auth: {
      admin: {
        getUserById: jest.fn(),
      },
    },
  },
}));

// Mock SendGrid service
jest.mock('@/lib/services/sendgrid-service', () => ({
  sendGridService: {
    sendEmail: jest.fn(),
  },
}));

// Import the mocked modules
const { supabaseAdmin } = require('@/lib/database/supabase-client');
const { sendGridService } = require('@/lib/services/sendgrid-service');

// Mock environment variables
process.env.NEXT_PUBLIC_APP_URL = 'https://app.uncodie.com';
process.env.UNCODIE_BRANDING_TEXT = 'Uncodie, your AI Sales Team';
process.env.UNCODIE_COMPANY_NAME = 'Uncodie';

describe('/api/notifications/leadAttention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validRequestBody = {
    site_id: '550e8400-e29b-41d4-a716-446655440000',
    names: ['John Doe', 'Jane Smith'],
    channel: 'email' as const,
    priority: 'normal' as const,
    user_message: 'Hello, I need help',
    system_message: 'System alert',
    contact_info: {
      email: 'test@example.com',
      phone: '+1234567890'
    }
  };

  const mockLeadData = [
    {
      id: '660e8400-e29b-41d4-a716-446655440000',
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'John Doe',
      email: 'john@example.com',
      assignee_id: '770e8400-e29b-41d4-a716-446655440000'
    },
    {
      id: '661e8400-e29b-41d4-a716-446655440000',
      site_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Jane Smith',
      email: 'jane@example.com',
      assignee_id: '771e8400-e29b-41d4-a716-446655440000'
    }
  ];

  const mockSiteData = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Test Site',
    url: 'https://example.com',
    logo_url: 'https://example.com/logo.png'
  };

  const mockSiteEmailConfig = {
    channels: {
      email: {
        email: 'support@example.com',
        aliases: ['contact@example.com']
      },
      whatsapp: {
        phone_number: '+1234567890'
      },
      chat: {
        enabled: true
      }
    }
  };

  const mockSiteEmailConfigNoChannels = {
    // No channels property
  };

  const mockSiteEmailConfigEmptyChannels = {
    channels: {
      // Empty channels object
    }
  };

  function setupMockDatabase(leadData: any[] = mockLeadData) {
    const mockChain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      single: jest.fn()
    };

    // Reset all mocks
    supabaseAdmin.from.mockReset();
    supabaseAdmin.auth.admin.getUserById.mockReset();
    
    // Mock leads query (first call)
    supabaseAdmin.from.mockReturnValueOnce({
      ...mockChain,
      not: jest.fn().mockResolvedValue({ data: leadData, error: null })
    });

    // Mock site query (second call)
    supabaseAdmin.from.mockReturnValueOnce({
      ...mockChain,
      single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
    });

    // Mock settings query (third call)
    supabaseAdmin.from.mockReturnValueOnce({
      ...mockChain,
      single: jest.fn().mockResolvedValue({ data: mockSiteEmailConfig, error: null })
    });

    // Mock individual lead detail queries
    leadData.forEach((lead) => {
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: lead, error: null })
      });
    });
  }

  function setupMockTeamMembers(teamMembers: any[]) {
    teamMembers.forEach((member, index) => {
      supabaseAdmin.auth.admin.getUserById.mockResolvedValueOnce({
        data: {
          user: {
            id: member.id,
            email: member.email,
            user_metadata: {
              name: member.name,
              role: member.role || 'team_member'
            }
          }
        },
        error: null
      });
    });
  }

  describe('Validation', () => {
    it('should reject invalid site_id', async () => {
      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify({
          ...validRequestBody,
          site_id: 'invalid-uuid'
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject empty names array', async () => {
      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify({
          ...validRequestBody,
          names: []
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject missing site_id', async () => {
      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify({
          names: ['John Doe'],
          channel: 'email'
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Lead Processing', () => {
    it('should handle no leads found', async () => {
      setupMockDatabase([]);

      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify(validRequestBody),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('LEADS_NOT_FOUND');
    });

    it('should process multiple leads successfully', async () => {
      setupMockDatabase(mockLeadData);
      setupMockTeamMembers([
        { id: '770e8400-e29b-41d4-a716-446655440000', email: 'team1@example.com', name: 'Team Member 1' },
        { id: '771e8400-e29b-41d4-a716-446655440000', email: 'team2@example.com', name: 'Team Member 2' }
      ]);

      sendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify(validRequestBody),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.site_id).toBe(validRequestBody.site_id);
      expect(data.data.names).toEqual(validRequestBody.names);
      expect(sendGridService.sendEmail).toHaveBeenCalledTimes(2);
      expect(data.data.channels_configuration.has_channels).toBe(true);
      expect(data.data.channels_configuration.configured_channels).toContain('email');
    });

    it('should skip leads with no assignee', async () => {
      const leadsWithoutAssignee = [
        {
          ...mockLeadData[0],
          assignee_id: null
        },
        {
          ...mockLeadData[1],
          assignee_id: '771e8400-e29b-41d4-a716-446655440000'
        }
      ];

      setupMockDatabase(leadsWithoutAssignee);
      setupMockTeamMembers([
        { id: '771e8400-e29b-41d4-a716-446655440000', email: 'team2@example.com', name: 'Team Member 2' }
      ]);

      sendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify(validRequestBody),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Should only send one email (for the lead with assignee)
      expect(sendGridService.sendEmail).toHaveBeenCalledTimes(1);
      expect(data.data.channels_configuration.has_channels).toBe(true);
    });
  });

  describe('Channels Configuration', () => {
    it('should warn when site has no channels configured', async () => {
      const mockChain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        single: jest.fn()
      };

      // Mock leads query
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        not: jest.fn().mockResolvedValue({ data: [mockLeadData[0]], error: null })
      });

      // Mock site query
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
      });

      // Mock settings query for channels verification (no channels)
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockSiteEmailConfigNoChannels, error: null })
      });

      // Mock settings query for email config
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockSiteEmailConfig, error: null })
      });

      // Mock lead detail query
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockLeadData[0], error: null })
      });

      setupMockTeamMembers([
        { id: '770e8400-e29b-41d4-a716-446655440000', email: 'team@example.com', name: 'Team Member' }
      ]);

      sendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify({
          ...validRequestBody,
          names: [mockLeadData[0].name]
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.channels_configuration.has_channels).toBe(false);
      expect(data.data.channels_configuration.warning).toContain('prospecting will be seriously affected');
    });

    it('should warn when site has empty channels configuration', async () => {
      const mockChain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        single: jest.fn()
      };

      // Mock leads query
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        not: jest.fn().mockResolvedValue({ data: [mockLeadData[0]], error: null })
      });

      // Mock site query
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockSiteData, error: null })
      });

      // Mock settings query for channels verification (empty channels)
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockSiteEmailConfigEmptyChannels, error: null })
      });

      // Mock settings query for email config
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockSiteEmailConfig, error: null })
      });

      // Mock lead detail query
      supabaseAdmin.from.mockReturnValueOnce({
        ...mockChain,
        single: jest.fn().mockResolvedValue({ data: mockLeadData[0], error: null })
      });

      setupMockTeamMembers([
        { id: '770e8400-e29b-41d4-a716-446655440000', email: 'team@example.com', name: 'Team Member' }
      ]);

      sendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify({
          ...validRequestBody,
          names: [mockLeadData[0].name]
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.channels_configuration.has_channels).toBe(false);
      expect(data.data.channels_configuration.warning).toContain('no functional channels configured');
    });

    it('should detect properly configured channels', async () => {
      setupMockDatabase([mockLeadData[0]]);
      setupMockTeamMembers([
        { id: '770e8400-e29b-41d4-a716-446655440000', email: 'team@example.com', name: 'Team Member' }
      ]);

      sendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify({
          ...validRequestBody,
          names: [mockLeadData[0].name]
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.channels_configuration.has_channels).toBe(true);
      expect(data.data.channels_configuration.configured_channels).toEqual(
        expect.arrayContaining(['email', 'whatsapp', 'chat'])
      );
      expect(data.data.channels_configuration.warning).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      const mockChain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        not: jest.fn().mockResolvedValue({ data: null, error: { message: 'Database error' } })
      };

      supabaseAdmin.from.mockReturnValue(mockChain);

      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: JSON.stringify(validRequestBody),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('LEADS_NOT_FOUND');
    });

    it('should handle malformed JSON', async () => {
      const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
        method: 'POST',
        body: 'invalid json',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('SYSTEM_ERROR');
    });
  });

  describe('Email Content', () => {
    it('should include all priority levels in email content', async () => {
      const priorities = ['low', 'normal', 'high', 'urgent'] as const;
      
      for (const priority of priorities) {
        jest.clearAllMocks();
        
        setupMockDatabase([mockLeadData[0]]);
        setupMockTeamMembers([
          { id: '770e8400-e29b-41d4-a716-446655440000', email: 'team@example.com', name: 'Team Member' }
        ]);

        sendGridService.sendEmail.mockResolvedValue({
          success: true,
          messageId: 'test-message-id'
        });

        const request = new NextRequest('http://localhost:3000/api/notifications/leadAttention', {
          method: 'POST',
          body: JSON.stringify({
            ...validRequestBody,
            priority
          }),
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);

        const emailCall = sendGridService.sendEmail.mock.calls[0][0];
        expect(emailCall.html).toContain(priority.toUpperCase());
      }
    });
  });
}); 