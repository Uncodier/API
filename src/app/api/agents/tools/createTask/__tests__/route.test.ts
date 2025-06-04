/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { POST, GET } from '../route';

// Mock de Supabase Admin
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn().mockResolvedValue({
            data: {
              id: 'abcdef12-3456-7890-abcd-ef1234567890',
              user_id: '12345678-1234-1234-1234-123456789012', 
              site_id: '87654321-4321-4321-4321-210987654321',
              name: 'John Doe',
              email: 'john@example.com',
              company: 'Test Company'
            },
            error: null
          })
        }))
      }))
    }))
  }
}));

// Mock del servicio de base de datos de tareas
jest.mock('@/lib/database/task-db', () => ({
  createTask: jest.fn().mockResolvedValue({
    id: 'task-123',
    title: 'Test Task',
    description: 'Test Description',
    type: 'follow_up',
    status: 'active',
    stage: 'pending',
    priority: 'medium',
    user_id: '12345678-1234-1234-1234-123456789012',
    site_id: '87654321-4321-4321-4321-210987654321',
    lead_id: 'abcdef12-3456-7890-abcd-ef1234567890',
    created_at: '2024-01-10T10:30:00Z',
    updated_at: '2024-01-10T10:30:00Z',
    due_date: null,
    scheduled_date: null,
    command_id: null,
    agent_id: null,
    metadata: null,
    completion_date: null
  })
}));

// Helper para crear request mock
function createMockRequest(body: any) {
  return {
    json: jest.fn().mockResolvedValue(body)
  } as unknown as NextRequest;
}

describe('/api/agents/tools/createTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST', () => {
    it('debería crear una tarea con datos válidos usando solo lead_id', async () => {
      const taskData = {
        title: 'Test Task',
        description: 'Test Description',
        type: 'follow_up',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890'
      };

      const request = createMockRequest(taskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(201);
      expect(responseData.success).toBe(true);
      expect(responseData.task).toBeDefined();
      expect(responseData.task.title).toBe('Test Task');
      expect(responseData.task.type).toBe('follow_up');
      expect(responseData.task.lead_id).toBe('abcdef12-3456-7890-abcd-ef1234567890');
      expect(responseData.task.user_id).toBe('12345678-1234-1234-1234-123456789012'); // Obtenido del lead
      expect(responseData.task.site_id).toBe('87654321-4321-4321-4321-210987654321'); // Obtenido del lead
    });

    it('debería crear una tarea con datos completos especificados manualmente', async () => {
      // Mock para simular validaciones adicionales del usuario y sitio específicos
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      supabaseAdmin.from
        .mockReturnValueOnce({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: {
              id: 'abcdef12-3456-7890-abcd-ef1234567890',
              user_id: '12345678-1234-1234-1234-123456789012', 
              site_id: '87654321-4321-4321-4321-210987654321',
              name: 'John Doe',
              email: 'john@example.com',
              company: 'Test Company'
            },
            error: null
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: '33333333-3333-3333-3333-333333333333' },
            error: null
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: '44444444-4444-4444-4444-444444444444' },
            error: null
          })
        });

      const taskData = {
        title: 'Test Task',
        description: 'Test Description',
        type: 'follow_up',
        priority: 'high',
        status: 'active',
        stage: 'pending',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890',
        user_id: '33333333-3333-3333-3333-333333333333',
        site_id: '44444444-4444-4444-4444-444444444444',
        due_date: '2024-01-15T14:00:00Z',
        metadata: { source: 'manual' }
      };

      const request = createMockRequest(taskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(201);
      expect(responseData.success).toBe(true);
      expect(responseData.task.user_id).toBe('12345678-1234-1234-1234-123456789012'); // Del mock de createTask
      expect(responseData.task.site_id).toBe('87654321-4321-4321-4321-210987654321'); // Del mock de createTask
    });

    it('debería crear una tarea con valores por defecto', async () => {
      const minimalTaskData = {
        title: 'Minimal Task',
        type: 'administrative',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890'
      };

      const request = createMockRequest(minimalTaskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(201);
      expect(responseData.success).toBe(true);
      expect(responseData.task.status).toBe('active');
      expect(responseData.task.stage).toBe('pending');
      expect(responseData.task.priority).toBe('medium');
    });

    it('debería fallar con datos inválidos - título faltante', async () => {
      const invalidTaskData = {
        type: 'follow_up',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
      expect(responseData.details).toBeDefined();
    });

    it('debería fallar con datos inválidos - lead_id faltante', async () => {
      const invalidTaskData = {
        title: 'Test Task',
        type: 'follow_up'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
      expect(responseData.details).toBeDefined();
    });

    it('debería fallar con tipo de tarea inválido', async () => {
      const invalidTaskData = {
        title: 'Test Task',
        type: 'some_invalid_type', // Tipo que pasa Zod pero no está en VALID_TASK_TYPES
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Tipo de tarea inválido');
    });

    it('debería fallar con UUID inválido para lead_id', async () => {
      const invalidTaskData = {
        title: 'Test Task',
        type: 'follow_up',
        lead_id: 'invalid-uuid'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
    });

    it('debería fallar cuando el lead no existe', async () => {
      // Mock para simular lead no encontrado
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      supabaseAdmin.from.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'Lead not found' }
        })
      });

      const taskData = {
        title: 'Test Task',
        type: 'follow_up',
        lead_id: '11111111-1111-1111-1111-111111111111' // UUID válido pero inexistente
      };

      const request = createMockRequest(taskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(404);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Lead no encontrado');
    });

    it('debería fallar cuando el usuario especificado no existe', async () => {
      // Mock para simular usuario especificado no encontrado
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      supabaseAdmin.from
        .mockReturnValueOnce({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: {
              id: 'abcdef12-3456-7890-abcd-ef1234567890',
              user_id: '12345678-1234-1234-1234-123456789012', 
              site_id: '87654321-4321-4321-4321-210987654321',
              name: 'John Doe',
              email: 'john@example.com',
              company: 'Test Company'
            },
            error: null
          })
        })
        .mockReturnValueOnce({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: null,
            error: { message: 'User not found' }
          })
        });

      const taskData = {
        title: 'Test Task',
        type: 'follow_up',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890',
        user_id: '22222222-2222-2222-2222-222222222222' // UUID válido pero inexistente
      };

      const request = createMockRequest(taskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(404);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Usuario no encontrado');
    });

    it('debería manejar errores de la base de datos', async () => {
      // Mock para simular error del servicio de tareas
      const { createTask } = require('@/lib/database/task-db');
      createTask.mockRejectedValueOnce(new Error('Error creating task: Database connection failed'));

      const taskData = {
        title: 'Test Task',
        type: 'follow_up',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890'
      };

      const request = createMockRequest(taskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Error creating task');
    });

    it('debería validar fechas en formato ISO 8601', async () => {
      const taskDataWithInvalidDate = {
        title: 'Test Task',
        type: 'follow_up',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890',
        due_date: 'invalid-date-format'
      };

      const request = createMockRequest(taskDataWithInvalidDate);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
    });

    it('debería aceptar metadata como objeto', async () => {
      const taskDataWithMetadata = {
        title: 'Test Task',
        type: 'follow_up',
        lead_id: 'abcdef12-3456-7890-abcd-ef1234567890',
        metadata: {
          source: 'automated',
          campaign_id: 'campaign_123',
          tags: ['urgent', 'high-value']
        }
      };

      const request = createMockRequest(taskDataWithMetadata);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(201);
      expect(responseData.success).toBe(true);
      expect(responseData.task).toBeDefined();
    });
  });

  describe('GET', () => {
    it('debería devolver información de la API', async () => {
      const response = await GET();
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.message).toBe('API de creación de tareas');
      expect(responseData.description).toBeDefined();
      expect(responseData.required_fields).toEqual(['title', 'type', 'lead_id']);
      expect(responseData.valid_task_types).toBeDefined();
      expect(responseData.example_request).toBeDefined();
      expect(responseData.example_response).toBeDefined();
    });

    it('debería incluir todos los tipos de tareas válidos', async () => {
      const response = await GET();
      const responseData = await response.json();

      const expectedTypes = [
        'follow_up',
        'marketing_campaign',
        'sales_demo',
        'content_creation',
        'lead_qualification',
        'customer_support',
        'meeting_preparation',
        'market_research',
        'product_feedback',
        'administrative'
      ];

      expect(responseData.valid_task_types).toEqual(expectedTypes);
    });

    it('debería incluir estados y prioridades válidos', async () => {
      const response = await GET();
      const responseData = await response.json();

      expect(responseData.task_statuses).toEqual(['active', 'inactive', 'archived']);
      expect(responseData.task_stages).toEqual(['pending', 'in_progress', 'review', 'completed', 'on_hold', 'cancelled']);
      expect(responseData.priority_levels).toEqual(['low', 'medium', 'high', 'urgent']);
    });
  });
}); 