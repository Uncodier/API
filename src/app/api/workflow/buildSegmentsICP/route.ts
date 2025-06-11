import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface BuildSegmentsICPWorkflowArgs {
  site_id: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow buildSegmentsICPWorkflow en Temporal
 * POST /api/workflow/buildSegmentsICP
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow buildSegmentsICPWorkflow');

    // Validar y extraer site_id del cuerpo de la petición
    const body = await request.json();
    const { site_id } = body;

    // Validación del site_id
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

    console.log(`📝 Ejecutando workflow ICP para site_id: ${site_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: BuildSegmentsICPWorkflowArgs = {
      site_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'medium',
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `build-segments-icp-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow ICP con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para construir segmentos con ICP
    const result = await workflowService.buildSegmentsICP(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow ICP:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow ICP'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow ICP ejecutado exitosamente');
    console.log('📊 Resultado del workflow ICP:', result);

    // Respuesta exitosa
    return NextResponse.json(
      { 
        success: true, 
        data: {
          site_id,
          workflowId: result.workflowId,
          executionId: result.executionId,
          runId: result.runId,
          status: result.status,
          result: result.data
        }
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow buildSegmentsICP:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow ICP'
        } 
      },
      { status: 500 }
    );
  }
}

/**
 * Método GET para obtener información sobre el endpoint
 */
export async function GET() {
  return NextResponse.json({
    name: 'buildSegmentsICPWorkflow API',
    description: 'Ejecuta el workflow buildSegmentsICPWorkflow en Temporal para análisis ICP de segmentos',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio para el cual construir segmentos con análisis ICP'
    },
    example: {
      site_id: 'site_12345'
    }
  });
} 