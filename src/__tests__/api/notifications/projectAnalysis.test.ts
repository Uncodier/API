import { POST } from '@/app/api/notifications/projectAnalysis/route';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';

// Mock de las dependencias
jest.mock('@/lib/database/supabase-client');
jest.mock('@/lib/services/team-notification-service');

const mockSupabaseAdmin = supabaseAdmin as jest.Mocked<typeof supabaseAdmin>;
const mockTeamNotificationService = TeamNotificationService as jest.Mocked<typeof TeamNotificationService>;

describe('POST /api/notifications/projectAnalysis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock de variables de entorno
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.uncodie.com';
    process.env.UNCODIE_BRANDING_TEXT = 'Uncodie, your AI Sales Team';
    process.env.UNCODIE_COMPANY_NAME = 'Uncodie';
  });

  const validSiteId = '550e8400-e29b-41d4-a716-446655440000';
  const validInsights = [
    {
      type: 'finding' as const,
      title: 'Updated company industry classification',
      description: 'The AI agent identified and updated the company\'s industry classification based on the latest market trends.',
      impact: 'medium' as const,
      affected_area: 'lead_scoring',
      category: 'industry'
    },
    {
      type: 'change' as const,
      title: 'Refined target audience segments',
      description: 'The AI agent redefined the target audience segments to better align with the company\'s current market position.',
      impact: 'high' as const,
      affected_area: 'segmentation',
      category: 'targeting'
    },
    {
      type: 'recommendation' as const,
      title: 'Review updated ICP profiles',
      description: 'Please review and validate the updated Ideal Customer Profile segments.',
      impact: 'medium' as const,
      affected_area: 'targeting',
      metadata: { priority: 'high' }
    }
  ];

  const mockSiteInfo = {
    id: validSiteId,
    name: 'Test Site',
    logo_url: 'https://example.com/logo.png',
    created_at: '2024-01-01T00:00:00Z'
  };

  it('should process project analysis notification successfully', async () => {
    // Mock supabase response
    mockSupabaseAdmin.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: mockSiteInfo,
            error: null
          })
        })
      })
    } as any);

         // Mock team notification service
     mockTeamNotificationService.notifyTeam.mockResolvedValue({
       success: true,
       notificationsSent: 3,
       emailsSent: 2,
       totalMembers: 3,
       membersWithEmailEnabled: 2,
       errors: []
     });

    const requestBody = {
      site_id: validSiteId,
      insights: validInsights,
      analysis_type: 'profile_update',
      analysis_summary: 'AI agents have analyzed your site and updated key profile information.',
      impact_level: 'medium'
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.data.site_id).toBe(validSiteId);
    expect(result.data.emails_sent).toBe(2);
    expect(result.data.notifications_sent).toBe(3);
    expect(result.data.key_findings_count).toBe(1);
    expect(result.data.affected_areas_count).toBe(2); // lead_scoring y segmentation/targeting
    expect(result.data.recommendations_count).toBe(1);

    // Verificar que se llamó a TeamNotificationService con los parámetros correctos
    expect(mockTeamNotificationService.notifyTeam).toHaveBeenCalledWith({
      siteId: validSiteId,
      title: 'Site Analysis Complete: Test Site',
      message: 'AI agents have analyzed your site and updated key profile information that may affect prospecting.',
      htmlContent: expect.any(String),
      priority: 'normal',
      type: 'info',
      categories: ['analysis-notification', 'site-analysis', 'profile-update'],
      customArgs: {
        siteId: validSiteId,
        analysisType: 'profile_update',
        generatedAt: expect.any(String)
      },
      relatedEntityType: 'site',
      relatedEntityId: validSiteId
    });
  });

     it('should handle minimal request with default insights', async () => {
     // Mock supabase response
     mockSupabaseAdmin.from.mockReturnValue({
       select: jest.fn().mockReturnValue({
         eq: jest.fn().mockReturnValue({
           single: jest.fn().mockResolvedValue({
             data: mockSiteInfo,
             error: null
           })
         })
       })
     } as any);

     // Mock team notification service
     mockTeamNotificationService.notifyTeam.mockResolvedValue({
       success: true,
       notificationsSent: 1,
       emailsSent: 1,
       totalMembers: 1,
       membersWithEmailEnabled: 1,
       errors: []
     });

    const requestBody = {
      site_id: validSiteId,
      insights: [{
        type: 'finding' as const,
        title: 'Basic finding',
        description: 'A basic finding description'
      }]
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.data.analysis_summary).toBe('AI agents have analyzed your site and updated key profile information that may affect prospecting.');
  });

  it('should return 400 for invalid site_id', async () => {
    const requestBody = {
      site_id: 'invalid-uuid',
      insights: validInsights
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.details).toContainEqual(
      expect.objectContaining({
        message: 'site_id debe ser un UUID válido'
      })
    );
  });

  it('should return 400 for empty insights array', async () => {
    const requestBody = {
      site_id: validSiteId,
      insights: []
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.details).toContainEqual(
      expect.objectContaining({
        message: 'Al menos un insight es requerido'
      })
    );
  });

  it('should return 400 for invalid insight type', async () => {
    const requestBody = {
      site_id: validSiteId,
      insights: [{
        type: 'invalid_type',
        title: 'Test insight',
        description: 'Test description'
      }]
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent site', async () => {
    // Mock supabase response for non-existent site
    mockSupabaseAdmin.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: null,
            error: { message: 'Site not found' }
          })
        })
      })
    } as any);

    const requestBody = {
      site_id: validSiteId,
      insights: validInsights
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(404);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('SITE_NOT_FOUND');
  });

  it('should return 207 when team notification partially fails', async () => {
    // Mock supabase response
    mockSupabaseAdmin.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: mockSiteInfo,
            error: null
          })
        })
      })
    } as any);

         // Mock team notification service with partial failure
     mockTeamNotificationService.notifyTeam.mockResolvedValue({
       success: false,
       notificationsSent: 1,
       emailsSent: 0,
       totalMembers: 2,
       membersWithEmailEnabled: 1,
       errors: ['Failed to send email to some recipients']
     });

    const requestBody = {
      site_id: validSiteId,
      insights: validInsights
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(207);
    expect(result.success).toBe(false);
    expect(result.data.errors).toContain('Failed to notify team: Failed to send email to some recipients');
  });

  it('should handle system errors gracefully', async () => {
    // Mock supabase to throw an error
    mockSupabaseAdmin.from.mockImplementation(() => {
      throw new Error('Database connection failed');
    });

    const requestBody = {
      site_id: validSiteId,
      insights: validInsights
    };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('SYSTEM_ERROR');
  });

  it('should validate impact levels correctly', async () => {
    // Mock supabase response
    mockSupabaseAdmin.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: mockSiteInfo,
            error: null
          })
        })
      })
    } as any);

         // Mock team notification service
     mockTeamNotificationService.notifyTeam.mockResolvedValue({
       success: true,
       notificationsSent: 1,
       emailsSent: 1,
       totalMembers: 1,
       membersWithEmailEnabled: 1,
       errors: []
     });

     const requestBody = {
       site_id: validSiteId,
       insights: validInsights,
       impact_level: 'critical'
     };

    const request = new NextRequest('http://localhost:3000/api/notifications/projectAnalysis', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    
    // Verificar que se llamó con impact_level correcto
    const calledArgs = mockTeamNotificationService.notifyTeam.mock.calls[0][0];
    expect(calledArgs.htmlContent).toContain('CRITICAL Impact');
  });
}); 