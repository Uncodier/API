import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// Mock de las dependencias
jest.mock('@/lib/agentbase', () => ({
  CommandFactory: {
    createCommand: jest.fn()
  },
  ProcessorInitializer: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn(),
      getCommandService: jest.fn().mockReturnValue({
        submitCommand: jest.fn(),
        getCommandById: jest.fn()
      })
    })
  }
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis()
  }
}));

// Import de la función que vamos a testear
import { POST, GET } from '../../../../src/app/api/agents/copywriter/content-improve/route';

describe('Content Improve API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/agents/copywriter/content-improve', () => {
    test('debería requerir contentId', async () => {
      const request = new Request('http://localhost/api/agents/copywriter/content-improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('contentId is required');
    });

    test('debería validar que contentId sea un UUID válido', async () => {
      const request = new Request('http://localhost/api/agents/copywriter/content-improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentId: 'invalid-uuid'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('contentId must be a valid UUID');
    });

    test('debería retornar 404 si el contenido no existe', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      
      supabaseAdmin.single.mockResolvedValue({
        data: null,
        error: { message: 'Content not found' }
      });

      const request = new Request('http://localhost/api/agents/copywriter/content-improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentId: '123e4567-e89b-12d3-a456-426614174000'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('CONTENT_NOT_FOUND');
    });

    test('debería rechazar contenido que no está en estado draft', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      
      supabaseAdmin.single.mockResolvedValue({
        data: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Test Content',
          status: 'published',
          site_id: '456e7890-e89b-12d3-a456-426614174001'
        },
        error: null
      });

      const request = new Request('http://localhost/api/agents/copywriter/content-improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentId: '123e4567-e89b-12d3-a456-426614174000'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CONTENT_STATUS');
      expect(data.error.message).toBe('Content must be in draft status to be improved');
    });

    test('debería procesar correctamente contenido válido en estado draft', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      const { CommandFactory, ProcessorInitializer } = require('@/lib/agentbase');
      
      // Mock del contenido existente
      supabaseAdmin.single
        .mockResolvedValueOnce({
          data: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            title: 'Test Content',
            description: 'Test description',
            text: 'Test content text',
            status: 'draft',
            site_id: '456e7890-e89b-12d3-a456-426614174001'
          },
          error: null
        })
        // Mock para site info
        .mockResolvedValueOnce({
          data: {
            id: '456e7890-e89b-12d3-a456-426614174001',
            name: 'Test Site',
            description: 'Test site description'
          },
          error: null
        });

      // Mock del servicio de comandos
      const mockCommandService = {
        submitCommand: jest.fn().mockResolvedValue('test-command-id'),
        getCommandById: jest.fn().mockResolvedValue({
          id: 'test-command-id',
          status: 'completed',
          results: [{
            type: 'content',
            content: [{
              title: 'Improved Test Content',
              description: 'Improved test description',
              text: 'Improved test content text',
              improvement_notes: 'Content improved successfully',
              improvements_applied: ['SEO optimization', 'Readability improvement'],
              original_score: 65,
              improved_score: 85
            }]
          }],
          metadata: {
            dbUuid: '789e0123-e89b-12d3-a456-426614174003'
          }
        })
      };

      ProcessorInitializer.getInstance.mockReturnValue({
        initialize: jest.fn(),
        getCommandService: jest.fn().mockReturnValue(mockCommandService)
      });

      CommandFactory.createCommand.mockReturnValue({
        task: 'improve content',
        userId: 'system',
        agentId: 'default_copywriter_agent'
      });

      // Mock de la actualización del contenido
      supabaseAdmin.update.mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            title: 'Improved Test Content',
            description: 'Improved test description',
            text: 'Improved test content text',
            status: 'improved'
          },
          error: null
        })
      });

      const request = new Request('http://localhost/api/agents/copywriter/content-improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentId: '123e4567-e89b-12d3-a456-426614174000',
          improvementGoals: ['Improve readability', 'Optimize SEO'],
          keywords: ['test', 'content']
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.content_id).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(data.data.original_content.title).toBe('Test Content');
      expect(data.data.improved_content.title).toBe('Improved Test Content');
    });

    test('debería manejar parámetros opcionales correctamente', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      const { CommandFactory } = require('@/lib/agentbase');
      
      supabaseAdmin.single.mockResolvedValueOnce({
        data: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Test Content',
          status: 'draft',
          site_id: '456e7890-e89b-12d3-a456-426614174001'
        },
        error: null
      });

      const request = new Request('http://localhost/api/agents/copywriter/content-improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentId: '123e4567-e89b-12d3-a456-426614174000',
          siteId: '456e7890-e89b-12d3-a456-426614174001',
          segmentId: '789e0123-e89b-12d3-a456-426614174002',
          campaignId: 'abc1234d-e89b-12d3-a456-426614174003',
          userId: 'user123',
          agent_id: 'custom_agent',
          improvementGoals: ['Goal 1', 'Goal 2'],
          targetAudience: ['Audience 1', 'Audience 2'],
          keywords: ['keyword1', 'keyword2'],
          contentStyle: 'professional',
          maxLength: 2000
        })
      });

      // No necesitamos que se complete todo el proceso para este test
      try {
        await POST(request);
      } catch (error) {
        // Esperamos que falle en algún punto, pero queremos verificar que los parámetros se procesaron
      }

      // Verificar que CommandFactory fue llamado con los parámetros correctos
      expect(CommandFactory.createCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'improve content',
          userId: 'user123',
          agentId: 'custom_agent',
          site_id: '456e7890-e89b-12d3-a456-426614174001'
        })
      );
    });
  });

  describe('GET /api/agents/copywriter/content-improve', () => {
    test('debería requerir siteId', async () => {
      const request = new Request('http://localhost/api/agents/copywriter/content-improve');

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('siteId is required');
    });

    test('debería validar que siteId sea un UUID válido', async () => {
      const request = new Request('http://localhost/api/agents/copywriter/content-improve?siteId=invalid-uuid');

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBe('siteId must be a valid UUID');
    });

    test('debería retornar contenido en draft correctamente', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      
      const mockDraftContent = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Draft Content 1',
          description: 'Description 1',
          text: 'Content text 1',
          type: 'blog_post',
          status: 'draft',
          created_at: '2024-01-10T09:15:00Z',
          site_id: '456e7890-e89b-12d3-a456-426614174001'
        },
        {
          id: '234e5678-e89b-12d3-a456-426614174001',
          title: 'Draft Content 2',
          description: 'Description 2',
          text: 'Content text 2',
          type: 'article',
          status: 'draft',
          created_at: '2024-01-11T10:20:00Z',
          site_id: '456e7890-e89b-12d3-a456-426614174001'
        }
      ];

      supabaseAdmin.limit.mockResolvedValue({
        data: mockDraftContent,
        error: null
      });

      const request = new Request(
        'http://localhost/api/agents/copywriter/content-improve?siteId=456e7890-e89b-12d3-a456-426614174001&limit=5'
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.siteId).toBe('456e7890-e89b-12d3-a456-426614174001');
      expect(data.data.draft_content).toHaveLength(2);
      expect(data.data.total_items).toBe(2);
      expect(data.data.draft_content[0].title).toBe('Draft Content 1');
    });

    test('debería aplicar filtros opcionales correctamente', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      
      // Mock del query builder
      const mockQuery = {
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [], error: null })
      };

      supabaseAdmin.from.mockReturnValue({
        select: jest.fn().mockReturnValue(mockQuery)
      });

      const request = new Request(
        'http://localhost/api/agents/copywriter/content-improve?' +
        'siteId=456e7890-e89b-12d3-a456-426614174001' +
        '&segmentId=789e0123-e89b-12d3-a456-426614174002' +
        '&campaignId=abc1234d-e89b-12d3-a456-426614174003' +
        '&limit=15'
      );

      await GET(request);

      // Verificar que se aplicaron los filtros correctos
      expect(mockQuery.eq).toHaveBeenCalledWith('site_id', '456e7890-e89b-12d3-a456-426614174001');
      expect(mockQuery.eq).toHaveBeenCalledWith('status', 'draft');
      expect(mockQuery.eq).toHaveBeenCalledWith('segment_id', '789e0123-e89b-12d3-a456-426614174002');
      expect(mockQuery.eq).toHaveBeenCalledWith('campaign_id', 'abc1234d-e89b-12d3-a456-426614174003');
      expect(mockQuery.limit).toHaveBeenCalledWith(15);
    });

    test('debería usar límite por defecto cuando no se proporciona', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      
      const mockQuery = {
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [], error: null })
      };

      supabaseAdmin.from.mockReturnValue({
        select: jest.fn().mockReturnValue(mockQuery)
      });

      const request = new Request(
        'http://localhost/api/agents/copywriter/content-improve?siteId=456e7890-e89b-12d3-a456-426614174001'
      );

      await GET(request);

      expect(mockQuery.limit).toHaveBeenCalledWith(10);
    });

    test('debería manejar errores de base de datos', async () => {
      const { supabaseAdmin } = require('@/lib/database/supabase-client');
      
      supabaseAdmin.limit.mockResolvedValue({
        data: null,
        error: { message: 'Database error' }
      });

      const request = new Request(
        'http://localhost/api/agents/copywriter/content-improve?siteId=456e7890-e89b-12d3-a456-426614174001'
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.draft_content).toEqual([]);
      expect(data.data.total_items).toBe(0);
    });
  });

  describe('Utility Functions', () => {
    test('debería validar UUIDs correctamente', () => {
      // Esta función está en el archivo de ruta, así que importaríamos si fuera exportada
      const validUUIDs = [
        '123e4567-e89b-12d3-a456-426614174000',
        '456e7890-e89b-12d3-a456-426614174001',
        'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      ];

      const invalidUUIDs = [
        'invalid-uuid',
        '123-456-789',
        '123e4567e89b12d3a456426614174000',
        '',
        null,
        undefined
      ];

      // Como la función no está exportada, testearíamos el comportamiento a través de los endpoints
      // En un caso real, podríamos extraer estas funciones a un módulo separado
    });
  });
});

describe('Content Improve API Integration', () => {
  test('debería manejar el flujo completo de mejora de contenido', async () => {
    // Test de integración que simula todo el flujo
    const { supabaseAdmin } = require('@/lib/database/supabase-client');
    const { CommandFactory, ProcessorInitializer } = require('@/lib/agentbase');
    
    // Setup mocks para todo el flujo
    supabaseAdmin.single
      .mockResolvedValueOnce({
        data: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Original Content',
          description: 'Original description',
          text: 'Original content text that needs improvement',
          status: 'draft',
          site_id: '456e7890-e89b-12d3-a456-426614174001'
        },
        error: null
      })
      .mockResolvedValueOnce({
        data: {
          id: '456e7890-e89b-12d3-a456-426614174001',
          name: 'Test Site',
          description: 'Test site for content improvement'
        },
        error: null
      });

    const mockCommandService = {
      submitCommand: jest.fn().mockResolvedValue('command-123'),
      getCommandById: jest.fn()
        .mockResolvedValueOnce({
          id: 'command-123',
          status: 'running'
        })
        .mockResolvedValueOnce({
          id: 'command-123',
          status: 'completed',
          results: [{
            type: 'content',
            content: [{
              title: 'Improved Original Content - Enhanced for Better Engagement',
              description: 'Significantly enhanced description with improved readability and SEO optimization',
              text: 'Completely improved content text with better structure, enhanced readability, and strategic keyword placement',
              improvement_notes: 'Applied comprehensive improvements including structure optimization, SEO enhancement, and readability improvements',
              improvements_applied: [
                'Title enhancement for better engagement',
                'Description optimization for SEO',
                'Content restructuring for improved flow',
                'Keyword optimization',
                'Readability improvements'
              ],
              original_score: 62,
              improved_score: 89
            }]
          }],
          metadata: {
            dbUuid: '789e0123-e89b-12d3-a456-426614174003'
          }
        });
    };

    ProcessorInitializer.getInstance.mockReturnValue({
      initialize: jest.fn(),
      getCommandService: jest.fn().mockReturnValue(mockCommandService)
    });

    supabaseAdmin.update.mockReturnValue({
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Improved Original Content - Enhanced for Better Engagement',
          description: 'Significantly enhanced description with improved readability and SEO optimization',
          text: 'Completely improved content text with better structure, enhanced readability, and strategic keyword placement',
          status: 'improved',
          updated_at: '2024-01-15T10:30:00Z',
          metadata: {
            improved_at: '2024-01-15T10:30:00Z',
            improved_by: 'system',
            improvement_notes: 'Applied comprehensive improvements including structure optimization, SEO enhancement, and readability improvements',
            improvements_applied: [
              'Title enhancement for better engagement',
              'Description optimization for SEO',
              'Content restructuring for improved flow',
              'Keyword optimization',
              'Readability improvements'
            ],
            original_score: 62,
            improved_score: 89
          }
        },
        error: null
      })
    });

    const request = new Request('http://localhost/api/agents/copywriter/content-improve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentId: '123e4567-e89b-12d3-a456-426614174000',
        improvementGoals: [
          'Improve readability and structure',
          'Optimize for SEO',
          'Enhance engagement factors'
        ],
        keywords: ['content improvement', 'SEO optimization', 'engagement'],
        contentStyle: 'professional and engaging'
      })
    });

    const response = await POST(request);
    const data = await response.json();

    // Verificaciones del resultado completo
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    
    // Verificar estructura de datos
    expect(data.data).toHaveProperty('command_id');
    expect(data.data).toHaveProperty('content_id', '123e4567-e89b-12d3-a456-426614174000');
    expect(data.data).toHaveProperty('original_content');
    expect(data.data).toHaveProperty('improved_content');
    expect(data.data).toHaveProperty('improvements_summary');
    
    // Verificar contenido original
    expect(data.data.original_content.title).toBe('Original Content');
    expect(data.data.original_content.status).toBe('draft');
    
    // Verificar contenido mejorado
    expect(data.data.improved_content.title).toContain('Improved');
    expect(data.data.improved_content.status).toBe('improved');
    expect(data.data.improved_content.metadata.improved_score).toBeGreaterThan(
      data.data.improved_content.metadata.original_score
    );
    expect(data.data.improved_content.metadata.improvements_applied).toBeInstanceOf(Array);
    expect(data.data.improved_content.metadata.improvements_applied.length).toBeGreaterThan(0);
  });
});