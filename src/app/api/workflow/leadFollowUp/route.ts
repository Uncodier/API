import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface LeadFollowUpWorkflowArgs {
  site_id: string;
  lead_id: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow leadFollowUpWorkflow en Temporal
 * POST /api/workflow/leadFollowUp
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow leadFollowUpWorkflow');

    // Validar y extraer site_id y lead_id del cuerpo de la petición
    const body = await request.json();
    const { site_id, lead_id } = body;

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

    // Validación del lead_id
    if (!lead_id || typeof lead_id !== 'string') {
      console.error('❌ lead_id requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_LEAD_ID', 
            message: 'lead_id es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    console.log(`📝 Ejecutando workflow de seguimiento de lead para site_id: ${site_id}, lead_id: ${lead_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: LeadFollowUpWorkflowArgs = {
      site_id,
      lead_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'medium',
      async: true, // No esperamos el resultado, ejecutar de forma asíncrona
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `lead-follow-up-${site_id}-${lead_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow de seguimiento de lead con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para seguimiento de leads de forma asíncrona
    const result = await workflowService.leadFollowUp(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error al iniciar el workflow de seguimiento de lead:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_START_ERROR',
            message: result.error?.message || 'Error al iniciar el workflow de seguimiento de lead'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow de seguimiento de lead iniciado exitosamente');
    console.log('📊 Información del workflow iniciado:', result);

    // Respuesta exitosa - workflow iniciado correctamente
    return NextResponse.json(
      { 
        success: true, 
        message: 'Workflow de seguimiento de lead iniciado correctamente',
        data: {
          site_id,
          lead_id,
          workflowId: result.workflowId,
          executionId: result.executionId,
          runId: result.runId,
          status: 'RUNNING',
          startedAt: new Date().toISOString(),
          estimated_duration: '2 horas aproximadamente'
        }
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow leadFollowUp:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow de seguimiento de lead'
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
    name: 'leadFollowUpWorkflow API',
    description: 'Ejecuta el workflow leadFollowUpWorkflow en Temporal para seguimiento de leads',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio para el seguimiento de lead',
      lead_id: 'string - ID del lead a seguir'
    },
    example: {
      site_id: 'site_12345',
      lead_id: 'lead_67890'
    }
  });
} 