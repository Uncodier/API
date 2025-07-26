import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface SyncEmailsWorkflowArgs {
  site_id: string;
  user_id: string;
  since: string;
  analysisLimit: number;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow syncEmailsWorkflow en Temporal
 * POST /api/workflow/syncEmails
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow syncEmailsWorkflow');

    // Validar y extraer parámetros del cuerpo de la petición
    const body = await request.json();
    const { site_id, user_id } = body;

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

    // Validación del user_id
    if (!user_id || typeof user_id !== 'string') {
      console.error('❌ user_id requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_USER_ID', 
            message: 'user_id es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    // Calcular la fecha "since" (hace 6 horas para ser más permisivo)
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    console.log(`📝 Ejecutando workflow para site_id: ${site_id}, user_id: ${user_id}, since: ${since}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: SyncEmailsWorkflowArgs = {
      site_id,
      user_id,
      since,
      analysisLimit: 20
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'medium',
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `sync-emails-${site_id}-${user_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para sincronizar emails
    const result = await workflowService.executeWorkflow(
      'syncEmailsWorkflow',
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow ejecutado exitosamente');
    console.log('📊 Resultado del workflow:', result);

    // Respuesta exitosa
    return NextResponse.json(
      { 
        success: true, 
        data: {
          site_id,
          user_id,
          since,
          analysisLimit: 20,
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
    console.error('❌ Error en el endpoint del workflow syncEmails:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow'
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
    name: 'syncEmailsWorkflow API',
    description: 'Ejecuta el workflow syncEmailsWorkflow en Temporal',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio',
      user_id: 'string - ID del usuario'
    },
    automaticParams: {
      since: 'string - Fecha de hace una hora (ISO string)',
      analysisLimit: 'number - Límite de análisis (20)'
    },
    example: {
      site_id: 'site_12345',
      user_id: 'user_67890'
    }
  });
} 