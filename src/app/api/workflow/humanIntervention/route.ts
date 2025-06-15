import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface HumanInterventionWorkflowArgs {
  site_id: string;
  user_id: string;
  intervention_type: string;
  entity_id: string;
  entity_type: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  description?: string;
  metadata?: Record<string, any>;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow humanInterventionWorkflow en Temporal
 * POST /api/workflow/humanIntervention
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow humanInterventionWorkflow');

    // Validar y extraer parámetros del cuerpo de la petición
    const body = await request.json();
    const { 
      site_id, 
      user_id, 
      intervention_type, 
      entity_id, 
      entity_type, 
      priority = 'medium',
      description,
      metadata 
    } = body;

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

    // Validación del intervention_type
    if (!intervention_type || typeof intervention_type !== 'string') {
      console.error('❌ intervention_type requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_INTERVENTION_TYPE', 
            message: 'intervention_type es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    // Validación del entity_id
    if (!entity_id || typeof entity_id !== 'string') {
      console.error('❌ entity_id requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_ENTITY_ID', 
            message: 'entity_id es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    // Validación del entity_type
    if (!entity_type || typeof entity_type !== 'string') {
      console.error('❌ entity_type requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_ENTITY_TYPE', 
            message: 'entity_type es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    // Validación de priority
    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (!validPriorities.includes(priority)) {
      console.error('❌ priority debe ser uno de: low, medium, high, critical');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_PRIORITY', 
            message: 'priority debe ser uno de: low, medium, high, critical' 
          } 
        },
        { status: 400 }
      );
    }

    console.log(`📝 Ejecutando workflow para site_id: ${site_id}, user_id: ${user_id}, intervention_type: ${intervention_type}, entity_id: ${entity_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: HumanInterventionWorkflowArgs = {
      site_id,
      user_id,
      intervention_type,
      entity_id,
      entity_type,
      priority,
      description,
      metadata
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: priority === 'critical' ? 'high' : priority,
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `human-intervention-${site_id}-${entity_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para intervención humana
    const result = await workflowService.executeWorkflow(
      'humanInterventionWorkflow',
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
          intervention_type,
          entity_id,
          entity_type,
          priority,
          description,
          metadata,
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
    console.error('❌ Error en el endpoint del workflow humanIntervention:', error);
    
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
    name: 'humanInterventionWorkflow API',
    description: 'Ejecuta el workflow humanInterventionWorkflow en Temporal',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio',
      user_id: 'string - ID del usuario',
      intervention_type: 'string - Tipo de intervención requerida',
      entity_id: 'string - ID de la entidad que requiere intervención',
      entity_type: 'string - Tipo de entidad (lead, campaign, workflow, etc.)'
    },
    optionalParams: {
      priority: 'string - Prioridad de la intervención (low, medium, high, critical) - default: medium',
      description: 'string - Descripción detallada de la intervención necesaria',
      metadata: 'object - Información adicional relacionada con la intervención'
    },
    example: {
      site_id: 'site_12345',
      user_id: 'user_67890',
      intervention_type: 'review_campaign',
      entity_id: 'campaign_abc123',
      entity_type: 'campaign',
      priority: 'high',
      description: 'Revisar campaña con resultados inesperados antes de continuar',
      metadata: {
        campaign_name: 'Q1 Lead Generation',
        current_status: 'paused',
        issue_type: 'performance'
      }
    }
  });
} 