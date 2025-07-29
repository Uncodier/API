import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface KeyAccountGenerationWorkflowArgs {
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
 * API endpoint para ejecutar el workflow dailyStrategicAccountsWorkflow en Temporal
 * POST /api/workflow/keyAccountGeneration
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow dailyStrategicAccountsWorkflow');

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

    console.log(`📝 Ejecutando workflow de generación de cuentas estratégicas para site_id: ${site_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: KeyAccountGenerationWorkflowArgs = {
      site_id
    };

    // Opciones de ejecución del workflow (asíncrono para retornar inmediatamente)
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high',
      async: true, // Retorna tan pronto como el workflow es aceptado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `key-account-generation-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow de generación de cuentas estratégicas con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para generación de cuentas estratégicas
    const result = await workflowService.dailyStrategicAccountsWorkflow(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow de generación de cuentas estratégicas:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow de generación de cuentas estratégicas'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow de generación de cuentas estratégicas iniciado exitosamente');
    console.log('📊 Información del workflow iniciado:', result);

    // Respuesta exitosa - workflow aceptado y en ejecución
    return NextResponse.json(
      { 
        success: true, 
        message: 'Workflow de generación de cuentas estratégicas iniciado correctamente',
        data: {
          site_id,
          workflowId: result.workflowId,
          executionId: result.executionId,
          runId: result.runId,
          status: result.status || 'running'
        }
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow keyAccountGeneration:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow de generación de cuentas estratégicas'
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
    name: 'keyAccountGeneration API',
    description: 'Ejecuta el workflow dailyStrategicAccountsWorkflow en Temporal para generación de cuentas estratégicas',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio para la generación de cuentas estratégicas'
    },
    example: {
      site_id: 'site_12345'
    },
    note: 'Retorna 200 tan pronto como el workflow es aceptado por Temporal, no espera a que termine'
  });
} 