import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from '@/lib/services/workflow-service';
import { hasAuthenticatedPrincipal, isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import {
  visitorAuthorizationErrorResponse,
  visitorSessionAuthorizationService
} from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { readSupportRequest, supportMessageId, supportRequestError } from './request-contract';

// Browser requests receive the final assistant reply in the POST by default.
// Prefer: respond-async selects a 202 receipt followed by client-side /status polling.
// Leave time to return a controlled error if the final-reply wait expires.
export const maxDuration = 180;
const FINAL_REPLY_WAIT_MS = 120_000;
const FINAL_REPLY_POLL_MS = 2_500;

async function waitForFinalReply(
  workflowService: WorkflowService,
  workflowId: string,
): Promise<NextResponse> {
  const deadline = Date.now() + FINAL_REPLY_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await workflowService.getFinishedWorkflowResult(workflowId);
    if (result.success && result.status === 'completed') {
      const payload = result.data as {
        success?: boolean;
        data?: { messages?: { assistant?: { content?: string } } };
      } | undefined;
      if (payload?.success && payload.data?.messages?.assistant?.content) {
        return NextResponse.json({ success: true, data: payload.data });
      }
      return NextResponse.json({
        success: false,
        error: { code: 'WORKFLOW_NO_REPLY', message: 'Customer Support completed without an assistant reply' },
      }, { status: 502 });
    }
    if (!result.success && result.error?.code === 'WORKFLOW_FAILED') {
      return NextResponse.json({
        success: false,
        error: { code: 'WORKFLOW_FAILED', message: 'Customer Support workflow failed' },
      }, { status: 502 });
    }
    await new Promise<void>(resolve => setTimeout(resolve,
      Math.min(FINAL_REPLY_POLL_MS, Math.max(0, deadline - Date.now())),
    ));
  }
  // Final-reply mode returns an error on timeout, not an asynchronous receipt.
  // This stops the HTTP wait; the Temporal workflow may continue running.
  return NextResponse.json({
    success: false,
    error: { code: 'WORKFLOW_PENDING', message: 'Customer Support is still processing the message', workflowId },
  }, { status: 504, headers: { 'Retry-After': '5' } });
}

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
    const body = await readSupportRequest(request);
    const validationError = body ? supportRequestError(body) : 'Invalid JSON request';
    if (!body || validationError) {
      return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: validationError } }, { status: 400 });
    }
    const identity = await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request,
      siteId: body.site_id as string,
      sessionId: body.session_id as string | undefined,
      conversationId: body.conversationId as string | undefined
    });
    if (identity) {
      body.site_id = identity.siteId;
      body.visitor_id = identity.visitorId;
      body.lead_id = identity.leadId;
      body.userId = undefined;
      body.name = undefined;
      body.email = undefined;
      body.phone = undefined;
      body.origin = 'website_chat';
      body.agentId = undefined;
      // A browser retry of the same, session-authorized send must reuse the
      // same Temporal workflow and pre-response run; a new send gets a new ID.
      const clientMessageId = typeof body.client_message_id === 'string'
        && body.client_message_id.length <= 128 && body.client_message_id.trim()
        ? body.client_message_id.trim() : randomUUID();
      body.origin_message_id = supportMessageId(identity.siteId, identity.sessionId, clientMessageId, body.message as string);
    } else {
      // Only a middleware-validated principal may start a non-browser workflow.
      // The route must not accept a bare site_id (or a forged origin) as proof.
      if (!hasAuthenticatedPrincipal(request)) {
        return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication is required' } }, { status: 401 });
      }
      if (typeof body.site_id !== 'string' || !await canAccessSite(request, body.site_id)) {
        return NextResponse.json({ success: false, error: { code: 'FORBIDDEN', message: 'Site is not accessible' } }, { status: 403 });
      }
      if (!isInternalServiceRequest(request)) {
        return NextResponse.json({ success: false, error: { code: 'FORBIDDEN', message: 'A service principal is required' } }, { status: 403 });
      }
      // Provider-supplied message identifiers must belong to an authenticated
      // integration; otherwise the caller could reuse another workflow ID.
      if (typeof body.origin_message_id === 'string' && body.origin_message_id.length > 256) {
        return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid inbound message ID' } }, { status: 400 });
      }
    }
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
    } = body as unknown as CustomerSupportWorkflowArgs;

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

    // Both HTTP response modes start Temporal asynchronously. Final-reply mode
    // waits for the result below; asynchronous receipt mode leaves polling to the client.
    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high', // Customer support tiene alta prioridad
      async: true,
      retryAttempts: 3,
      taskQueue: 'high',
      workflowId: `customer-support-message-${site_id || 'nosid'}-${origin_message_id || randomUUID()}`
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

    // Browser identity: final reply by default, or 202 + /status polling when
    // Prefer: respond-async is requested. Requests without browser identity retain 202.
    const wantsAsync = request.headers.get('prefer')?.split(',')
      .some(value => value.trim().toLowerCase() === 'respond-async');
    if (identity && !wantsAsync) {
      return await waitForFinalReply(workflowService, result.workflowId || workflowOptions.workflowId!);
    }

    return NextResponse.json(
      { success: true, data: { status: result.status, workflowId: result.workflowId, runId: result.runId } },
      { status: 202 },
    );

  } catch (error) {
    const authorizationResponse = visitorAuthorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
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