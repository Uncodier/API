import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agents/growth/robot/plan/route';

// Mock de Supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            order: jest.fn(() => ({
              limit: jest.fn(() => ({
                data: [
                  {
                    id: 'session-1',
                    name: 'Facebook Marketing',
                    domain: 'facebook.com',
                    auth_type: 'cookies',
                    last_used_at: '2024-01-15T10:30:00Z',
                    usage_count: 5,
                    created_at: '2024-01-10T08:00:00Z'
                  },
                  {
                    id: 'session-2',
                    name: 'LinkedIn Business',
                    domain: 'linkedin.com',
                    auth_type: 'cookies',
                    last_used_at: '2024-01-14T14:20:00Z',
                    usage_count: 3,
                    created_at: '2024-01-12T09:15:00Z'
                  }
                ],
                error: null
              }))
            }))
          }))
        }))
      })),
      insert: jest.fn(() => ({
        select: jest.fn(() => ({
          single: jest.fn(() => ({
            data: {
              id: 'test-plan-id',
              title: 'Plan simple para actividad: free agent',
              description: 'Plan simple y enfocado generado automáticamente para ejecución en 1-2 horas máximo',
              plan_type: 'objective',
              status: 'pending'
            },
            error: null
          }))
        }))
      })),
      update: jest.fn(() => ({
        eq: jest.fn(() => ({
          data: null,
          error: null
        }))
      }))
    }))
  }
}));

// Mock de helper functions
jest.mock('@/lib/helpers/agent-finder', () => ({
  findGrowthRobotAgent: jest.fn(() => Promise.resolve({
    agentId: 'test-agent-id',
    userId: 'test-user-id'
  }))
}));

jest.mock('@/lib/helpers/campaign-commands', () => ({
  executeRobotActivityPlanning: jest.fn(() => Promise.resolve({
    activityPlanResults: [{
      title: 'Free Agent Session Exploration Plan',
      description: 'Automated plan to explore and verify existing authentication sessions',
      steps: [
        {
          title: 'Verify Facebook session access',
          description: 'Navigate to Facebook and verify authentication is working',
          order: 1,
          status: 'pending'
        },
        {
          title: 'Check LinkedIn notifications',
          description: 'Open LinkedIn and check for new notifications or messages',
          order: 2,
          status: 'pending'
        }
      ],
      estimated_duration_minutes: 90,
      priority_level: 5,
      success_metrics: [
        'All sessions verified and accessible',
        'Notifications checked and documented',
        'Quick engagement actions completed'
      ]
    }],
    planningCommandUuid: 'test-command-uuid'
  }))
}));

describe('/api/agents/growth/robot/plan - Free Agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST with free agent activity', () => {
    it('debería crear un plan específico para free agent con contexto de sesiones', async () => {
      const validPayload = {
        site_id: 'a1b2c3d4-e5f6-7890-ab12-cd34ef567890',
        user_id: '12345678-1234-1234-1234-123456789012',
        instance_id: '87654321-4321-4321-4321-210987654321',
        activity: 'free agent'
      };

      const request = new NextRequest('http://localhost:3000/api/agents/growth/robot/plan', {
        method: 'POST',
        body: JSON.stringify(validPayload),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      // Verificaciones básicas del response
      expect(response.status).toBe(200);
      expect(result.instance_plan_id).toBe('test-plan-id');
      expect(result.command_id).toBe('test-command-uuid');
      expect(result.message).toBe('Plan creado y ejecutado correctamente');

      // Verificar que se llamó a executeRobotActivityPlanning con el contexto correcto
      const executeRobotActivityPlanning = require('@/lib/helpers/campaign-commands').executeRobotActivityPlanning;
      expect(executeRobotActivityPlanning).toHaveBeenCalledWith(
        validPayload.site_id,
        'test-agent-id',
        'test-user-id',
        'free agent',
        [],
        expect.objectContaining({
          additionalContext: expect.stringContaining('🔑 AVAILABLE SESSIONS (2 sessions)'),
          specificInstructions: expect.stringContaining('🤖 FREE AGENT MODE - SESSION EXPLORATION'),
          requiredData: ['available_sessions', 'platform_notifications', 'recent_activity']
        })
      );

      // Verificar que el contexto contiene las sesiones
      const callArgs = executeRobotActivityPlanning.mock.calls[0];
      const activityContext = callArgs[5];
      
      expect(activityContext.additionalContext).toContain('Facebook Marketing');
      expect(activityContext.additionalContext).toContain('facebook.com');
      expect(activityContext.additionalContext).toContain('LinkedIn Business');
      expect(activityContext.additionalContext).toContain('linkedin.com');
      expect(activityContext.additionalContext).toContain('cookies');
      expect(activityContext.additionalContext).toContain('Usage count: 5');
      expect(activityContext.additionalContext).toContain('Usage count: 3');

      // Verificar las instrucciones específicas de free agent
      expect(activityContext.specificInstructions).toContain('Open and verify the most recent authentication sessions');
      expect(activityContext.specificInstructions).toContain('Check for notifications, messages, or pending actions');
      expect(activityContext.specificInstructions).toContain('Look for quick win opportunities');
      expect(activityContext.specificInstructions).toContain('Maintain platform presence and engagement');
    });

    it('debería rechazar free agent cuando no hay sesiones disponibles', async () => {
      // Mock para simular no hay sesiones disponibles
      const supabaseAdmin = require('@/lib/database/supabase-client').supabaseAdmin;
      
      // 1. Mock para agents (findGrowthRobotAgent)
      supabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              limit: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: { id: 'test-agent-id', user_id: 'test-user-id' },
                  error: null
                }))
              }))
            }))
          }))
        }))
      });

      // 2. Mock para insertar el plan inicial
      supabaseAdmin.from.mockReturnValueOnce({
        insert: jest.fn(() => ({
          select: jest.fn(() => ({
            single: jest.fn(() => ({
              data: {
                id: 'test-plan-id',
                title: 'Plan simple para actividad: free agent',
                status: 'pending'
              },
              error: null
            }))
          }))
        }))
      });

      // 3. Mock para buscar sesiones (devolver array vacío) - Esta es la llamada que causa el error
      supabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              order: jest.fn(() => ({
                limit: jest.fn(() => ({
                  data: [],
                  error: null
                }))
              }))
            }))
          }))
        }))
      });

      // 4. Mock para actualizar plan como requires_auth (después del error)
      supabaseAdmin.from.mockReturnValueOnce({
        update: jest.fn(() => ({
          eq: jest.fn(() => ({
            error: null
          }))
        }))
      });

      const validPayload = {
        site_id: 'a1b2c3d4-e5f6-7890-ab12-cd34ef567890',
        user_id: '12345678-1234-1234-1234-123456789012',
        instance_id: '87654321-4321-4321-4321-210987654321',
        activity: 'free agent'
      };

      const request = new NextRequest('http://localhost:3000/api/agents/growth/robot/plan', {
        method: 'POST',
        body: JSON.stringify(validPayload),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      // Ahora debe devolver 403 (Forbidden) porque no hay sesiones
      expect(response.status).toBe(403);
      expect(result.error).toBe('AUTHENTICATION_REQUIRED');
      expect(result.action_required).toBeDefined();
      expect(result.action_required.type).toBe('LOGIN_REQUIRED');
      expect(result.action_required.login_url).toBe('/auth/platforms');
      
      // Verificar que NO se llamó a executeRobotActivityPlanning
      const executeRobotActivityPlanning = require('@/lib/helpers/campaign-commands').executeRobotActivityPlanning;
      expect(executeRobotActivityPlanning).not.toHaveBeenCalled();
    });

    it('debería permitir free agent cuando SÍ hay sesiones disponibles', async () => {
      // Mock para simular sesiones disponibles
      const supabaseAdmin = require('@/lib/database/supabase-client').supabaseAdmin;
      
      // 1. Mock para agents (findGrowthRobotAgent)
      supabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              limit: jest.fn(() => ({
                single: jest.fn(() => ({
                  data: { id: 'test-agent-id', user_id: 'test-user-id' },
                  error: null
                }))
              }))
            }))
          }))
        }))
      });
      
      // 2. Mock para insertar el plan inicial
      supabaseAdmin.from.mockReturnValueOnce({
        insert: jest.fn(() => ({
          select: jest.fn(() => ({
            single: jest.fn(() => ({
              data: {
                id: 'test-plan-id',
                title: 'Plan simple para actividad: free agent',
                status: 'pending'
              },
              error: null
            }))
          }))
        }))
      });

      // 3. Mock para buscar sesiones (devolver sesiones válidas)
      supabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              order: jest.fn(() => ({
                limit: jest.fn(() => ({
                  data: [
                    {
                      id: 'session-1',
                      name: 'Facebook Session',
                      domain: 'facebook.com',
                      auth_type: 'cookies',
                      last_used_at: new Date().toISOString(),
                      usage_count: 5
                    }
                  ],
                  error: null
                }))
              }))
            }))
          }))
        }))
      });

      // 4. Mock para actualizar plan como completed (al final del proceso)
      supabaseAdmin.from.mockReturnValueOnce({
        update: jest.fn(() => ({
          eq: jest.fn(() => ({
            error: null
          }))
        }))
      });

      const validPayload = {
        site_id: 'a1b2c3d4-e5f6-7890-ab12-cd34ef567890',
        user_id: '12345678-1234-1234-1234-123456789012',
        instance_id: '87654321-4321-4321-4321-210987654321',
        activity: 'free agent'
      };

      const request = new NextRequest('http://localhost:3000/api/agents/growth/robot/plan', {
        method: 'POST',
        body: JSON.stringify(validPayload),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      // Ahora debería devolver 200 porque hay sesiones disponibles
      expect(response.status).toBe(200);
      expect(result.instance_plan_id).toBe('test-plan-id');
      expect(result.message).toContain('Plan creado y ejecutado correctamente');
      
      // Verificar que SÍ se llamó a executeRobotActivityPlanning
      const executeRobotActivityPlanning = require('@/lib/helpers/campaign-commands').executeRobotActivityPlanning;
      expect(executeRobotActivityPlanning).toHaveBeenCalled();
      
      // Verificar que el contexto incluye las sesiones disponibles
      const callArgs = executeRobotActivityPlanning.mock.calls[0];
      const activityContext = callArgs[5];
      expect(activityContext.additionalContext).toContain('🔑 AVAILABLE SESSIONS (1 sessions)');
      expect(activityContext.additionalContext).toContain('Facebook Session');
    });

    it('debería validar los parámetros requeridos para free agent', async () => {
      const invalidPayload = {
        site_id: 'invalid-uuid',
        user_id: '12345678-1234-1234-1234-123456789012',
        instance_id: '87654321-4321-4321-4321-210987654321',
        activity: 'free agent'
      };

      const request = new NextRequest('http://localhost:3000/api/agents/growth/robot/plan', {
        method: 'POST',
        body: JSON.stringify(invalidPayload),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.error).toContain('site_id debe ser un UUID válido');
    });

    it('debería formatear correctamente las fechas de las sesiones', async () => {
      const validPayload = {
        site_id: 'a1b2c3d4-e5f6-7890-ab12-cd34ef567890',
        user_id: '12345678-1234-1234-1234-123456789012',
        instance_id: '87654321-4321-4321-4321-210987654321',
        activity: 'free agent'
      };

      const request = new NextRequest('http://localhost:3000/api/agents/growth/robot/plan', {
        method: 'POST',
        body: JSON.stringify(validPayload),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      
      expect(response.status).toBe(200);

      const executeRobotActivityPlanning = require('@/lib/helpers/campaign-commands').executeRobotActivityPlanning;
      const callArgs = executeRobotActivityPlanning.mock.calls[0];
      const activityContext = callArgs[5];
      
      // Verificar que las fechas se formatean correctamente
      expect(activityContext.additionalContext).toContain('Last used:');
      expect(activityContext.additionalContext).not.toContain('Never used'); // Porque tenemos fechas válidas
    });
  });

  describe('POST with other activities', () => {
    it('debería seguir funcionando para actividades que no son free agent', async () => {
      const validPayload = {
        site_id: 'a1b2c3d4-e5f6-7890-ab12-cd34ef567890',
        user_id: '12345678-1234-1234-1234-123456789012',
        instance_id: '87654321-4321-4321-4321-210987654321',
        activity: 'publish content'
      };

      const request = new NextRequest('http://localhost:3000/api/agents/growth/robot/plan', {
        method: 'POST',
        body: JSON.stringify(validPayload),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.instance_plan_id).toBe('test-plan-id');

      // Verificar que no se usa el contexto de free agent
      const executeRobotActivityPlanning = require('@/lib/helpers/campaign-commands').executeRobotActivityPlanning;
      const callArgs = executeRobotActivityPlanning.mock.calls[0];
      const activityContext = callArgs[5];
      
      expect(activityContext.specificInstructions).not.toContain('🤖 FREE AGENT MODE');
      expect(activityContext.specificInstructions).toContain('📝 CONTENT PUBLISHING FOCUS');
    });

    it('debería funcionar con free-agent (con guión)', async () => {
      const validPayload = {
        site_id: 'a1b2c3d4-e5f6-7890-ab12-cd34ef567890',
        user_id: '12345678-1234-1234-1234-123456789012',
        instance_id: '87654321-4321-4321-4321-210987654321',
        activity: 'free-agent'  // Con guión
      };

      const request = new NextRequest('http://localhost:3000/api/agents/growth/robot/plan', {
        method: 'POST',
        body: JSON.stringify(validPayload),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.instance_plan_id).toBe('test-plan-id');

      // Verificar que se usa el contexto de free agent
      const executeRobotActivityPlanning = require('@/lib/helpers/campaign-commands').executeRobotActivityPlanning;
      const callArgs = executeRobotActivityPlanning.mock.calls[0];
      const activityContext = callArgs[5];
      
      expect(activityContext.specificInstructions).toContain('🤖 FREE AGENT MODE - SESSION EXPLORATION');
      expect(activityContext.additionalContext).toContain('🔑 AVAILABLE SESSIONS (2 sessions)');
    });
  });
});
