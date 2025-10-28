import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

/**
 * API endpoint para consultar workflows por site_id
 * GET /api/logs/workflows?site_id=<site_id>&limit=<limit>&pageToken=<pageToken>
 */
export async function GET(request: NextRequest) {
  try {
    console.log('📊 Consultando workflows por site_id');

    // Extraer parámetros de la URL
    const { searchParams } = new URL(request.url);
    const site_id = searchParams.get('site_id');
    const limitParam = searchParams.get('limit');
    const pageToken = searchParams.get('pageToken');

    // Validar site_id (requerido)
    if (!site_id || typeof site_id !== 'string') {
      console.error('❌ site_id requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_SITE_ID', 
            message: 'site_id es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    // Validar y procesar limit
    let limit = 20; // Default
    if (limitParam) {
      const parsedLimit = parseInt(limitParam, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        console.error('❌ limit debe ser un número entre 1 y 100');
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'INVALID_LIMIT', 
              message: 'limit debe ser un número entre 1 y 100' 
            } 
          },
          { status: 400 }
        );
      }
      limit = parsedLimit;
    }

    console.log(`🔍 Consultando workflows para site_id: ${site_id}, limit: ${limit}`);
    if (pageToken) {
      console.log(`📄 Usando pageToken: ${pageToken}`);
    }

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Consultar workflows
    const result = await workflowService.listWorkflowsBySiteId(
      site_id,
      limit,
      pageToken || undefined
    );

    if (!result.success) {
      console.error('❌ Error al consultar workflows:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_QUERY_ERROR',
            message: result.error?.message || 'Error al consultar workflows'
          }
        },
        { status: 500 }
      );
    }

    console.log(`✅ Encontrados ${result.workflows.length} workflows para site_id: ${site_id}`);

    // Retornar respuesta exitosa
    return NextResponse.json({
      success: true,
      workflows: result.workflows,
      pagination: result.pagination,
      meta: {
        site_id,
        total_found: result.workflows.length,
        has_more: result.pagination.hasMore
      }
    }, { status: 200 });

  } catch (error) {
    console.error('❌ Error en el endpoint de consulta de workflows:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al consultar workflows'
        } 
      },
      { status: 500 }
    );
  }
}

/**
 * Método POST para obtener información sobre el endpoint
 */
export async function POST() {
  return NextResponse.json({
    name: 'Workflow Logs API',
    description: 'Consulta workflows de Temporal filtrados por site_id',
    methods: ['GET'],
    requiredParams: {
      site_id: 'string - ID del sitio (requerido)'
    },
    optionalParams: {
      limit: 'number - Número de workflows a retornar (1-100, default: 20)',
      pageToken: 'string - Token para paginación (opcional)'
    },
    responseFormat: {
      success: 'boolean - Indica si la consulta fue exitosa',
      workflows: 'Array<WorkflowInfo> - Lista de workflows encontrados',
      pagination: 'PaginationInfo - Información de paginación',
      meta: 'MetaInfo - Metadatos de la consulta'
    },
    workflowInfo: {
      workflowId: 'string - ID único del workflow',
      runId: 'string - ID de la ejecución',
      type: 'string - Tipo de workflow',
      status: 'string - Estado actual del workflow',
      startTime: 'string - Fecha de inicio (ISO 8601)',
      closeTime: 'string - Fecha de finalización (ISO 8601, opcional)',
      executionTime: 'number - Tiempo de ejecución en ms (opcional)',
      input: 'any - Argumentos de entrada del workflow',
      result: 'any - Resultado del workflow (si completado)',
      failure: 'any - Detalles del error (si falló)'
    },
    paginationInfo: {
      limit: 'number - Límite de resultados por página',
      nextPageToken: 'string - Token para la siguiente página (opcional)',
      hasMore: 'boolean - Indica si hay más resultados'
    },
    examples: {
      basic: 'GET /api/logs/workflows?site_id=test-site-123',
      withLimit: 'GET /api/logs/workflows?site_id=test-site-123&limit=10',
      withPagination: 'GET /api/logs/workflows?site_id=test-site-123&limit=5&pageToken=eyJ...'
    },
    notes: [
      'Requiere que los workflows tengan el atributo de búsqueda site_id configurado',
      'Los workflows existentes sin search attributes no aparecerán en los resultados',
      'Para desarrollo local, asegúrate de que Temporal tenga configurado el atributo site_id',
      'La paginación permite consultar grandes cantidades de workflows de forma eficiente'
    ]
  });
}
