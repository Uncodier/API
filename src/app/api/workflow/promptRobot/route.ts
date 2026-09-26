import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';
import { robotSkillSelectionSchema, resolveRobotSkills } from '@/lib/services/workflow/robot-skill-selection';
import { supabaseAdmin } from '@/lib/database/supabase-client';

interface PromptRobotWorkflowArgs {
  instance_id: string;
  message: string;
  step_status: string;
  site_id: string;
  context: string;
  activity: string;
  skill_slugs?: string[];
  skill_mode?: 'auto' | 'required';
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow promptRobotWorkflow en Temporal
 * POST /api/workflow/promptRobot
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🤖 Iniciando ejecución del workflow promptRobotWorkflow');

    // Extraer y validar parámetros del cuerpo de la petición
    const body = await request.json();
    const { instance_id, message, step_status, site_id, context, activity } = body;

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

    if (!message || typeof message !== 'string') {
      console.error('❌ message requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_MESSAGE', 
            message: 'message es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    if (!step_status || typeof step_status !== 'string') {
      console.error('❌ step_status requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_STEP_STATUS', 
            message: 'step_status es requerido y debe ser una cadena válida' 
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

    // The workflow resumes the instance before calling /instance/act: enforce tenant ownership here.
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances').select('site_id').eq('id', instance_id).single();
    if (instanceError || !instance || instance.site_id !== site_id) {
      return NextResponse.json({ success: false, error: { code: 'INVALID_INSTANCE_SITE', message: 'Instance does not belong to this site' } }, { status: 400 });
    }

    if (!context || typeof context !== 'string') {
      console.error('❌ context requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_CONTEXT', 
            message: 'context es requerido y debe ser una cadena válida' 
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

    const selection = robotSkillSelectionSchema.safeParse(body);
    if (!selection.success) {
      return NextResponse.json({ success: false, error: { code: 'INVALID_SKILL_SELECTION', message: 'Invalid skill_mode or skill_slugs' } }, { status: 400 });
    }
    try {
      await resolveRobotSkills(site_id, selection.data);
    } catch {
      return NextResponse.json({ success: false, error: { code: 'INVALID_SKILL_SELECTION', message: 'Selected skill is not available for this site' } }, { status: 400 });
    }

    console.log(`🤖 Ejecutando workflow Prompt Robot para instancia: ${instance_id}`);
    console.log(`💬 Mensaje: ${message}`);
    console.log(`📊 Estado del paso: ${step_status}`);
    console.log(`🏢 Site ID: ${site_id}`);
    console.log(`📝 Contexto: ${context}`);
    console.log(`🎯 Actividad: ${activity}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: PromptRobotWorkflowArgs = {
      instance_id,
      message,
      step_status,
      site_id,
      context,
      activity,
      skill_mode: selection.data.skill_mode,
      skill_slugs: selection.data.skill_slugs
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Los robots tienen alta prioridad
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `prompt-robot-${instance_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow Prompt Robot con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para prompt robot
    const result = await workflowService.promptRobot(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow Prompt Robot:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow Prompt Robot'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow Prompt Robot ejecutado exitosamente');

    // Retornar directamente la respuesta del workflow
    return NextResponse.json(result.data, { status: 200 });

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow promptRobot:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow Prompt Robot'
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
    name: 'promptRobotWorkflow API',
    description: 'Ejecuta el workflow promptRobotWorkflow en Temporal para procesar mensajes de robots automatizados',
    methods: ['POST'],
    requiredParams: {
      instance_id: 'string - UUID de la instancia del robot (requerido)',
      message: 'string - Mensaje o comando para el robot (requerido)',
      step_status: 'string - Estado del paso actual (requerido)',
      site_id: 'string - UUID del sitio (requerido)',
      context: 'string - Contexto de la operación (requerido)',
      activity: 'string - Actividad específica a realizar (requerido)'
    },
    stepStatusOptions: [
      'pending',
      'in_progress',
      'completed',
      'failed',
      'cancelled'
    ],
    example: {
      instance_id: '123e4567-e89b-12d3-a456-426614174000',
      message: 'navega a linkedin y busca posts de Santiago Zavala',
      step_status: 'pending',
      site_id: 'site_123',
      context: 'Usuario quiere interactuar en LinkedIn',
      activity: 'linkedin_search'
    }
  });
}
