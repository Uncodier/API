import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface StopRobotWorkflowArgs {
  instance_id: string;
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
 * API endpoint para ejecutar el workflow stopRobotWorkflow en Temporal
 * POST /api/workflow/stopRobot
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🛑 Iniciando ejecución del workflow stopRobotWorkflow');

    // Extraer y validar parámetros del cuerpo de la petición
    const body = await request.json();
    const { instance_id, site_id } = body;

    // Validación de parámetros requeridos
    if (!instance_id || typeof instance_id !== 'string') {
      console.error('❌ instance_id requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_INSTANCE_ID', 
            message: 'instance_id es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

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

    console.log(`🛑 Ejecutando workflow Stop Robot para instancia: ${instance_id}`);
    console.log(`🏢 Site ID: ${site_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: StopRobotWorkflowArgs = {
      instance_id,
      site_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Los robots tienen alta prioridad
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: 'high', // Same queue as customerSupport for fast execution
      workflowId: `stop-robot-${instance_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow Stop Robot con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para stop robot
    const result = await workflowService.stopRobot(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow Stop Robot:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow Stop Robot'
          } 
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow Stop Robot ejecutado exitosamente');

    // Retornar directamente la respuesta del workflow
    return NextResponse.json(result.data, { status: 200 });

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow stopRobot:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow Stop Robot'
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
    name: 'stopRobotWorkflow API',
    description: 'Ejecuta el workflow stopRobotWorkflow en Temporal para detener robots automatizados',
    methods: ['POST'],
    requiredParams: {
      instance_id: 'string - UUID de la instancia del robot a detener (requerido)',
      site_id: 'string - UUID del sitio (requerido)'
    },
    example: {
      instance_id: '123e4567-e89b-12d3-a456-426614174000',
      site_id: 'site_12345'
    }
  });
}

