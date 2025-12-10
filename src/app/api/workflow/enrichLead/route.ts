import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface EnrichLeadWorkflowArgs {
  linkedin_profile?: string;
  person_id?: string;
  site_id: string;
  userId?: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow enrichLeadWorkflow en Temporal
 * POST /api/workflow/enrichLead
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow enrichLeadWorkflow');

    // Validar y extraer parámetros del cuerpo de la petición
    const body = await request.json();
    const { linkedin_profile, person_id, site_id, userId } = body;

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

    // Validación: al menos uno de linkedin_profile o person_id debe estar presente
    if (!linkedin_profile && !person_id) {
      console.error('❌ Se requiere al menos linkedin_profile o person_id');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_ARGUMENTS', 
            message: 'Se requiere al menos linkedin_profile o person_id para enriquecer el lead' 
          } 
        },
        { status: 400 }
      );
    }

    // Validación de tipos si están presentes
    if (linkedin_profile && typeof linkedin_profile !== 'string') {
      console.error('❌ linkedin_profile debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_LINKEDIN_PROFILE', 
            message: 'linkedin_profile debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    if (person_id && typeof person_id !== 'string') {
      console.error('❌ person_id debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_PERSON_ID', 
            message: 'person_id debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    if (userId && typeof userId !== 'string') {
      console.error('❌ userId debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_USER_ID', 
            message: 'userId debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    console.log(`📝 Ejecutando workflow de enriquecimiento de lead para site_id: ${site_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: EnrichLeadWorkflowArgs = {
      site_id,
      ...(linkedin_profile && { linkedin_profile }),
      ...(person_id && { person_id }),
      ...(userId && { userId })
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'medium',
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `enrich-lead-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow de enriquecimiento de lead con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para enriquecimiento de lead
    const result = await workflowService.enrichLead(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow de enriquecimiento de lead:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow de enriquecimiento de lead'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow de enriquecimiento de lead ejecutado exitosamente');
    console.log('📊 Resultado del workflow de enriquecimiento de lead:', result);

    // Respuesta exitosa
    return NextResponse.json(
      { 
        success: true, 
        data: {
          site_id,
          linkedin_profile,
          person_id,
          userId,
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
    console.error('❌ Error en el endpoint del workflow enrichLead:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow de enriquecimiento de lead'
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
    name: 'enrichLeadWorkflow API',
    description: 'Ejecuta el workflow enrichLeadWorkflow en Temporal para enriquecimiento de leads',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio (requerido)',
      linkedin_profile: 'string - URL del perfil de LinkedIn (al menos uno requerido junto con person_id)',
      person_id: 'string - ID de la persona (al menos uno requerido junto con linkedin_profile)'
    },
    optionalParams: {
      userId: 'string - ID del usuario'
    },
    example: {
      site_id: 'site_12345',
      linkedin_profile: 'https://linkedin.com/in/example',
      userId: 'user_123'
    }
  });
}
















