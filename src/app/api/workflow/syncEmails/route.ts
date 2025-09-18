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

    // Función para calcular fecha "since" con progresión automática
    const calculateOptimalSinceDate = (hoursBack: number = 24): string => {
      return new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    };

    // Empezar con 24 horas, pero permitir ampliación si es necesario
    let since = calculateOptimalSinceDate(24);
    let hoursBack = 24;

    console.log(`📝 Ejecutando workflow para site_id: ${site_id}, user_id: ${user_id}, since: ${since} (${hoursBack}h atrás)`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Configuración de retry para asegurar emails suficientes
    const MIN_EMAILS_FOR_ANALYSIS = 3; // Mínimo de emails válidos para análisis
    const MAX_RETRY_ATTEMPTS = 1;
    const HOUR_PROGRESSIONS = [24, 48, 168]; // 24h, 48h (2 días), 168h (1 semana)
    
    let result: any = null;
    let attempt = 0;
    let finalWorkflowId = '';

    // Retry loop para asegurar suficientes emails
    while (attempt < MAX_RETRY_ATTEMPTS) {
      attempt++;
      hoursBack = HOUR_PROGRESSIONS[attempt - 1] || HOUR_PROGRESSIONS[HOUR_PROGRESSIONS.length - 1];
      since = calculateOptimalSinceDate(hoursBack);

      console.log(`🔄 Intento ${attempt}/${MAX_RETRY_ATTEMPTS}: Buscando emails desde ${hoursBack}h atrás (${since})`);

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
        retryAttempts: 1, // Solo 1 intento por cada iteración de nuestro loop
        taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
        workflowId: `sync-emails-${site_id}-${user_id}-${Date.now()}-${attempt}-${Math.random().toString(36).substr(2, 9)}`
      };

      finalWorkflowId = workflowOptions.workflowId!;
      console.log(`🔄 Iniciando workflow (intento ${attempt}) con ID: ${finalWorkflowId}`);

      // Ejecutar el workflow específico para sincronizar emails
      result = await workflowService.executeWorkflow(
        'syncEmailsWorkflow',
        workflowArgs,
        workflowOptions
      );

      if (!result.success) {
        console.error(`❌ Error en workflow intento ${attempt}:`, result.error);
        if (attempt >= MAX_RETRY_ATTEMPTS) {
          break; // Salir si es el último intento
        }
        console.log(`🔄 Reintentando con rango de tiempo más amplio...`);
        continue;
      }

      // Verificar si tenemos suficientes emails válidos para análisis
      const analysisResult = result.data?.analysisResult;
      const validEmailCount = analysisResult?.emailCount || 0;

      console.log(`📊 Intento ${attempt}: ${validEmailCount} emails válidos encontrados (mínimo requerido: ${MIN_EMAILS_FOR_ANALYSIS})`);

      if (validEmailCount >= MIN_EMAILS_FOR_ANALYSIS) {
        console.log(`✅ Suficientes emails encontrados en intento ${attempt}. Procediendo con análisis.`);
        break; // Tenemos suficientes emails, salir del loop
      } else if (attempt >= MAX_RETRY_ATTEMPTS) {
        console.log(`⚠️ Alcanzado máximo de intentos. Procediendo con ${validEmailCount} emails encontrados.`);
        break; // Último intento, continuar con lo que tenemos
      } else {
        console.log(`📈 Insuficientes emails (${validEmailCount}/${MIN_EMAILS_FOR_ANALYSIS}). Ampliando rango de búsqueda para intento ${attempt + 1}...`);
        // Continuar al siguiente intento con rango más amplio
      }
    }

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow después de todos los intentos:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow después de múltiples intentos'
          },
          retryInfo: {
            attempts: attempt,
            maxAttempts: MAX_RETRY_ATTEMPTS,
            hoursRangesTried: HOUR_PROGRESSIONS.slice(0, attempt),
            finalSinceDate: since
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow ejecutado exitosamente');
    console.log('📊 Resultado final del workflow:', result);
    
    // Calcular estadísticas del retry
    const analysisResult = result.data?.analysisResult;
    const finalValidEmailCount = analysisResult?.emailCount || 0;

    // Respuesta exitosa con información de retry
    return NextResponse.json(
      { 
        success: true, 
        data: {
          site_id,
          user_id,
          since, // Fecha final utilizada (última iteración exitosa)
          analysisLimit: 20,
          workflowId: finalWorkflowId,
          executionId: result.executionId,
          runId: result.runId,
          status: result.status,
          result: result.data,
          retryInfo: {
            attempts: attempt,
            maxAttempts: MAX_RETRY_ATTEMPTS,
            finalHoursBack: hoursBack,
            finalValidEmailCount: finalValidEmailCount,
            minRequiredEmails: MIN_EMAILS_FOR_ANALYSIS,
            wasRetrySuccessful: finalValidEmailCount >= MIN_EMAILS_FOR_ANALYSIS,
            hoursProgression: HOUR_PROGRESSIONS.slice(0, attempt)
          }
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