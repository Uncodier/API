import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface AgentMessageWorkflowArgs {
  conversationId?: string;
  message: string;
  agentId: string;
  lead_id?: string;
  visitor_id?: string;
  site_id: string;
  team_member_id?: string;
  userId?: string;
  origin?: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow agentMessageWorkflow en Temporal
 * POST /api/workflow/agentMessage
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Iniciando ejecución del workflow agentMessageWorkflow');

    // Extraer y validar parámetros del cuerpo de la petición
    const body = await request.json();
    const { 
      conversationId,
      message,
      agentId,
      lead_id,
      visitor_id,
      site_id,
      team_member_id,
      userId,
      origin
    } = body;

    // Validación de parámetros requeridos
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

    if (!agentId || typeof agentId !== 'string') {
      console.error('❌ agentId requerido y debe ser una cadena');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_AGENT_ID', 
            message: 'agentId es requerido y debe ser una cadena válida' 
          } 
        },
        { status: 400 }
      );
    }

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

    console.log(`🤖 Ejecutando workflow Agent Message para agente: ${agentId}`);
    console.log(`💬 Mensaje: ${message.substring(0, 50)}...`);

    // Obtener instancia del servicio de workflows
    const workflowService = WorkflowService.getInstance();

    // Preparar argumentos para el workflow
    const workflowArgs: AgentMessageWorkflowArgs = {
      conversationId,
      message,
      agentId,
      lead_id,
      visitor_id,
      site_id,
      team_member_id,
      userId,
      origin
    };

    // Opciones de ejecución del workflow
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Agent messages tienen alta prioridad
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `agent-message-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Iniciando workflow Agent Message con ID: ${workflowOptions.workflowId}`);

    // Ejecutar el workflow específico para agent message
    const result = await workflowService.agentMessage(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error en la ejecución del workflow Agent Message:', result.error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar el workflow Agent Message'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Workflow Agent Message ejecutado exitosamente');

    // Retornar directamente la respuesta del workflow
    return NextResponse.json(result.data, { status: 200 });

  } catch (error) {
    console.error('❌ Error en el endpoint del workflow agentMessage:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al ejecutar el workflow Agent Message'
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
    name: 'agentMessageWorkflow API',
    description: 'Ejecuta el workflow agentMessageWorkflow en Temporal para procesar mensajes de agente',
    methods: ['POST'],
    requiredParams: {
      message: 'string - Mensaje a procesar (requerido)',
      agentId: 'string - UUID del agente (requerido)',
      site_id: 'string - UUID del sitio (requerido)'
    },
    optionalParams: {
      conversationId: 'string - UUID de la conversación',
      lead_id: 'string - UUID del lead',
      visitor_id: 'string - UUID del visitante',
      team_member_id: 'string - UUID del miembro del equipo',
      userId: 'string - UUID del usuario',
      origin: 'string - Canal de origen (website, email, whatsapp, etc.)'
    },
    equivalentTo: 'api/agents/chat/message - Mismo input/output pero usando workflows',
    example: {
      message: 'Hola, necesito ayuda con mi cuenta',
      agentId: 'agent_12345',
      site_id: 'site_67890',
      conversationId: 'conv_abcdef',
      origin: 'website'
    }
  });
} 