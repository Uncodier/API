import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface DeepResearchWorkflowArgs {
  site_id: string;
  research_topic: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow deepResearchWorkflow en Temporal
 * POST /api/workflow/deepResearch
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow deepResearchWorkflow');

    // Validar y extraer site_id y research_topic del cuerpo de la petición
    const body = await request.json();
    const { site_id, research_topic } = body;

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

    // Validación del research_topic
    if (!research_topic || typeof research_topic !== 'string') {
      console.error('❌ research_topic requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_RESEARCH_TOPIC', 
            message: 'research_topic es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

    console.log(`📝 Ejecutando workflow de investigación profunda para site_id: ${site_id}, research_topic: ${research_topic}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: DeepResearchWorkflowArgs = {
      site_id,
      research_topic
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'medium',
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `deep-research-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow de investigación profunda con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para investigación profunda usando el método genérico
    const result = await workflowService.executeWorkflow(
      'deepResearchWorkflow',
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow de investigación profunda:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow de investigación profunda'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow de investigación profunda ejecutado exitosamente');
    console.log('📊 Resultado del workflow de investigación profunda:', result);

    // Respuesta exitosa
    return NextResponse.json(
      { 
        success: true, 
        data: {
          site_id,
          research_topic,
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
    console.error('❌ Error en el endpoint del workflow deepResearch:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow de investigación profunda'
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
    name: 'deepResearchWorkflow API',
    description: 'Ejecuta el workflow deepResearchWorkflow en Temporal para investigación profunda',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio para la investigación profunda',
      research_topic: 'string - Tema de investigación a analizar'
    },
    example: {
      site_id: 'site_12345',
      research_topic: 'market trends for SaaS industry 2024'
    }
  });
} 