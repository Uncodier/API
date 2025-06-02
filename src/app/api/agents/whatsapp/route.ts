import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TwilioValidationService } from '@/lib/services/twilio/TwilioValidationService';

// Interfaz para el webhook de Twilio WhatsApp
interface TwilioWhatsAppWebhook {
  MessageSid: string;
  AccountSid: string;
  MessagingServiceSid?: string;
  From: string; // Número de teléfono del remitente (formato: whatsapp:+1234567890)
  To: string;   // Número de teléfono del destinatario (formato: whatsapp:+1234567890)
  Body: string; // Contenido del mensaje
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  SmsMessageSid?: string;
  SmsStatus?: string;
  SmsSid?: string;
  WaId?: string; // WhatsApp ID del remitente
  ProfileName?: string; // Nombre del perfil de WhatsApp
  ButtonText?: string;
  ButtonPayload?: string;
}

// Función auxiliar para validar UUID
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para extraer el número de teléfono del formato de Twilio
function extractPhoneNumber(twilioPhoneFormat: string): string {
  // El formato de Twilio es "whatsapp:+1234567890"
  return twilioPhoneFormat.replace('whatsapp:', '');
}

// Función para obtener el user_id desde el site_id
async function getUserIdFromSite(siteId: string): Promise<string | null> {
  try {
    const { data: site, error } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', siteId)
      .single();

    if (error) {
      console.error('❌ Error al obtener site:', error);
      return null;
    }

    return site?.user_id || null;
  } catch (error) {
    console.error('❌ Error al buscar user_id del site:', error);
    return null;
  }
}

// Función para buscar un lead existente basado en el siteId y número de teléfono
async function findExistingLead(siteId: string, phoneNumber: string): Promise<string | null> {
  try {
    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('site_id', siteId)
      .eq('phone', phoneNumber)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 es "no rows returned" que es esperado si no existe el lead
      console.error('❌ Error al buscar lead:', error);
      return null;
    }

    return lead?.id || null;
  } catch (error) {
    console.error('❌ Error al buscar lead existente:', error);
    return null;
  }
}

// Función para buscar una conversación de WhatsApp existente para un lead
async function findWhatsAppConversation(leadId: string): Promise<string | null> {
  try {
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('lead_id', leadId)
      .eq('status', 'active')
      .contains('custom_data', { channel: 'whatsapp' })
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('❌ Error al buscar conversación de WhatsApp:', error);
      return null;
    }

    return conversation?.id || null;
  } catch (error) {
    console.error('❌ Error al buscar conversación de WhatsApp:', error);
    return null;
  }
}

// Función para procesar el webhook de Twilio
async function processTwilioWebhook(
  webhookData: TwilioWhatsAppWebhook,
  siteId: string,
  agentId: string
): Promise<{ success: boolean; workflowId?: string; error?: string }> {
  try {
    const workflowService = WorkflowService.getInstance();
    
    // Obtener el user_id del site
    const userId = await getUserIdFromSite(siteId);
    if (!userId) {
      return {
        success: false,
        error: 'No se pudo obtener el user_id del site especificado'
      };
    }
    
    // Extraer información del webhook
    const phoneNumber = extractPhoneNumber(webhookData.From);
    const messageContent = webhookData.Body;
    const messageId = webhookData.MessageSid;
    const businessAccountId = webhookData.AccountSid;
    const senderName = webhookData.ProfileName || 'Usuario de WhatsApp'; // Nombre del remitente
    
    // Buscar lead existente para este sitio y número
    const existingLeadId = await findExistingLead(siteId, phoneNumber);
    
    let conversationId: string | null = null;
    
    if (existingLeadId) {
      // Si existe el lead, buscar conversación de WhatsApp activa
      conversationId = await findWhatsAppConversation(existingLeadId);
      console.log(`🔍 Lead existente encontrado: ${existingLeadId}`);
      if (conversationId) {
        console.log(`💬 Conversación de WhatsApp existente: ${conversationId}`);
      } else {
        console.log(`📱 No hay conversación de WhatsApp activa, se creará una nueva`);
      }
    } else {
      console.log(`👤 No se encontró lead existente, se creará uno nuevo`);
    }
    
    console.log(`📱 Procesando mensaje de WhatsApp desde Twilio`);
    console.log(`📞 De: ${phoneNumber} (${senderName})`);
    console.log(`💬 Mensaje: ${messageContent}`);
    console.log(`🆔 Message ID: ${messageId}`);
    console.log(`🏢 Site ID: ${siteId}`);
    console.log(`👤 User ID: ${userId}`);
    console.log(`🤖 Agent ID: ${agentId}`);
    console.log(`🔗 Lead ID: ${existingLeadId || 'Se creará nuevo'}`);
    console.log(`💬 Conversation ID: ${conversationId || 'Se creará nueva'}`);
    
    // Iniciar el workflow de WhatsApp en Temporal
    const workflowResult = await workflowService.answerWhatsappMessage({
      phoneNumber,
      messageContent,
      businessAccountId,
      messageId,
      conversationId: conversationId || '', // Pasar conversationId si existe, vacío si no
      agentId,
      siteId,
      userId, // ID del usuario dueño del sitio
      senderName, // Nombre del remitente
      leadId: existingLeadId || undefined, // Pasar leadId si existe
    });
    
    if (workflowResult.success) {
      console.log(`✅ Workflow de WhatsApp iniciado exitosamente: ${workflowResult.workflowId}`);
      return {
        success: true,
        workflowId: workflowResult.workflowId
      };
    } else {
      console.error(`❌ Error al iniciar workflow de WhatsApp:`, workflowResult.error);
      return {
        success: false,
        error: workflowResult.error?.message || 'Error desconocido'
      };
    }
    
  } catch (error) {
    console.error('❌ Error al procesar webhook de Twilio:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error desconocido'
    };
  }
}

/**
 * GET handler - redirige a la documentación
 */
export async function GET() {
  return NextResponse.redirect(new URL('/REST%20API/agents/whatsapp/analyze', 'https://uncodie.com'));
}

/**
 * POST handler - webhook de Twilio para WhatsApp
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 Webhook de Twilio WhatsApp recibido');
    
    // Obtener los parámetros de consulta para site_id y agent_id
    const searchParams = request.nextUrl.searchParams;
    const siteId = searchParams.get('site_id');
    const agentId = searchParams.get('agent_id');
    
    // Validar parámetros requeridos
    if (!siteId || !isValidUUID(siteId)) {
      console.error('❌ site_id inválido o faltante en los parámetros del webhook');
      return NextResponse.json(
        { success: false, error: 'Invalid or missing site_id parameter' },
        { status: 400 }
      );
    }
    
    if (!agentId || !isValidUUID(agentId)) {
      console.error('❌ agent_id inválido o faltante en los parámetros del webhook');
      return NextResponse.json(
        { success: false, error: 'Invalid or missing agent_id parameter' },
        { status: 400 }
      );
    }
    
    // Obtener el cuerpo de la solicitud (datos del webhook de Twilio)
    // Twilio envía datos como application/x-www-form-urlencoded
    const contentType = request.headers.get('content-type') || '';
    
    let webhookData: TwilioWhatsAppWebhook;
    
    if (contentType.includes('application/x-www-form-urlencoded')) {
      // Twilio envía datos como form-encoded
      const formData = await request.formData();
      webhookData = Object.fromEntries(formData.entries()) as any;
    } else if (contentType.includes('application/json')) {
      // Algunos casos pueden enviar JSON
      webhookData = await request.json();
    } else {
      console.error('❌ Tipo de contenido no soportado:', contentType);
      return NextResponse.json(
        { success: false, error: 'Unsupported content type' },
        { status: 400 }
      );
    }
    
    // Debug del webhook
    console.log(`📄 Datos del webhook:`, JSON.stringify(webhookData, null, 2));
    
    // Validar que tenemos los datos mínimos necesarios
    if (!webhookData.MessageSid || !webhookData.From || !webhookData.Body) {
      console.error('❌ Datos incompletos en el webhook de Twilio');
      return NextResponse.json(
        { success: false, error: 'Missing required webhook data' },
        { status: 400 }
      );
    }
    
    // VALIDACIÓN DE TWILIO - Verificar que la petición viene realmente de Twilio
    const twilioSignature = request.headers.get('x-twilio-signature');
    
    if (!twilioSignature) {
      console.error('❌ Falta la firma de Twilio (X-Twilio-Signature)');
      return NextResponse.json(
        { success: false, error: 'Missing Twilio signature' },
        { status: 403 }
      );
    }
    
    // Extraer el número de WhatsApp para buscar el auth token
    const whatsappNumber = extractPhoneNumber(webhookData.From);
    
    // Construir la URL completa para la validación
    const fullUrl = request.url;
    
    // Validar la firma de Twilio
    console.log('🔐 Validando firma de Twilio...');
    const validationResult = await TwilioValidationService.validateTwilioRequest(
      fullUrl,
      webhookData,
      twilioSignature,
      whatsappNumber,
      siteId
    );
    
    if (!validationResult.isValid) {
      console.error('❌ Validación de Twilio fallida:', validationResult.error);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Invalid Twilio signature - request not authorized',
          details: validationResult.error 
        },
        { status: 403 }
      );
    }
    
    console.log('✅ Validación de Twilio exitosa');
    
    // Procesar el webhook de Twilio
    const result = await processTwilioWebhook(webhookData, siteId, agentId);
    
    if (result.success) {
      console.log(`✅ Webhook procesado exitosamente. Workflow ID: ${result.workflowId}`);
      
      // Twilio espera una respuesta con código 200
      return NextResponse.json(
        { 
          success: true, 
          workflowId: result.workflowId,
          message: 'Webhook processed successfully'
        },
        { status: 200 }
      );
    } else {
      console.error(`❌ Error al procesar webhook:`, result.error);
      
      // Aún así devolvemos 200 a Twilio para evitar reintentos
      return NextResponse.json(
        { 
          success: false, 
          error: result.error,
          message: 'Webhook received but processing failed'
        },
        { status: 200 }
      );
    }
    
  } catch (error) {
    console.error('❌ Error general en el webhook de Twilio:', error);
    
    // Devolver 200 a Twilio para evitar reintentos, pero loggear el error
    return NextResponse.json(
      { 
        success: false, 
        error: 'Internal server error',
        message: 'Webhook received but server error occurred'
      },
      { status: 200 }
    );
  }
} 