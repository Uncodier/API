import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface CustomerSupportWorkflowArgs {
  conversationId?: string;
  userId?: string;
  message: string;
  agentId?: string;
  site_id?: string;
  lead_id?: string;
  visitor_id?: string;
  name?: string;
  email?: string;
  phone?: string;
  website_chat_origin?: boolean;
  lead_notification?: string;
  origin?: string;
  origin_message_id?: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow customerSupportWorkflow en Temporal
 * POST /api/workflow/customerSupport
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow customerSupportWorkflow');

    // Extraer y validar parámetros del cuerpo de la petición
    const body = await request.json();
    const { 
      conversationId, 
      userId, 
      message, 
      agentId, 
      site_id, 
      lead_id, 
      visitor_id,
      name,
      email,
      phone,
      website_chat_origin,
      lead_notification,
      origin,
      origin_message_id
    } = body;

    // Validación del mensaje (requerido)
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

    // Validar que al menos un identificador esté presente
    if (!visitor_id && !lead_id && !userId && !site_id) {
      console.error('❌ Al menos un identificador requerido');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'Al menos un parámetro de identificación (visitor_id, lead_id, userId, o site_id) es requerido' 
          } 
        },
        { status: 400 }
      );
    }

    console.log(`💬 Ejecutando workflow Customer Support para mensaje: ${message.substring(0, 50)}...`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: CustomerSupportWorkflowArgs = {
      conversationId,
      userId,
      message,
      agentId,
      site_id,
      lead_id,
      visitor_id,
      name,
      email,
      phone,
      website_chat_origin,
      lead_notification,
      origin,
      origin_message_id
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Customer support tiene alta prioridad
      async: false,
      retryAttempts: 3,
      taskQueue: 'high',
      workflowId: `customer-support-message-${site_id || 'nosid'}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow Customer Support con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para customer support
    const result = await workflowService.customerSupportMessage(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow Customer Support:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow Customer Support'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow Customer Support ejecutado exitosamente');

    // Retornar directamente la respuesta del workflow
    return NextResponse.json(result.data, { status: 200 });

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow customerSupport:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow Customer Support'
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
    name: 'customerSupportWorkflow API',
    description: 'Ejecuta el workflow customerSupportWorkflow en Temporal para procesar mensajes de customer support',
    methods: ['POST'],
    requiredParams: {
      message: 'string - Mensaje a procesar (requerido)',
      identification: 'string - Al menos uno de: visitor_id, lead_id, userId, o site_id'
    },
    optionalParams: {
      conversationId: 'string - UUID de la conversación',
      userId: 'string - UUID del usuario',
      agentId: 'string - UUID del agente',
      site_id: 'string - UUID del sitio',
      lead_id: 'string - UUID del lead',
      visitor_id: 'string - UUID del visitante',
      name: 'string - Nombre del contacto',
      email: 'string - Email del contacto',
      phone: 'string - Teléfono del contacto',
      website_chat_origin: 'boolean - Indica si el origen es chat web',
      lead_notification: 'string - Tipo de notificación',
      origin: 'string - Canal de origen (website, email, whatsapp, etc.)'
    },
    example: {
      message: '¿Cómo puedo cancelar mi suscripción?',
      site_id: 'site_12345',
      visitor_id: 'visitor_67890',
      origin: 'website'
    }
  });
} 