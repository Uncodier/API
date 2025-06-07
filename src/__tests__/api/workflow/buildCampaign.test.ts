import { NextRequest } from 'next/server';
import { POST, GET } from '@/app/api/workflow/buildCampaign';

// Mock del WorkflowService
jest.mock('@/lib/services/workflow-service', () => ({
  WorkflowService: {
    getInstance: jest.fn(() => ({
      buildCampaigns: jest.fn()
    }))
  }
}));

describe('/api/workflow/buildCampaign', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST', () => {
    it('debería ejecutar el workflow con site_id válido', async () => {
      // Mock del servicio
      const mockWorkflowService = require('@/lib/services/workflow-service').WorkflowService.getInstance();
      mockWorkflowService.buildCampaigns.mockResolvedValue({
        success: true,
        workflowId: 'test-workflow-id',
        executionId: 'test-execution-id',
        runId: 'test-run-id',
        status: 'completed',
        data: {
          success: true,
          site_id: 'test-site-id',
          campaigns_created: 4,
          campaigns: [
            { id: 'camp_1', title: 'Test Campaign 1', type: 'content_marketing', status: 'active' },
            { id: 'camp_2', title: 'Test Campaign 2', type: 'email_marketing', status: 'active' },
            { id: 'camp_3', title: 'Test Campaign 3', type: 'social_media', status: 'active' },
            { id: 'camp_4', title: 'Test Campaign 4', type: 'seo_optimization', status: 'active' }
          ],
          execution_time_ms: 1500,
          timestamp: '2024-01-01T00:00:00.000Z'
        }
      });

      // Crear request mock
      const request = new NextRequest('http://localhost:3000/api/workflow/buildCampaign', {
        method: 'POST',
        body: JSON.stringify({ site_id: 'test-site-id' }),
        headers: { 'Content-Type': 'application/json' }
      });

      // Ejecutar el endpoint
      const response = await POST(request);
      const result = await response.json();

      // Verificaciones
      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data.site_id).toBe('test-site-id');
      expect(result.data.workflowId).toBe('test-workflow-id');
      expect(result.data.result.campaigns_created).toBe(4);
      expect(mockWorkflowService.buildCampaigns).toHaveBeenCalledWith(
        { site_id: 'test-site-id' },
        expect.objectContaining({
          priority: 'medium',
          async: false,
          retryAttempts: 3
        })
      );
    });

    it('debería fallar cuando site_id no está presente', async () => {
      const request = new NextRequest('http://localhost:3000/api/workflow/buildCampaign', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_SITE_ID');
      expect(result.error.message).toContain('site_id es requerido');
    });

    it('debería fallar cuando site_id no es una cadena', async () => {
      const request = new NextRequest('http://localhost:3000/api/workflow/buildCampaign', {
        method: 'POST',
        body: JSON.stringify({ site_id: 123 }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_SITE_ID');
    });

    it('debería manejar errores del workflow', async () => {
      const mockWorkflowService = require('@/lib/services/workflow-service').WorkflowService.getInstance();
      mockWorkflowService.buildCampaigns.mockResolvedValue({
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: 'Error en el workflow'
        }
      });

      const request = new NextRequest('http://localhost:3000/api/workflow/buildCampaign', {
        method: 'POST',
        body: JSON.stringify({ site_id: 'test-site-id' }),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('WORKFLOW_EXECUTION_ERROR');
    });

    it('debería manejar errores de parsing JSON', async () => {
      const request = new NextRequest('http://localhost:3000/api/workflow/buildCampaign', {
        method: 'POST',
        body: 'invalid json',
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  describe('GET', () => {
    it('debería devolver información sobre el endpoint', async () => {
      const response = await GET();
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.name).toBe('buildCampaignsWorkflow API');
      expect(result.description).toContain('buildCampaignsWorkflow');
      expect(result.methods).toContain('POST');
      expect(result.requiredParams.site_id).toContain('ID del sitio');
      expect(result.example.site_id).toBe('site_12345');
    });
  });
}); 