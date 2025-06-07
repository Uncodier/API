import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface BuildContentWorkflowArgs {
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
 * Método OPTIONS para manejar preflight CORS
 */
export async function OPTIONS(request: NextRequest) {
  const requestId = Math.random().toString(36).substr(2, 9);
  console.log(`🔄 [${requestId}] Manejando petición OPTIONS preflight`);
  
  const origin = request.headers.get('origin') || '*';
  console.log(`🌐 [${requestId}] Origin: ${origin}`);
  
  const response = new NextResponse(null, { status: 204 });
  
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400');
  
  console.log(`✅ [${requestId}] Respuesta OPTIONS enviada`);
  return response;
}

/**
 * API endpoint para ejecutar el workflow buildContentWorkflow en Temporal
 * POST /api/workflow/buildContent
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  
  try {
    console.log(`🚀 [${requestId}] Iniciando ejecución del workflow buildContentWorkflow`);
    console.log(`📅 [${requestId}] Timestamp de inicio: ${new Date().toISOString()}`);
    console.log(`🌐 [${requestId}] URL de la petición: ${request.url}`);
    console.log(`📡 [${requestId}] Método: ${request.method}`);

    // Validar y extraer site_id del cuerpo de la petición
    console.log(`📋 [${requestId}] Parseando cuerpo de la petición...`);
    const body = await request.json();
    console.log(`📋 [${requestId}] Cuerpo recibido:`, body);
    
    const { site_id } = body;

    // Validación del site_id
    if (!site_id || typeof site_id !== 'string') {
      console.error(`❌ [${requestId}] site_id requerido y debe ser una cadena`);
      console.log(`📊 [${requestId}] Tiempo de procesamiento: ${Date.now() - startTime}ms`);
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

    console.log(`📝 [${requestId}] Ejecutando workflow para site_id: ${site_id}`);
    console.log(`🔧 [${requestId}] Obteniendo instancia del WorkflowService...`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();
    console.log(`✅ [${requestId}] WorkflowService obtenido exitosamente`);

    // Preparar argumentos para el workflow
    const workflowArgs: BuildContentWorkflowArgs = {
      site_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'medium',
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `build-content-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 [${requestId}] Iniciando workflow con ID: ${workflowOptions.workflowId}`);
    console.log(`⚙️ [${requestId}] Opciones del workflow:`, workflowOptions);
    console.log(`📦 [${requestId}] Argumentos del workflow:`, workflowArgs);

    const workflowStartTime = Date.now();
    console.log(`⏱️ [${requestId}] Iniciando ejecución del workflow...`);

    // Ejecutar el workflow específico para construir contenido
    const result = await workflowService.buildContent(
      workflowArgs,
      workflowOptions
    );

    const workflowExecutionTime = Date.now() - workflowStartTime;
    console.log(`⏱️ [${requestId}] Workflow completado en: ${workflowExecutionTime}ms`);

    if (!result.success) {
      console.error(`❌ [${requestId}] Error en la ejecución del workflow:`, result.error);
      console.log(`📊 [${requestId}] Tiempo total de procesamiento: ${Date.now() - startTime}ms`);
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

    console.log(`✅ [${requestId}] Workflow ejecutado exitosamente`);
    console.log(`📊 [${requestId}] Resultado del workflow:`, result);
    console.log(`🎯 [${requestId}] WorkflowId: ${result.workflowId}`);
    console.log(`🆔 [${requestId}] ExecutionId: ${result.executionId}`);
    console.log(`🏃 [${requestId}] RunId: ${result.runId}`);
    console.log(`📈 [${requestId}] Status: ${result.status}`);

    const totalProcessingTime = Date.now() - startTime;
    console.log(`📊 [${requestId}] Tiempo total de procesamiento: ${totalProcessingTime}ms`);
    console.log(`🏁 [${requestId}] Finalizando exitosamente - ${new Date().toISOString()}`);

    // Respuesta exitosa
    return NextResponse.json(
      { 
        success: true, 
        data: {
          site_id,
          workflowId: result.workflowId,
          executionId: result.executionId,
          runId: result.runId,
          status: result.status,
          result: result.data,
          processingTime: `${totalProcessingTime}ms`,
          workflowExecutionTime: `${workflowExecutionTime}ms`
        }
      },
      { status: 200 }
    );

  } catch (error) {
    const totalProcessingTime = Date.now() - startTime;
    console.error(`❌ [${requestId}] Error en el endpoint del workflow buildContent:`, error);
    console.error(`❌ [${requestId}] Stack trace:`, error instanceof Error ? error.stack : 'No stack trace available');
    console.log(`📊 [${requestId}] Tiempo de procesamiento antes del error: ${totalProcessingTime}ms`);
    console.log(`🏁 [${requestId}] Finalizando con error - ${new Date().toISOString()}`);
    
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
  const requestId = Math.random().toString(36).substr(2, 9);
  console.log(`ℹ️ [${requestId}] Solicitando información del endpoint buildContentWorkflow`);
  
  return NextResponse.json({
    name: 'buildContentWorkflow API',
    description: 'Ejecuta el workflow buildContentWorkflow en Temporal',
    methods: ['GET', 'POST', 'OPTIONS'],
    requiredParams: {
      site_id: 'string - ID del sitio para el cual construir contenido'
    },
    example: {
      site_id: 'site_12345'
    }
  });
} 