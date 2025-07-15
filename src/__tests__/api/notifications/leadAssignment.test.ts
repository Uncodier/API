import { NextRequest } from 'next/server';
import { POST } from '@/app/api/notifications/leadAssignment/route';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';

// Mock de las dependencias
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn()
  }
}));

jest.mock('@/lib/services/sendgrid-service', () => ({
  sendGridService: {
    sendEmail: jest.fn()
  }
}));

jest.mock('@/lib/services/team-notification-service', () => ({
  TeamNotificationService: {
    notifyTeam: jest.fn()
  }
}));

const mockSupabaseAdmin = supabaseAdmin as jest.Mocked<typeof supabaseAdmin>;
const mockSendGridService = sendGridService as jest.Mocked<typeof sendGridService>;
const mockTeamNotificationService = TeamNotificationService as jest.Mocked<typeof TeamNotificationService>;

describe('/api/notifications/leadAssignment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockLeadData = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'John Doe',
    email: 'john.doe@example.com',
    phone: '+1234567890',
    position: 'CEO',
    status: 'new',
    notes: 'High-value prospect',
    origin: 'website',
    site_id: '550e8400-e29b-41d4-a716-446655440001',
    assignee_id: null,
    company: { name: 'Example Corp' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_contact: null
  };

  const mockAssigneeData = {
    id: '550e8400-e29b-41d4-a716-446655440002',
    email: 'sales@example.com',
    name: 'Jane Smith',
    raw_user_meta_data: {}
  };

  const mockSiteData = {
    id: '550e8400-e29b-41d4-a716-446655440001',
    name: 'Example Site',
    url: 'https://example.com',
    logo_url: 'https://example.com/logo.png',
    user_id: '550e8400-e29b-41d4-a716-446655440003'
  };

  const mockSiteSettings = {
    channels: {
      email: {
        email: 'team@example.com',
        aliases: ['sales@example.com', 'support@example.com']
      }
    }
  };

  const validRequestBody = {
    lead_id: '550e8400-e29b-41d4-a716-446655440000',
    assignee_id: '550e8400-e29b-41d4-a716-446655440002',
    brief: 'This is a high-value prospect from our website. They showed interest in our enterprise solution.',
    next_steps: [
      'Call within 24 hours to introduce yourself',
      'Send product demo materials',
      'Schedule a product demo for next week',
      'Follow up on their specific requirements'
    ],
    priority: 'high',
    due_date: '2024-12-31T23:59:59Z',
    additional_context: 'They mentioned they have a budget of $50k and need a solution by Q1 2025.',
    include_team_notification: true,
    metadata: {
      source: 'website_form',
      campaign: 'enterprise_trial'
    }
  };

  function createMockRequest(body: any): NextRequest {
    return {
      json: async () => body,
      headers: new Headers(),
      method: 'POST',
      url: 'http://localhost:3000/api/notifications/leadAssignment'
    } as NextRequest;
  }

  function setupMockQueries() {
    // Mock para getLeadInfo
    mockSupabaseAdmin.from.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: mockLeadData,
        error: null
      })
    } as any);

    // Mock para getAssigneeInfo
    mockSupabaseAdmin.from.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: mockAssigneeData,
        error: null
      })
    } as any);

    // Mock para getSiteInfo
    mockSupabaseAdmin.from.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: mockSiteData,
        error: null
      })
    } as any);

    // Mock para getSiteEmailConfig
    mockSupabaseAdmin.from.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: mockSiteSettings,
        error: null
      })
    } as any);

    // Mock para updateLeadAssignee
    mockSupabaseAdmin.from.mockReturnValueOnce({
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        error: null
      })
    } as any);
  }

  describe('POST', () => {
    it('should successfully assign a lead and send notifications', async () => {
      setupMockQueries();

      // Mock SendGrid response
      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      // Mock team notification response
      mockTeamNotificationService.notifyTeam.mockResolvedValue({
        success: true,
        notificationsSent: 2,
        emailsSent: 1,
        totalMembers: 3,
        membersWithEmailEnabled: 2,
        errors: []
      });

      const request = createMockRequest(validRequestBody);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.data.lead_id).toBe(validRequestBody.lead_id);
      expect(responseData.data.assignee_id).toBe(validRequestBody.assignee_id);
      expect(responseData.data.assignment_updated).toBe(true);
      expect(responseData.data.emails_sent.assignee).toBe(1);
      expect(responseData.data.emails_sent.team).toBe(1);
      expect(responseData.data.notifications_sent.team).toBe(2);

      // Verify SendGrid was called
      expect(mockSendGridService.sendEmail).toHaveBeenCalledWith({
        to: mockAssigneeData.email,
        subject: expect.stringContaining('New Lead Assignment'),
        html: expect.stringContaining(mockLeadData.name),
        categories: ['lead-assignment', 'assignee-notification', 'transactional'],
        customArgs: expect.objectContaining({
          siteId: mockLeadData.site_id,
          leadId: validRequestBody.lead_id,
          assigneeId: validRequestBody.assignee_id,
          notificationType: 'lead_assignment',
          priority: validRequestBody.priority
        })
      });

      // Verify team notification was called
      expect(mockTeamNotificationService.notifyTeam).toHaveBeenCalledWith({
        siteId: mockLeadData.site_id,
        title: expect.stringContaining('Lead Assignment'),
        message: expect.stringContaining(mockLeadData.name),
        htmlContent: expect.stringContaining(mockLeadData.name),
        priority: validRequestBody.priority,
        type: expect.any(String),
        categories: ['lead-assignment', 'team-notification'],
        customArgs: expect.objectContaining({
          leadId: validRequestBody.lead_id,
          assigneeId: validRequestBody.assignee_id,
          notificationType: 'lead_assignment'
        }),
        relatedEntityType: 'lead',
        relatedEntityId: validRequestBody.lead_id
      });
    });

    it('should work without team notification when include_team_notification is false', async () => {
      setupMockQueries();

      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const requestBody = {
        ...validRequestBody,
        include_team_notification: false
      };

      const request = createMockRequest(requestBody);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.data.emails_sent.assignee).toBe(1);
      expect(responseData.data.emails_sent.team).toBe(0);
      expect(responseData.data.notifications_sent.team).toBe(0);

      // Verify team notification was NOT called
      expect(mockTeamNotificationService.notifyTeam).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid request data', async () => {
      const invalidRequestBody = {
        lead_id: 'invalid-uuid',
        assignee_id: '550e8400-e29b-41d4-a716-446655440002',
        brief: '',
        next_steps: [],
        priority: 'invalid-priority'
      };

      const request = createMockRequest(invalidRequestBody);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('VALIDATION_ERROR');
      expect(responseData.error.details).toBeDefined();
    });

    it('should return 404 when lead is not found', async () => {
      // Mock para getLeadInfo - lead not found
      mockSupabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'Lead not found' }
        })
      } as any);

      const request = createMockRequest(validRequestBody);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(404);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('LEAD_NOT_FOUND');
    });

    it('should return 404 when assignee is not found', async () => {
      // Mock para getLeadInfo - success
      mockSupabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: mockLeadData,
          error: null
        })
      } as any);

      // Mock para getAssigneeInfo - not found
      mockSupabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'Assignee not found' }
        })
      } as any);

      const request = createMockRequest(validRequestBody);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(404);
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('ASSIGNEE_NOT_FOUND');
    });

    it('should handle partial success when assignee email fails but team notification succeeds', async () => {
      setupMockQueries();

      // Mock SendGrid failure
      mockSendGridService.sendEmail.mockResolvedValue({
        success: false,
        error: 'Email delivery failed'
      });

      // Mock team notification success
      mockTeamNotificationService.notifyTeam.mockResolvedValue({
        success: true,
        notificationsSent: 2,
        emailsSent: 1,
        totalMembers: 3,
        membersWithEmailEnabled: 2,
        errors: []
      });

      const request = createMockRequest(validRequestBody);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(207); // Multi-Status (partial success)
      expect(responseData.success).toBe(false);
      expect(responseData.data.emails_sent.assignee).toBe(0);
      expect(responseData.data.emails_sent.team).toBe(1);
      expect(responseData.data.errors).toContain('Failed to notify assignee: Email delivery failed');
    });

    it('should handle minimum required fields', async () => {
      setupMockQueries();

      mockSendGridService.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id'
      });

      const minimalRequestBody = {
        lead_id: '550e8400-e29b-41d4-a716-446655440000',
        assignee_id: '550e8400-e29b-41d4-a716-446655440002',
        brief: 'Simple brief',
        next_steps: ['Contact the lead']
      };

      const request = createMockRequest(minimalRequestBody);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.data.assignment_details.priority).toBe('normal'); // default value
      expect(responseData.data.emails_sent.assignee).toBe(1);
      expect(responseData.data.emails_sent.team).toBe(0); // default is false
    });
  });
}); 