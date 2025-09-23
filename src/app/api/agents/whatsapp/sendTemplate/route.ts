import { NextRequest, NextResponse } from 'next/server';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { attemptPhoneRescue } from '@/lib/utils/phone-normalizer';

/**
 * Ruta para enviar mensajes usando plantillas de WhatsApp previamente creadas
 * 
 * Se utiliza cuando ya se tiene un template_id (del escenario B de createTemplate)
 * 
 * POST /api/agents/whatsapp/sendTemplate
 */

interface SendTemplateRequest {
  template_id: string;
  phone_number: string;
  site_id: string;
  message_id?: string; // Para tracking opcional
  original_message?: string; // Mensaje original para logging
}

interface SendTemplateResponse {
  success: boolean;
  message_id?: string;
  twilio_message_id?: string;
  template_id: string;
  status: 'sent' | 'failed' | 'pending';
  error?: string;
  error_code?: number;
  error_type?: string;
  suggestion?: string;
}

/**
 * Actualiza el estado del mensaje en la base de datos cuando el template se envía exitosamente
 */
async function updateMessageStatusToSent(
  messageId: string,
  twilioMessageId: string,
  phoneNumber: string
): Promise<void> {
  try {
    console.log(`🔄 [updateMessageStatus] Actualizando mensaje ${messageId} a estado "sent"`);
    
    // Primero obtener el custom_data actual
    const { data: currentMessage, error: fetchError } = await supabaseAdmin
      .from('messages')
      .select('custom_data')
      .eq('id', messageId)
      .single();

    if (fetchError || !currentMessage) {
      console.error('❌ [updateMessageStatus] Error al obtener mensaje actual:', fetchError);
      return;
    }

    // Actualizar el custom_data con el nuevo estado y SID de Twilio
    const updatedCustomData = {
      ...currentMessage.custom_data,
      status: 'sent',
      twilio_message_id: twilioMessageId,
      sent_at: new Date().toISOString()
    };

    const { error } = await supabaseAdmin
      .from('messages')
      .update({
        custom_data: updatedCustomData,
        updated_at: new Date().toISOString()
      })
      .eq('id', messageId);

    if (error) {
      console.error('❌ [updateMessageStatus] Error al actualizar estado:', error);
    } else {
      console.log(`✅ [updateMessageStatus] Mensaje ${messageId} actualizado a "sent" con SID: ${twilioMessageId}`);
    }

  } catch (error) {
    console.error('💥 [updateMessageStatus] Error general:', error);
  }
}

// Función auxiliar para validar UUID
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Unifica con la lógica de tools/sendWhatsApp usando el servicio centralizado
async function getWhatsAppConfig(siteId: string): Promise<{
  success: boolean;
  config?: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
  };
  error?: string;
}> {
  try {
    const cfg = await WhatsAppSendService.getWhatsAppConfig(siteId);
    if (!cfg?.phoneNumberId || !cfg?.accessToken) {
      return { success: false, error: 'Twilio credentials (Account SID / Auth Token) are missing for this site' };
    }
    return { success: true, config: { accountSid: cfg.phoneNumberId, authToken: cfg.accessToken, fromNumber: cfg.fromNumber } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Failed to retrieve WhatsApp configuration' };
  }
}

// Eliminado duplicado de getTokenFromService y decryptToken; todo queda centralizado en WhatsAppSendService

// Función para actualizar tracking de template
async function updateTemplateTracking(
  messageId: string, 
  templateId: string, 
  status: string, 
  twilioMessageId?: string,
  error?: string
): Promise<void> {
  try {
    await supabaseAdmin
      .from('whatsapp_template_tracking')
      .upsert([{
        message_id: messageId,
        template_sid: templateId,
        status: status,
        twilio_message_id: twilioMessageId,
        error_message: error,
        sent_at: status === 'sent' ? new Date().toISOString() : null
      }], {
        onConflict: 'message_id'
      });
  } catch (trackingError) {
    console.warn('⚠️ [SendTemplate] Error actualizando tracking:', trackingError);
  }
}

/**
 * POST handler - Enviar mensaje usando plantilla
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📤 [SendTemplate] Iniciando envío con plantilla...');
    
    const body: SendTemplateRequest = await request.json();
    const { template_id, phone_number, site_id, message_id, original_message } = body;

    // Validar campos requeridos
    if (!template_id || !phone_number || !site_id) {
      return NextResponse.json({
        success: false,
        error: 'template_id, phone_number, and site_id are required',
        status: 'failed'
      } as SendTemplateResponse, { status: 400 });
    }

    // Validar site_id UUID
    if (!isValidUUID(site_id)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid site_id format',
        template_id,
        status: 'failed'
      } as SendTemplateResponse, { status: 400 });
    }

    console.log(`📝 [SendTemplate] Enviando plantilla: ${template_id} a ${phone_number.substring(0, 6)}***`);

    // Obtener configuración de WhatsApp
    const configResult = await getWhatsAppConfig(site_id);
    if (!configResult.success) {
      const errorMsg = configResult.error || 'WhatsApp configuration not available';
      
      if (message_id) {
        await updateTemplateTracking(message_id, template_id, 'failed', undefined, errorMsg);
      }

      return NextResponse.json({
        success: false,
        error: errorMsg,
        template_id,
        status: 'failed'
      } as SendTemplateResponse, { status: 404 });
    }

    const { config } = configResult;

    // Garantizar que config existe
    if (!config) {
      const errorMsg = 'WhatsApp configuration not available';
      
      if (message_id) {
        await updateTemplateTracking(message_id, template_id, 'failed', undefined, errorMsg);
      }

      return NextResponse.json({
        success: false,
        error: errorMsg,
        template_id,
        status: 'failed'
      } as SendTemplateResponse, { status: 500 });
    }

    // Validar y rescatar el número para formato internacional consistente
    let normalizedPhone = phone_number;
    if (!WhatsAppSendService.isValidPhoneNumber(normalizedPhone)) {
      console.log(`⚠️ [SendTemplate] Teléfono inválido, intentando rescate: ${normalizedPhone}`);
      const rescued = attemptPhoneRescue(normalizedPhone);
      if (rescued && WhatsAppSendService.isValidPhoneNumber(rescued)) {
        console.log(`✅ [SendTemplate] Teléfono rescatado: ${normalizedPhone} -> ${rescued}`);
        normalizedPhone = rescued;
      } else {
        const err = `Invalid phone number format: "${phone_number}". Include correct country code (e.g., +52 for Mexico).`;
        console.error(`❌ [SendTemplate] ${err}`);
        if (message_id) {
          await updateTemplateTracking(message_id, template_id, 'failed', undefined, err);
        }
        return NextResponse.json({
          success: false,
          error: err,
          template_id,
          status: 'failed'
        } as SendTemplateResponse, { status: 400 });
      }
    }

    // Ajuste conservador si hay desajuste de código de país entre remitente y destinatario
    const fromCcMatch = (config.fromNumber || '').toString().match(/^\+(\d{1,3})/);
    const toCcMatch = normalizedPhone.match(/^\+(\d{1,3})/);
    const fromCc = fromCcMatch ? fromCcMatch[1] : null;
    const toCc = toCcMatch ? toCcMatch[1] : null;
    if (fromCc && toCc && fromCc !== toCc) {
      console.log(`⚠️ [SendTemplate] Country code mismatch (from +${fromCc}, to +${toCc}). Attempting conservative remap...`);
      // Caso común: remitente MX (+52) y destinatario con +1 por error
      if (fromCc === '52' && toCc === '1') {
        const digits = normalizedPhone.replace(/\D/g, '');
        const last10 = digits.slice(-10);
        if (last10.length === 10) {
          const candidate = `+52${last10}`;
          if (WhatsAppSendService.isValidPhoneNumber(candidate)) {
            console.log(`✅ [SendTemplate] Remap aplicado: ${normalizedPhone} -> ${candidate}`);
            normalizedPhone = candidate;
          }
        }
      }
    }

    console.log(`📋 [SendTemplate] Configuración obtenida para site: ${site_id}`);
    console.log(`🔐 [SendTemplate] Usando accountSid: ${config.accountSid.substring(0, 6)}***`);

    // Determinar Messaging Service SID por sitio (si disponible)
    let messagingServiceSidOverride: string | undefined = undefined;
    try {
      const { data: siteSettings } = await supabaseAdmin
        .from('settings')
        .select('channels')
        .eq('site_id', site_id)
        .single();
      const ms = siteSettings?.channels?.whatsapp?.messaging_service_sid;
      if (ms && typeof ms === 'string') {
        messagingServiceSidOverride = ms;
        console.log(`📬 [SendTemplate] Usando Messaging Service SID del sitio: ${messagingServiceSidOverride}`);
      }
    } catch {}

    // Enviar mensaje usando la plantilla
    const sendResult = await WhatsAppTemplateService.sendMessageWithTemplate(
      normalizedPhone,
      template_id,
      config.accountSid,
      config.authToken,
      config.fromNumber,
      original_message || 'Template message',
      messagingServiceSidOverride
    );

    console.log(`📊 [SendTemplate] Resultado del envío:`, {
      success: sendResult.success,
      messageId: sendResult.messageId,
      hasError: !!sendResult.error,
      errorCode: sendResult.errorCode
    });

    // Actualizar tracking si hay message_id
    if (message_id) {
      await updateTemplateTracking(
        message_id,
        template_id,
        sendResult.success ? 'sent' : 'failed',
        sendResult.messageId,
        sendResult.error
      );
    }

    // Incrementar contador de uso de la plantilla
    if (sendResult.success) {
      try {
        await supabaseAdmin
          .from('whatsapp_templates')
          .update({ 
            usage_count: supabaseAdmin.rpc('increment_usage_count'),
            last_used: new Date().toISOString()
          })
          .eq('template_sid', template_id);
      } catch (usageError) {
        console.warn('⚠️ [SendTemplate] Error actualizando contador de uso:', usageError);
      }
    }

    if (sendResult.success) {
      console.log(`✅ [SendTemplate] Mensaje enviado exitosamente: ${sendResult.messageId}`);
      
      // Actualizar el estado del mensaje en la base de datos si tenemos message_id
      if (message_id && sendResult.messageId) {
        await updateMessageStatusToSent(message_id, sendResult.messageId, normalizedPhone);
      }
      
      return NextResponse.json({
        success: true,
        message_id: message_id,
        twilio_message_id: sendResult.messageId,
        template_id,
        status: 'sent'
      } as SendTemplateResponse);
    } else {
      console.error(`❌ [SendTemplate] Error enviando mensaje:`, sendResult.error);
      
      return NextResponse.json({
        success: false,
        message_id: message_id,
        template_id,
        status: 'failed',
        error: sendResult.error,
        error_code: sendResult.errorCode,
        error_type: sendResult.errorType,
        suggestion: sendResult.suggestion
      } as SendTemplateResponse, { status: 400 });
    }

  } catch (error) {
    console.error('❌ [SendTemplate] Error general:', error);
    
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
      template_id: (request as any).body?.template_id || 'unknown',
      status: 'failed'
    } as SendTemplateResponse, { status: 500 });
  }
}

/**
 * GET handler - Verificar estado de envío por message_id o template_id
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const messageId = searchParams.get('message_id');
    const templateId = searchParams.get('template_id');

    if (!messageId && !templateId) {
      return NextResponse.json({
        success: false,
        error: 'message_id or template_id is required'
      }, { status: 400 });
    }

    console.log(`🔍 [SendTemplate] Verificando estado - messageId: ${messageId}, templateId: ${templateId}`);

    let query = supabaseAdmin
      .from('whatsapp_template_tracking')
      .select('*');

    if (messageId) {
      query = query.eq('message_id', messageId);
    } else if (templateId) {
      query = query.eq('template_sid', templateId).order('created_at', { ascending: false }).limit(1);
    }

    const { data: tracking, error } = await query.single();

    if (error || !tracking) {
      return NextResponse.json({
        success: false,
        error: 'Tracking record not found'
      }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message_id: tracking.message_id,
      template_id: tracking.template_sid,
      twilio_message_id: tracking.twilio_message_id,
      status: tracking.status,
      phone_number: tracking.phone_number,
      error: tracking.error_message,
      created_at: tracking.created_at,
      sent_at: tracking.sent_at
    });

  } catch (error) {
    console.error('❌ [SendTemplate] Error en GET:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error'
    }, { status: 500 });
  }
} 