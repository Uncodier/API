import { POST } from '@/app/api/notifications/newLeadsAlert/route';
import { NextRequest } from 'next/server';

// Mock de dependencias
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
    auth: {
      admin: {
        getUserById: jest.fn(),
        listUsers: jest.fn()
      }
    }
  }
}));

jest.mock('@/lib/services/team-notification-service', () => ({
  TeamNotificationService: {
    notifyTeam: jest.fn(),
    getTeamMembersWithEmailNotifications: jest.fn()
  }
}));

// Importar mocks después de la declaración
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService } from '@/lib/services/team-notification-service';

const mockSupabaseAdmin = supabaseAdmin as jest.Mocked<typeof supabaseAdmin>;
const mockTeamNotificationService = TeamNotificationService as jest.Mocked<typeof TeamNotificationService>;

// Datos de prueba
const validSiteId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const mockSiteInfo = {
  id: validSiteId,
  name: 'Test Site',
  url: 'https://testsite.com',
  logo_url: 'https://testsite.com/logo.png'
};

const mockUnassignedLeads = [
  {
    id: 'lead1-uuid',
    name: 'Juan Pérez',
    email: 'juan@empresa.com',
    phone: '+1234567890',
    company: { name: 'Empresa Test' },
    status: 'new',
    origin: 'website',
    created_at: '2024-12-20T10:00:00Z',
    segments: { id: 'segment1', name: 'Enterprise', description: 'Enterprise leads' }
  },
  {
    id: 'lead2-uuid',
    name: 'María García',
    email: 'maria@startup.com',
    phone: null,
    company: { name: 'Startup Inc' },
    status: 'new',
    origin: 'landing_page',
    created_at: '2024-12-20T09:30:00Z',
    segments: { id: 'segment2', name: 'SMB', description: 'Small business leads' }
  }
];

const mockTeamNotificationResult = {
  success: true,
  notificationsSent: 2,
  emailsSent: 2,
  totalMembers: 2,
  membersWithEmailEnabled: 2,
  errors: []
};

// Helper para crear request
function createRequest(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/notifications/newLeadsAlert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

describe('POST /api/notifications/newLeadsAlert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default successful mocks
    mockSupabaseAdmin.from = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ 
            data: mockSiteInfo, 
            error: null 
          }),
          is: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({
                data: mockUnassignedLeads,
                error: null
              })
            })
          })
        })
      })
    });

    mockTeamNotificationService.notifyTeam.mockResolvedValue(mockTeamNotificationResult);
  });

  describe('Validación de entrada', () => {
    test('debe rechazar request sin site_id', async () => {
      const request = createRequest({});
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['site_id'],
            code: 'invalid_string'
          })
        ])
      );
    });

    test('debe rechazar site_id inválido', async () => {
      const request = createRequest({
        site_id: 'invalid-uuid'
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    test('debe rechazar priority inválida', async () => {
      const request = createRequest({
        site_id: validSiteId,
        priority: 'invalid_priority'
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    test('debe rechazar hours_until_auto_prospect fuera de rango', async () => {
      const request = createRequest({
        site_id: validSiteId,
        hours_until_auto_prospect: 0 // Menor al mínimo (1)
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    test('debe rechazar max_leads_to_display fuera de rango', async () => {
      const request = createRequest({
        site_id: validSiteId,
        max_leads_to_display: 100 // Mayor al máximo (50)
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    test('debe aceptar parámetros válidos con valores por defecto', async () => {
      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('Manejo de errores de base de datos', () => {
    test('debe manejar site no encontrado', async () => {
      mockSupabaseAdmin.from = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ 
              data: null, 
              error: { message: 'Site not found' }
            })
          })
        })
      });

      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('SITE_NOT_FOUND');
    });

    test('debe manejar error al obtener leads', async () => {
      // Site mock exitoso
      mockSupabaseAdmin.from = jest.fn()
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ 
                data: mockSiteInfo, 
                error: null 
              })
            })
          })
        })
        // Leads mock con error
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: null,
                    error: { message: 'Database error' }
                  })
                })
              })
            })
          })
        });

      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      // Debe retornar success con 0 leads (manejo graceful del error)
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.total_unassigned_leads).toBe(0);
      expect(data.data.notification_sent).toBe(false);
    });
  });

  describe('Lógica de leads sin asignar', () => {
    test('debe retornar success sin notificación cuando no hay leads sin asignar', async () => {
      // Mock sin leads
      mockSupabaseAdmin.from = jest.fn()
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ 
                data: mockSiteInfo, 
                error: null 
              })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: [], // Sin leads
                    error: null
                  })
                })
              })
            })
          })
        });

      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.total_unassigned_leads).toBe(0);
      expect(data.data.notification_sent).toBe(false);
      expect(data.data.message).toBe('No unassigned leads found');
      
      // No debe intentar enviar notificación
      expect(mockTeamNotificationService.notifyTeam).not.toHaveBeenCalled();
    });

    test('debe enviar notificación cuando hay leads sin asignar', async () => {
      const request = createRequest({
        site_id: validSiteId,
        priority: 'high',
        hours_until_auto_prospect: 24,
        include_lead_details: true,
        max_leads_to_display: 10
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.total_unassigned_leads).toBe(2);
      expect(data.data.hours_until_auto_prospect).toBe(24);
      expect(data.data.notification_sent).toBe(true);
      expect(data.data.notifications_sent).toBe(2);
      expect(data.data.emails_sent).toBe(2);

      // Debe incluir preview de leads cuando include_lead_details es true
      expect(data.data.leads_preview).toBeDefined();
      expect(data.data.leads_preview).toHaveLength(2);
      expect(data.data.leads_preview[0]).toEqual({
        id: 'lead1-uuid',
        name: 'Juan Pérez',
        email: 'juan@empresa.com',
        created_at: '2024-12-20T10:00:00Z',
        origin: 'website',
        segment: 'Enterprise'
      });
    });

    test('debe limitar leads mostrados según max_leads_to_display', async () => {
      const request = createRequest({
        site_id: validSiteId,
        max_leads_to_display: 1
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.leads_preview).toHaveLength(1);
    });

    test('debe omitir leads_preview cuando include_lead_details es false', async () => {
      const request = createRequest({
        site_id: validSiteId,
        include_lead_details: false
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.leads_preview).toBeUndefined();
    });
  });

  describe('Notificación al equipo', () => {
    test('debe llamar TeamNotificationService con parámetros correctos', async () => {
      const request = createRequest({
        site_id: validSiteId,
        priority: 'urgent',
        hours_until_auto_prospect: 12
      });
      await POST(request);

      expect(mockTeamNotificationService.notifyTeam).toHaveBeenCalledWith({
        siteId: validSiteId,
        title: '🎯 2 New Leads Awaiting Assignment',
        message: 'You have 2 unassigned leads that will automatically begin AI prospecting in 12 hours if not assigned to team members.',
        htmlContent: expect.stringContaining('New Leads Alert'),
        priority: 'urgent',
        type: 'warning',
        categories: ['new-leads-alert', 'lead-assignment', 'auto-prospecting-warning'],
        customArgs: {
          siteId: validSiteId,
          totalUnassignedLeads: '2',
          hoursUntilAutoProspect: '12',
          alertType: 'new_leads_assignment_required'
        },
        relatedEntityType: 'site',
        relatedEntityId: validSiteId
      });
    });

    test('debe manejar título singular para 1 lead', async () => {
      // Mock con solo 1 lead
      mockSupabaseAdmin.from = jest.fn()
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ 
                data: mockSiteInfo, 
                error: null 
              })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: [mockUnassignedLeads[0]], // Solo 1 lead
                    error: null
                  })
                })
              })
            })
          })
        });

      const request = createRequest({
        site_id: validSiteId
      });
      await POST(request);

      expect(mockTeamNotificationService.notifyTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '🎯 1 New Lead Awaiting Assignment',
          message: expect.stringContaining('You have 1 unassigned lead that will')
        })
      );
    });

    test('debe manejar error en notificación al equipo', async () => {
      mockTeamNotificationService.notifyTeam.mockResolvedValue({
        success: false,
        notificationsSent: 0,
        emailsSent: 0,
        totalMembers: 2,
        membersWithEmailEnabled: 2,
        errors: ['Email service unavailable']
      });

      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOTIFICATION_SEND_ERROR');
      expect(data.error.message).toContain('Email service unavailable');
    });

    test('debe manejar excepción en notificación al equipo', async () => {
      mockTeamNotificationService.notifyTeam.mockRejectedValue(new Error('Network error'));

      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOTIFICATION_ERROR');
      expect(data.error.message).toContain('Network error');
    });
  });

  describe('Contenido del email HTML', () => {
    test('debe generar HTML con información completa de leads', async () => {
      const request = createRequest({
        site_id: validSiteId,
        include_lead_details: true
      });
      await POST(request);

      const call = mockTeamNotificationService.notifyTeam.mock.calls[0][0];
      const htmlContent = call.htmlContent;

      expect(htmlContent).toContain('New Leads Alert');
      expect(htmlContent).toContain('Test Site');
      expect(htmlContent).toContain('Juan Pérez');
      expect(htmlContent).toContain('juan@empresa.com');
      expect(htmlContent).toContain('María García');
      expect(htmlContent).toContain('maria@startup.com');
      expect(htmlContent).toContain('Empresa Test');
      expect(htmlContent).toContain('Enterprise');
      expect(htmlContent).toContain('SMB');
      expect(htmlContent).toContain('Auto-Prospecting starts:');
      expect(htmlContent).toContain('Assign Leads Now');
      expect(htmlContent).toContain('View All Leads');
    });

    test('debe incluir URLs correctas en el email', async () => {
      const request = createRequest({
        site_id: validSiteId
      });
      await POST(request);

      const call = mockTeamNotificationService.notifyTeam.mock.calls[0][0];
      const htmlContent = call.htmlContent;

      expect(htmlContent).toContain(`/sites/${validSiteId}/leads`);
      expect(htmlContent).toContain(`/sites/${validSiteId}/leads?action=assign`);
    });

    test('debe mostrar prioridad visual correcta según horas restantes', async () => {
      const request = createRequest({
        site_id: validSiteId,
        hours_until_auto_prospect: 12 // Menos de 24 horas = urgente
      });
      await POST(request);

      const call = mockTeamNotificationService.notifyTeam.mock.calls[0][0];
      const htmlContent = call.htmlContent;

      // Debe usar colores urgentes (rojo)
      expect(htmlContent).toContain('#fecaca'); // Color de fondo urgente
      expect(htmlContent).toContain('#dc2626'); // Color de texto urgente
    });
  });

  describe('Manejo de excepciones generales', () => {
    test('debe manejar excepciones no controladas', async () => {
      // Simular error en Supabase
      mockSupabaseAdmin.from = jest.fn().mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('SYSTEM_ERROR');
      expect(data.error.message).toBe('An internal system error occurred');
    });
  });

  describe('Casos edge', () => {
    test('debe manejar leads sin segmento', async () => {
      const leadsWithoutSegment = [{
        ...mockUnassignedLeads[0],
        segments: null
      }];

      mockSupabaseAdmin.from = jest.fn()
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ 
                data: mockSiteInfo, 
                error: null 
              })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: leadsWithoutSegment,
                    error: null
                  })
                })
              })
            })
          })
        });

      const request = createRequest({
        site_id: validSiteId
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.leads_preview[0].segment).toBeUndefined();
    });

    test('debe manejar site sin logo', async () => {
      const siteWithoutLogo = {
        ...mockSiteInfo,
        logo_url: null
      };

      mockSupabaseAdmin.from = jest.fn()
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ 
                data: siteWithoutLogo, 
                error: null 
              })
            })
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: mockUnassignedLeads,
                    error: null
                  })
                })
              })
            })
          })
        });

             const request = createRequest({
         site_id: validSiteId
       });
       const response = await POST(request);
       const data = await response.json();

       expect(response.status).toBe(200);
       expect(data.success).toBe(true);
       
       const call = mockTeamNotificationService.notifyTeam.mock.calls[0][0];
       const htmlContent = call.htmlContent;
       
       // Debe usar emoji por defecto en lugar de logo
       expect(htmlContent).toContain('🎯');
    });
  });
}); 