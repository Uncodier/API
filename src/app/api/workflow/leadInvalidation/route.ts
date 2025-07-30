import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface LeadInvalidationRequestArgs {
  lead_id: string;                    // ✅ REQUERIDO: ID del lead a invalidar
  site_id: string;                    // ✅ REQUERIDO: ID del sitio
  reason?: 'whatsapp_failed' | 'email_failed' | 'invalid_contact'; // 📋 OPCIONAL: Motivo (default: 'invalid_contact')
  telephone?: string;                 // 📞 OPCIONAL: Teléfono que falló
  email?: string;                     // 📧 OPCIONAL: Email que falló
  userId?: string;                    // 👤 OPCIONAL: ID del usuario
  additionalData?: any;               // 📋 OPCIONAL: Datos adicionales
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * Mapea los tipos de reason del usuario a los tipos del workflow
 */
function mapReasonToWorkflowReason(reason?: LeadInvalidationRequestArgs['reason']): 'email_bounce' | 'invalid_email' | 'manual_invalidation' {
  // Si no se proporciona reason, usar 'invalid_contact' como default
  const defaultReason = reason || 'invalid_contact';
  
  const reasonMap: Record<NonNullable<LeadInvalidationRequestArgs['reason']>, 'email_bounce' | 'invalid_email' | 'manual_invalidation'> = {
    'email_failed': 'email_bounce',
    'whatsapp_failed': 'manual_invalidation',
    'invalid_contact': 'invalid_email'
  };
  
  return reasonMap[defaultReason];
}

/**
 * API endpoint para ejecutar el workflow leadInvalidationWorkflow en Temporal
 * POST /api/workflow/leadInvalidation
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow leadInvalidationWorkflow');

    // Validar y extraer parámetros del cuerpo de la petición
    const body: LeadInvalidationRequestArgs = await request.json();
    const { lead_id, site_id, reason, telephone, email, userId, additionalData } = body;

    // Validación del lead_id
    if (!lead_id || typeof lead_id !== 'string') {
      console.error('❌ lead_id requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_LEAD_ID', 
            message: 'lead_id es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

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

    // Validación del reason - ahora opcional con valor por defecto
    const workflowReason = reason || 'invalid_contact';
    if (!['whatsapp_failed', 'email_failed', 'invalid_contact'].includes(workflowReason)) {
      console.error('❌ reason debe ser uno de: whatsapp_failed, email_failed, invalid_contact');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REASON', 
            message: 'reason debe ser uno de: whatsapp_failed, email_failed, invalid_contact' 
          } 
        },
        { status: 400 }
      );
    }

    // Determinar el email a usar
    let workflowEmail = email;
    if (!workflowEmail) {
      // Si no se proporciona email, usar un placeholder basado en el tipo de invalidación
      if (workflowReason === 'email_failed') {
        console.error('❌ email es requerido cuando reason es email_failed');
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'EMAIL_REQUIRED', 
              message: 'email es requerido cuando reason es email_failed' 
            } 
          },
          { status: 400 }
        );
      }
      // Para otros tipos de invalidación, usar un placeholder
      workflowEmail = `invalid-contact-${lead_id}@placeholder.local`;
    }

    console.log(`📝 Ejecutando workflow de invalidación de lead para lead_id: ${lead_id}, site_id: ${site_id}, reason: ${workflowReason}`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Mapear el reason del usuario al reason del workflow
    const mappedWorkflowReason = mapReasonToWorkflowReason(workflowReason);

    // Preparar argumentos para el workflow adaptando al formato esperado
    const workflowArgs = {
      lead_id,
      email: workflowEmail,
      site_id,
      reason: mappedWorkflowReason,
      // Adaptar bounce_details si es necesario
      bounce_details: workflowReason === 'email_failed' && additionalData?.bounce_details ? {
        bounce_email_id: additionalData.bounce_details.bounce_email_id || `bounce-${Date.now()}`,
        bounce_subject: additionalData.bounce_details.bounce_subject,
        bounce_from: additionalData.bounce_details.bounce_from,
        bounce_date: additionalData.bounce_details.bounce_date || new Date().toISOString(),
        bounce_message: additionalData.bounce_details.bounce_message
      } : undefined,
      // Adaptar metadata
      metadata: {
        invalidated_by: userId,
        user_id: userId,
        additional_info: {
          original_reason: workflowReason,
          telephone: telephone,
          additionalData: additionalData
        }
      }
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Alta prioridad para invalidaciones
      async: true, // No esperamos el resultado, ejecutar de forma asíncrona
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `lead-invalidation-${site_id}-${lead_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow de invalidación de lead con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow de invalidación de lead
    const result = await workflowService.leadInvalidation(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error al iniciar el workflow de invalidación de lead:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_START_ERROR',
            message: result.error?.message || 'Error al iniciar el workflow de invalidación de lead'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow de invalidación de lead iniciado exitosamente');
    console.log('📊 Información del workflow iniciado:', result);

    // Respuesta exitosa - workflow iniciado correctamente
    return NextResponse.json(
      { 
        success: true, 
        message: 'Workflow de invalidación de lead iniciado correctamente',
        data: {
          lead_id,
          site_id,
          reason: workflowReason,
          workflowReason: mappedWorkflowReason,
          email: workflowEmail,
          telephone,
          userId,
          workflowId: result.workflowId,
          executionId: result.executionId,
          runId: result.runId,
          status: 'RUNNING',
          startedAt: new Date().toISOString(),
          estimated_duration: '5-10 minutos aproximadamente'
        }
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow leadInvalidation:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow de invalidación de lead'
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
    name: 'leadInvalidationWorkflow API',
    description: 'Ejecuta el workflow leadInvalidationWorkflow en Temporal para invalidar leads',
    methods: ['POST'],
    requiredParams: {
      lead_id: 'string - ID del lead a invalidar',
      site_id: 'string - ID del sitio'
    },
    optionalParams: {
      reason: 'whatsapp_failed | email_failed | invalid_contact - Motivo de la invalidación (default: invalid_contact)',
      telephone: 'string - Teléfono que falló (opcional)',
      email: 'string - Email que falló (requerido solo para email_failed)',
      userId: 'string - ID del usuario que invalida (opcional)',
      additionalData: 'any - Datos adicionales (opcional)'
    },
    reasonMapping: {
      'email_failed': 'email_bounce',
      'whatsapp_failed': 'manual_invalidation', 
      'invalid_contact': 'invalid_email'
    },
    example: {
      lead_id: 'lead_12345',
      site_id: 'site_67890',
      reason: 'email_failed', // Opcional
      email: 'invalid@example.com',
      userId: 'user_123',
      additionalData: {
        bounce_details: {
          bounce_email_id: 'bounce_456',
          bounce_message: 'Email address not found'
        }
      }
    }
  });
}