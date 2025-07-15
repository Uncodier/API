import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface AssignLeadsWorkflowArgs {
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
 * API endpoint para ejecutar el workflow assignLeadsWorkflow en Temporal
 * POST /api/workflow/assignLeads
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow assignLeadsWorkflow');

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

    console.log(`📝 Ejecutando workflow de asignación de leads para site_id: ${site_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: AssignLeadsWorkflowArgs = {
      site_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'medium',
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `assign-leads-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow de asignación de leads con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para asignación de leads
    const result = await workflowService.assignLeads(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow de asignación de leads:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow de asignación de leads'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow de asignación de leads ejecutado exitosamente');
    console.log('📊 Resultado del workflow de asignación de leads:', result);

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
    console.error('❌ Error en el endpoint del workflow assignLeads:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow de asignación de leads'
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
    name: 'assignLeadsWorkflow API',
    description: 'Ejecuta el workflow assignLeadsWorkflow en Temporal para asignación de leads',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio para la asignación de leads'
    },
    example: {
      site_id: 'site_12345'
    }
  });
} 