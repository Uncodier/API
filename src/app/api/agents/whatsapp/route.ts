import { NextRequest, NextResponse } from 'next/server';
import { TwilioValidationService } from '@/lib/services/twilio/TwilioValidationService';
import { normalizePhoneForSearch } from '@/lib/utils/phone-normalizer';
import type { TwilioWhatsAppWebhook } from '@/lib/services/twilio/TwilioIncomingService';
import { findWhatsAppConfiguration, processIncomingMessage, getUserIdFromSite, findExistingLead, findWhatsAppConversation } from '@/lib/services/twilio/TwilioIncomingService';
import { handleTwilioMediaAndCreateTask } from '@/lib/services/twilio/TwilioMediaTaskService';

/**
 * Twilio WhatsApp webhook.
 * Automatically resolves `site_id` and `agent_id` from the recipient phone number using `secure_tokens`.
 * Validates the request signature and processes text and media messages.
 */
// minimal local helper
function extractPhoneNumber(twilioPhoneFormat: string): string {
  return twilioPhoneFormat.replace('whatsapp:', '');
}

/**
 * GET handler - redirige a la documentación
 */
export async function GET() {
  return NextResponse.redirect(new URL('/REST%20API/agents/whatsapp/webhook', 'https://uncodie.com'));
}

/**
 * POST handler - webhook de Twilio para WhatsApp
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 Webhook de Twilio WhatsApp recibido');
    
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
    if (!webhookData.MessageSid || !webhookData.From || !webhookData.To || !webhookData.Body) {
      console.error('❌ Datos incompletos en el webhook de Twilio');
      return NextResponse.json(
        { success: false, error: 'Missing required webhook data' },
        { status: 400 }
      );
    }

    // Extraer el número de negocio (destinatario) para buscar la configuración
    const businessPhoneNumber = extractPhoneNumber(webhookData.To);
    console.log(`🏢 Número de negocio: ${businessPhoneNumber}`);
    
    // Buscar la configuración de WhatsApp basada en el número de negocio
    const configResult = await findWhatsAppConfiguration(businessPhoneNumber);
    
    if (!configResult.success) {
      console.error('❌ No se pudo encontrar la configuración de WhatsApp:', configResult.error);
      return NextResponse.json(
        { success: false, error: configResult.error },
        { status: 404 }
      );
    }

    const { siteId, agentId } = configResult;
    console.log(`✅ Configuración encontrada - Site: ${siteId}, Agent: ${agentId}`);
    
    // VALIDACIÓN DE TWILIO - Verificar que la petición viene realmente de Twilio
    const twilioSignature = request.headers.get('x-twilio-signature');
    
    if (!twilioSignature) {
      console.error('❌ Falta la firma de Twilio (X-Twilio-Signature)');
      return NextResponse.json(
        { success: false, error: 'Missing Twilio signature' },
        { status: 403 }
      );
    }
    
    // Extraer el número de WhatsApp del remitente para la validación
    const senderPhoneNumber = extractPhoneNumber(webhookData.From);
    
    // Construir la URL completa para la validación
    const fullUrl = request.url;
    
    // Validate Twilio signature using business number
    console.log('🔐 Validando firma de Twilio...');
    const validationResult = await TwilioValidationService.validateTwilioRequest(
      fullUrl,
      webhookData,
      twilioSignature,
      businessPhoneNumber, // Usar el número de negocio para buscar el token
      siteId!
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

    // First, process the text workflow (existing behavior)
    const result = await processIncomingMessage(webhookData as TwilioWhatsAppWebhook, siteId!, agentId!);

    // Then, best-effort media handling mirroring @visitors/upload
    const numMedia = parseInt(String((webhookData as any).NumMedia || '0'), 10) || 0;
    if (numMedia > 0) {
      try {
        const userId = await getUserIdFromSite(siteId!);
        if (userId) {
          const senderPhone = extractPhoneNumber(webhookData.From);
          const variants = normalizePhoneForSearch(senderPhone);
          const existingLeadId = await findExistingLead(siteId!, variants);
          let conversationId: string | null = null;
          if (existingLeadId) {
            conversationId = await findWhatsAppConversation(existingLeadId);
          }
          const media: Array<{ url: string; contentType?: string }> = [];
          for (let i = 0; i < numMedia; i++) {
            const url = (webhookData as any)[`MediaUrl${i}`];
            const contentType = (webhookData as any)[`MediaContentType${i}`];
            if (url) media.push({ url, contentType });
          }
          if (media.length) {
            const authToken = validationResult.authToken as string | undefined;
            if (authToken) {
              await handleTwilioMediaAndCreateTask({
                siteId: siteId!,
                userId,
                agentId,
                leadId: existingLeadId || undefined,
                conversationId: conversationId || undefined,
                messageText: webhookData.Body,
                workflowOrigin: 'whatsapp',
                media,
                twilioAuth: { accountSid: webhookData.AccountSid, authToken },
              });
            } else {
              console.warn('⚠️ Missing Twilio auth token; cannot download media');
            }
          }
        }
      } catch (mediaErr) {
        console.warn('⚠️ Error handling media upload/task creation:', mediaErr);
      }
    }
    
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