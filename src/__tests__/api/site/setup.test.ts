import { POST, GET } from '@/app/api/site/setup/route';
import { WorkflowService } from '@/lib/services/workflow-service';
import { NextRequest } from 'next/server';

// Mock WorkflowService
jest.mock('@/lib/services/workflow-service');

describe('/api/site/setup', () => {
  let mockWorkflowService: jest.Mocked<WorkflowService>;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock WorkflowService instance
    mockWorkflowService = {
      executeWorkflow: jest.fn(),
      getWorkflowStatus: jest.fn(),
      sendEmailFromAgent: jest.fn(),
      scheduleCustomerSupport: jest.fn(),
      answerWhatsappMessage: jest.fn(),
      closeConnection: jest.fn(),
      testConnection: jest.fn(),
      getTemporalConfig: jest.fn(),
    } as any;
    
    // Mock the getInstance static method
    (WorkflowService.getInstance as jest.Mock) = jest.fn().mockReturnValue(mockWorkflowService);
  });

  describe('POST /api/site/setup', () => {
    const validSiteId = '12345678-1234-1234-1234-123456789012';
    const validUserId = '87654321-4321-4321-4321-210987654321';

    it('debería ejecutar el workflow de setup exitosamente', async () => {
      // Mock successful workflow execution
      mockWorkflowService.executeWorkflow.mockResolvedValue({
        success: true,
        workflowId: 'site-setup-workflow-123',
        executionId: 'execution-123',
        runId: 'run-123',
        status: 'running'
      });

      const request = new NextRequest('http://localhost:3000/api/site/setup', {
        method: 'POST',
        body: JSON.stringify({
          site_id: validSiteId,
          user_id: validUserId,
          setup_type: 'basic',
          options: {
            enable_analytics: true,
            enable_chat: true,
            enable_leads: true,
            enable_email_tracking: true,
            default_timezone: 'America/Mexico_City',
            default_language: 'es'
          }
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        workflow_id: 'site-setup-workflow-123',
        execution_id: 'execution-123',
        run_id: 'run-123',
        status: 'running',
        site_id: validSiteId,
        setup_type: 'basic',
        message: 'Site setup workflow iniciado exitosamente'
      });

      expect(mockWorkflowService.executeWorkflow).toHaveBeenCalledWith(
        'siteSetupWorkflow',
        {
          site_id: validSiteId,
          user_id: validUserId,
          setup_type: 'basic',
          options: {
            enable_analytics: true,
            enable_chat: true,
            enable_leads: true,
            enable_email_tracking: true,
            default_timezone: 'America/Mexico_City',
            default_language: 'es'
          }
        },
        {
          taskQueue: 'site-setup-queue',
          workflowId: expect.stringMatching(/^site-setup-.*$/),
          priority: 'medium',
          retryAttempts: 3
        }
      );
    });

    it('debería usar valores por defecto cuando no se proporcionan opciones', async () => {
      mockWorkflowService.executeWorkflow.mockResolvedValue({
        success: true,
        workflowId: 'site-setup-workflow-123',
        executionId: 'execution-123',
        runId: 'run-123',
        status: 'running'
      });

      const request = new NextRequest('http://localhost:3000/api/site/setup', {
        method: 'POST',
        body: JSON.stringify({
          site_id: validSiteId
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      expect(mockWorkflowService.executeWorkflow).toHaveBeenCalledWith(
        'siteSetupWorkflow',
        {
          site_id: validSiteId,
          user_id: undefined,
          setup_type: 'basic',
          options: {
            enable_analytics: true,
            enable_chat: true,
            enable_leads: true,
            enable_email_tracking: true,
            default_timezone: 'UTC',
            default_language: 'es'
          }
        },
        expect.any(Object)
      );
    });

    it('debería retornar error cuando site_id no se proporciona', async () => {
      const request = new NextRequest('http://localhost:3000/api/site/setup', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('site_id is required');
      expect(mockWorkflowService.executeWorkflow).not.toHaveBeenCalled();
    });

    it('debería retornar error cuando site_id no es un UUID válido', async () => {
      const request = new NextRequest('http://localhost:3000/api/site/setup', {
        method: 'POST',
        body: JSON.stringify({
          site_id: 'invalid-uuid'
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('site_id must be a valid UUID');
      expect(mockWorkflowService.executeWorkflow).not.toHaveBeenCalled();
    });

    it('debería retornar error cuando user_id no es un UUID válido', async () => {
      const request = new NextRequest('http://localhost:3000/api/site/setup', {
        method: 'POST',
        body: JSON.stringify({
          site_id: validSiteId,
          user_id: 'invalid-uuid'
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('user_id must be a valid UUID');
      expect(mockWorkflowService.executeWorkflow).not.toHaveBeenCalled();
    });

    it('debería manejar errores del workflow', async () => {
      mockWorkflowService.executeWorkflow.mockResolvedValue({
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: 'Error connecting to Temporal'
        }
      });

      const request = new NextRequest('http://localhost:3000/api/site/setup', {
        method: 'POST',
        body: JSON.stringify({
          site_id: validSiteId,
          setup_type: 'advanced'
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('WORKFLOW_EXECUTION_ERROR');
      expect(data.error.message).toBe('Error connecting to Temporal');
    });

    it('debería soportar diferentes tipos de setup', async () => {
      const setupTypes = ['basic', 'advanced', 'complete'];

      for (const setupType of setupTypes) {
        mockWorkflowService.executeWorkflow.mockResolvedValue({
          success: true,
          workflowId: `site-setup-${setupType}-123`,
          executionId: 'execution-123',
          runId: 'run-123',
          status: 'running'
        });

        const request = new NextRequest('http://localhost:3000/api/site/setup', {
          method: 'POST',
          body: JSON.stringify({
            site_id: validSiteId,
            setup_type: setupType
          }),
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.data.setup_type).toBe(setupType);
      }
    });
  });

  describe('GET /api/site/setup', () => {
    it('debería obtener el estado del workflow exitosamente', async () => {
      mockWorkflowService.getWorkflowStatus.mockResolvedValue({
        success: true,
        workflowId: 'site-setup-workflow-123',
        runId: 'run-123',
        status: 'completed'
      });

      const request = new NextRequest('http://localhost:3000/api/site/setup?workflow_id=site-setup-workflow-123', {
        method: 'GET'
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual({
        workflow_id: 'site-setup-workflow-123',
        run_id: 'run-123',
        status: 'completed',
        message: 'Workflow status: completed'
      });

      expect(mockWorkflowService.getWorkflowStatus).toHaveBeenCalledWith('site-setup-workflow-123');
    });

    it('debería retornar error cuando workflow_id no se proporciona', async () => {
      const request = new NextRequest('http://localhost:3000/api/site/setup', {
        method: 'GET'
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('workflow_id is required');
      expect(mockWorkflowService.getWorkflowStatus).not.toHaveBeenCalled();
    });

    it('debería manejar errores al obtener el estado del workflow', async () => {
      mockWorkflowService.getWorkflowStatus.mockResolvedValue({
        success: false,
        error: {
          code: 'WORKFLOW_NOT_FOUND',
          message: 'Workflow not found'
        }
      });

      const request = new NextRequest('http://localhost:3000/api/site/setup?workflow_id=invalid-workflow-id', {
        method: 'GET'
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('WORKFLOW_NOT_FOUND');
      expect(data.error.message).toBe('Workflow not found');
    });
  });
}); 