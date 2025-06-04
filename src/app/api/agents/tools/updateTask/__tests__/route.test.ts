import { NextRequest } from 'next/server';
import { PUT, POST, GET } from '../route';

// Mock del módulo de Supabase
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn()
        }))
      })),
      update: jest.fn(() => ({
        eq: jest.fn(() => ({
          select: jest.fn(() => ({
            single: jest.fn()
          }))
        }))
      }))
    }))
  }
}));

// Mock del servicio de base de datos de tareas
jest.mock('@/lib/database/task-db', () => ({
  updateTask: jest.fn().mockResolvedValue({
    id: 'task-123',
    title: 'Updated Test Task',
    description: 'Updated Test Description',
    type: 'follow_up',
    status: 'in_progress',
    stage: 'consideration',
    priority: 10,
    user_id: '12345678-1234-1234-1234-123456789012',
    site_id: '87654321-4321-4321-4321-210987654321',
    lead_id: 'abcdef12-3456-7890-abcd-ef1234567890',
    created_at: '2024-01-10T10:30:00Z',
    updated_at: '2024-01-15T14:22:00Z',
    scheduled_date: '2024-01-20T14:00:00Z',
    completed_date: null,
    amount: 2000.00,
    assignee: null,
    notes: 'Task updated successfully',
    command_id: null,
    agent_id: null,
    address: {
      street: "456 Updated St",
      city: "San Francisco",
      country: "USA"
    }
  }),
  getTaskById: jest.fn().mockResolvedValue({
    id: 'task-123',
    title: 'Original Test Task',
    description: 'Original Test Description',
    type: 'call',
    status: 'pending',
    stage: 'awareness',
    priority: 5,
    user_id: '12345678-1234-1234-1234-123456789012',
    site_id: '87654321-4321-4321-4321-210987654321',
    lead_id: 'abcdef12-3456-7890-abcd-ef1234567890',
    created_at: '2024-01-10T10:30:00Z',
    updated_at: '2024-01-10T10:30:00Z',
    scheduled_date: null,
    completed_date: null,
    amount: 1500.00,
    assignee: null,
    notes: 'Original notes',
    command_id: null,
    agent_id: null,
    address: null
  })
}));

// Función auxiliar para crear mocks de request
function createMockRequest(data: any): NextRequest {
  return {
    json: async () => data,
    headers: new Headers(),
    method: 'PUT',
    url: 'http://localhost:3000/api/agents/tools/updateTask'
  } as NextRequest;
}

describe('/api/agents/tools/updateTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('PUT', () => {
    it('debería actualizar una tarea con datos válidos', async () => {
      const updateTaskData = {
        task_id: 'task-123',
        title: 'Updated Test Task',
        status: 'in_progress',
        stage: 'consideration',
        priority: 10,
        amount: 2000.00,
        notes: 'Task updated successfully',
        address: {
          street: "456 Updated St",
          city: "San Francisco",
          country: "USA"
        }
      };

      const request = createMockRequest(updateTaskData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.task.id).toBe('task-123');
      expect(responseData.task.title).toBe('Updated Test Task');
      expect(responseData.task.status).toBe('in_progress');
      expect(responseData.task.stage).toBe('consideration');
      expect(responseData.task.priority).toBe(10);
      expect(responseData.task.amount).toBe(2000.00);
      expect(responseData.task.notes).toBe('Task updated successfully');
      expect(responseData.task.address.street).toBe('456 Updated St');
    });

    it('debería actualizar una tarea con datos mínimos (solo task_id y un campo)', async () => {
      const minimalUpdateData = {
        task_id: 'task-123',
        status: 'completed'
      };

      const request = createMockRequest(minimalUpdateData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.task.id).toBe('task-123');
    });

    it('debería marcar una tarea como completada con fecha de completado', async () => {
      const completionData = {
        task_id: 'task-123',
        status: 'completed',
        stage: 'completed',
        completed_date: '2024-01-20T16:30:00Z',
        notes: 'Task completed successfully'
      };

      const request = createMockRequest(completionData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.task.status).toBe('in_progress'); // Del mock
    });

    it('debería actualizar la asignación de una tarea', async () => {
      const reassignmentData = {
        task_id: 'task-123',
        assignee: '87654321-4321-4321-4321-210987654321',
        notes: 'Reassigned to senior team member'
      };

      const request = createMockRequest(reassignmentData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.task.id).toBe('task-123');
    });

    it('debería fallar con task_id faltante', async () => {
      const invalidTaskData = {
        title: 'Updated Task',
        status: 'in_progress'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
      expect(responseData.details).toBeDefined();
    });

    it('debería fallar con task_id inválido (no UUID)', async () => {
      const invalidTaskData = {
        task_id: 'invalid-uuid',
        status: 'in_progress'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
    });

    it('debería fallar si la tarea no existe', async () => {
      // Mock para simular tarea no encontrada
      const { getTaskById } = require('@/lib/database/task-db');
      getTaskById.mockResolvedValueOnce(null);

      const updateTaskData = {
        task_id: 'nonexistent-task-id',
        status: 'in_progress'
      };

      const request = createMockRequest(updateTaskData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(404);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Tarea no encontrada');
    });

    it('debería fallar con fecha inválida', async () => {
      const invalidTaskData = {
        task_id: 'task-123',
        scheduled_date: 'invalid-date'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
    });

    it('debería fallar con assignee inválido (no UUID)', async () => {
      const invalidTaskData = {
        task_id: 'task-123',
        assignee: 'invalid-assignee-id'
      };

      const request = createMockRequest(invalidTaskData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBe('Datos de entrada inválidos');
    });

    it('debería manejar errores de la base de datos', async () => {
      // Mock para simular error en updateTask
      const { updateTask } = require('@/lib/database/task-db');
      updateTask.mockRejectedValueOnce(new Error('Database connection error'));

      const updateTaskData = {
        task_id: 'task-123',
        status: 'in_progress'
      };

      const request = createMockRequest(updateTaskData);
      const response = await PUT(request);
      const responseData = await response.json();

      expect(response.status).toBe(500);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Error actualizando tarea');
    });
  });

  describe('POST', () => {
    it('debería funcionar como alias de PUT', async () => {
      const updateTaskData = {
        task_id: 'task-123',
        status: 'in_progress'
      };

      const request = createMockRequest(updateTaskData);
      const response = await POST(request);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.success).toBe(true);
      expect(responseData.task.id).toBe('task-123');
    });
  });

  describe('GET', () => {
    it('debería devolver información sobre la API', async () => {
      const response = await GET();
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.message).toBe('API de actualización de tareas');
      expect(responseData.endpoint).toBe('/api/agents/tools/updateTask');
      expect(responseData.methods).toContain('PUT');
      expect(responseData.methods).toContain('POST');
      expect(responseData.methods).toContain('GET');
      expect(responseData.required_fields).toContain('task_id');
      expect(responseData.optional_fields).toContain('title');
      expect(responseData.optional_fields).toContain('status');
      expect(responseData.optional_fields).toContain('stage');
      expect(responseData.example_request).toBeDefined();
      expect(responseData.example_response).toBeDefined();
      expect(responseData.common_patterns).toBeDefined();
    });
  });
}); 