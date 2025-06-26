import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface DailyStandUpWorkflowArgs {
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
 * API endpoint para ejecutar el workflow dailyStandUpWorkflow en Temporal
 * POST /api/workflow/dailyStandUp
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow dailyStandUpWorkflow');

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

    console.log(`📝 Ejecutando daily standup workflow para site_id: ${site_id}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: DailyStandUpWorkflowArgs = {
      site_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Alta prioridad para daily standup
      async: false, // Esperamos el resultado completo
      retryAttempts: 3, // Consistente con otras rutas
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `daily-standup-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando daily standup workflow con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para daily standup
    const result = await workflowService.dailyStandUp(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del daily standup workflow:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow de daily standup'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Daily standup workflow ejecutado exitosamente');
    console.log('📊 Resultado del workflow:', result);

    // Respuesta exitosa con estructura estándar
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
    console.error('❌ Error en el endpoint del workflow dailyStandUp:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow de daily standup'
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
    name: 'dailyStandUpWorkflow API',
    description: 'Ejecuta el workflow completo de daily standup del CMO que analiza system, sales, support, growth y genera un resumen ejecutivo',
    workflow_name: 'dailyStandUpWorkflow',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - ID del sitio para el cual ejecutar el daily standup'
    },
    workflow_steps: [
      '1. System Analysis - Configuración, billing y métricas del sistema',
      '2. Sales Analysis - Leads, comandos de ventas y conversaciones',  
      '3. Support Analysis - Tareas abiertas, conversaciones y requerimientos',
      '4. Growth Analysis - Contenido, experimentos y campañas',
      '5. Executive Summary - Consolidación de todos los análisis'
    ],
    example: {
      site_id: 'site_12345'
    }
  });
} 