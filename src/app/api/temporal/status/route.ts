import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

/**
 * GET /api/temporal/status
 * 
 * Endpoint para verificar el estado y configuración de Temporal
 */
export async function GET(request: NextRequest) {
  console.log('[API:temporal/status] GET request received');
  
  try {
    const workflowService = WorkflowService.getInstance();
    
    // Obtener información de configuración
    const configReport = workflowService.getConfigurationReport();
    const autoDetectedConfig = workflowService.getAutoDetectedConfiguration();
    
    console.log('[API:temporal/status] Configuración obtenida:', JSON.stringify(configReport, null, 2));
    
    // Intentar conexión (opcional)
    const testQuery = request.nextUrl.searchParams.get('test');
    let connectionTest = null;
    
    if (testQuery === 'true') {
      console.log('[API:temporal/status] Probando conexión...');
      connectionTest = await workflowService.testConnection();
      console.log('[API:temporal/status] Resultado de conexión:', connectionTest);
    }
    
    return NextResponse.json({
      status: 'operational',
      service: 'Temporal Workflow Service',
      timestamp: new Date().toISOString(),
      configuration: configReport,
      autoDetected: autoDetectedConfig,
      connectionTest,
      documentation: {
        environmentVariables: {
          TEMPORAL_ENV: 'Entorno de Temporal (development=auto config localhost)',
          TEMPORAL_SERVER_URL: 'URL del servidor Temporal (default: localhost:7233)',
          TEMPORAL_NAMESPACE: 'Namespace de Temporal (default: default)',
          TEMPORAL_CLOUD_API_KEY: 'API Key para Temporal Cloud (solo cloud)',
          WORKFLOW_TASK_QUEUE: 'Cola de tareas por defecto (default: default)'
        },
        examples: {
          development: {
            TEMPORAL_ENV: 'development',
            description: 'Configura automáticamente localhost:7233 con namespace default. Ignora otras configuraciones.'
          },
          local: {
            TEMPORAL_SERVER_URL: 'localhost:7233',
            TEMPORAL_NAMESPACE: 'default'
          },
          cloud: {
            TEMPORAL_SERVER_URL: 'your-namespace.tmprl.cloud:7233',
            TEMPORAL_NAMESPACE: 'your-namespace',
            TEMPORAL_CLOUD_API_KEY: 'your-api-key'
          },
          custom: {
            TEMPORAL_SERVER_URL: 'temporal.your-domain.com:7233',
            TEMPORAL_NAMESPACE: 'your-namespace'
          }
        }
      }
    }, { status: 200 });
    
  } catch (error: any) {
    console.error('[API:temporal/status] Error:', error);
    
    return NextResponse.json({
      status: 'error',
      service: 'Temporal Workflow Service',
      timestamp: new Date().toISOString(),
      error: {
        code: 'TEMPORAL_STATUS_ERROR',
        message: error.message || 'Error al obtener estado de Temporal',
        details: error.stack
      }
    }, { status: 500 });
  }
}

/**
 * POST /api/temporal/status/test
 * 
 * Endpoint para probar la conexión con Temporal
 */
export async function POST(request: NextRequest) {
  console.log('[API:temporal/status] POST request received - testing connection');
  
  try {
    const workflowService = WorkflowService.getInstance();
    
    // Probar conexión
    const connectionTest = await workflowService.testConnection();
    console.log('[API:temporal/status] Resultado de prueba de conexión:', connectionTest);
    
    if (connectionTest.success) {
      return NextResponse.json({
        success: true,
        message: 'Conexión con Temporal exitosa',
        timestamp: new Date().toISOString(),
        config: connectionTest.config
      }, { status: 200 });
    } else {
      return NextResponse.json({
        success: false,
        message: 'Error al conectar con Temporal',
        timestamp: new Date().toISOString(),
        error: connectionTest.error,
        config: connectionTest.config
      }, { status: 503 });
    }
    
  } catch (error: any) {
    console.error('[API:temporal/status] Error en prueba de conexión:', error);
    
    return NextResponse.json({
      success: false,
      message: 'Error interno al probar conexión',
      timestamp: new Date().toISOString(),
      error: {
        code: 'CONNECTION_TEST_ERROR',
        message: error.message || 'Error desconocido',
        details: error.stack
      }
    }, { status: 500 });
  }
} 