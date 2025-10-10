import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface StartRobotWorkflowArgs {
  site_id: string;
  activity: string;
  user_id?: string;
  instance_id?: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow startRobotWorkflow en Temporal
 * POST /api/workflow/startRobot
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🤖 Iniciando ejecución del workflow startRobotWorkflow');

    // Extraer y validar parámetros del cuerpo de la petición
    const body = await request.json();
    const { site_id, activity, user_id, instance_id } = body;

    // Validación de parámetros requeridos
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

    if (!activity || typeof activity !== 'string') {
      console.error('❌ activity requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_ACTIVITY', 
            message: 'activity es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    console.log(`🤖 Ejecutando workflow Start Robot para sitio: ${site_id}`);
    console.log(`⚙️ Actividad: ${activity}`);
    if (user_id) {
      console.log(`👤 Usuario: ${user_id}`);
    }
    if (instance_id) {
      console.log(`🆔 Instance ID: ${instance_id}`);
    }

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: StartRobotWorkflowArgs = {
      site_id,
      activity,
      user_id,
      instance_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Los robots tienen alta prioridad
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `start-robot-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow Start Robot con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para start robot
    const result = await workflowService.startRobot(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow Start Robot:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow Start Robot'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow Start Robot ejecutado exitosamente');

    // Retornar directamente la respuesta del workflow
    return NextResponse.json(result.data, { status: 200 });

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow startRobot:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow Start Robot'
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
    name: 'startRobotWorkflow API',
    description: 'Ejecuta el workflow startRobotWorkflow en Temporal para inicializar robots automatizados',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - UUID del sitio (requerido)',
      activity: 'string - Tipo de actividad para el robot (requerido)'
    },
    optionalParams: {
      user_id: 'string - UUID del usuario que solicita el robot (opcional)',
      instance_id: 'string - ID de instancia preexistente a asociar (opcional)'
    },
    robotTypes: {
      'sales-bot': 'Robot especializado en procesos de ventas',
      'support-bot': 'Robot para soporte al cliente',
      'marketing-bot': 'Robot para campañas de marketing',
      'general-bot': 'Robot de propósito general'
    },
    activityExamples: [
      'sales-lead-qualification',
      'support-ticket-routing', 
      'marketing-campaign-automation',
      'customer-onboarding',
      'data-analysis'
    ],
    example: {
      site_id: 'site_12345',
      activity: 'sales-lead-qualification',
      user_id: 'user_67890',
      instance_id: 'instance_abc123'
    }
  });
}