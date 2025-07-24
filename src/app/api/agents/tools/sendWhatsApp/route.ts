import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { attemptPhoneRescue } from '@/lib/utils/phone-normalizer';

/**
 * Endpoint para enviar mensajes de WhatsApp desde un agente con manejo automático de ventana de respuesta
 * 
 * NUEVA FUNCIONALIDAD:
 * - Detecta automáticamente si la conversación está dentro de la ventana de respuesta de 24 horas
 * - Si está fuera de la ventana, crea y usa templates de Twilio automáticamente
 * - Reutiliza templates existentes para mensajes similares
 * - Fallback a mensaje regular si hay problemas con templates
 * 
 * @param request Solicitud entrante con los datos del mensaje a enviar
 * @returns Respuesta con el estado del envío, información de template y ventana de respuesta
 * 
 * Parámetros de la solicitud:
 * - phone_number: (Requerido) Número de teléfono del destinatario en formato internacional (+1234567890)
 * - from: (Opcional) Nombre del remitente
 * - message: (Requerido) Contenido del mensaje
 * - site_id: (Requerido) ID del sitio para obtener configuración de WhatsApp
 * - agent_id: (Opcional) ID del agente que envía el mensaje
 * - conversation_id: (Opcional) ID de la conversación (requerido para detectar ventana de respuesta)
 * - lead_id: (Opcional) ID del lead asociado
 * 
 * Respuesta incluye:
 * - template_used: boolean - Si se usó un template de Twilio
 * - template_sid: string - SID del template usado (si aplica)
 * - within_response_window: boolean - Si estaba dentro de la ventana de 24 horas
 * - hours_elapsed: number - Horas transcurridas desde el último mensaje del usuario
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { 
      phone_number,
      from,
      message,
      agent_id,
      conversation_id,
      lead_id,
      site_id
    } = body;
    
    console.log('🔍 [SendWhatsApp] Parámetros recibidos:', {
      phone_number,
      from,
      message,
      agent_id,
      conversation_id,
      lead_id,
      site_id
    });
    
    // Validar parámetros requeridos
    const requiredFields = [
      { field: 'phone_number', value: phone_number },
      { field: 'message', value: message },
      { field: 'site_id', value: site_id }
    ];

    for (const { field, value } of requiredFields) {
      if (!value) {
        console.error(`❌ [SendWhatsApp] Campo requerido faltante: ${field}`);
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'INVALID_REQUEST', 
              message: `${field} is required` 
            } 
          },
          { status: 400 }
        );
      }
    }
    
    console.log(`🔎 [SendWhatsApp] Buscando configuración para site_id: ${site_id}`);
    
    // Obtener configuración del sitio para validar la configuración de WhatsApp
    const { data: siteSettings, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', site_id)
      .single();
    
    console.log('📊 [SendWhatsApp] Resultado de consulta settings:', {
      siteSettings,
      settingsError: settingsError?.message || settingsError,
      hasData: !!siteSettings
    });
      
    if (settingsError || !siteSettings) {
      console.error('❌ [SendWhatsApp] No se encontró configuración del sitio:', {
        site_id,
        error: settingsError?.message || settingsError,
        hasData: !!siteSettings
      });
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SITE_CONFIG_NOT_FOUND', 
            message: 'Site configuration not found' 
          } 
        },
        { status: 404 }
      );
    }
    
    console.log('🔧 [SendWhatsApp] Configuración de channels encontrada:', {
      channels: siteSettings.channels,
      hasChannels: !!siteSettings.channels,
      hasWhatsApp: !!siteSettings.channels?.whatsapp,
      whatsappConfig: siteSettings.channels?.whatsapp
    });
    
    // Verificar si WhatsApp está configurado (en settings, secure_tokens o variables de entorno)
    const hasWhatsAppInSettings = siteSettings.channels?.whatsapp?.enabled === true;
    const hasWhatsAppInEnv = process.env.WHATSAPP_PHONE_NUMBER_ID && 
                            process.env.WHATSAPP_API_TOKEN;
    
    // Verificar si hay tokens en secure_tokens (esto lo hará el servicio)
    let hasWhatsAppTokens = false;
    try {
      const { data: tokens } = await supabaseAdmin
        .from('secure_tokens')
        .select('id')
        .eq('token_type', 'twilio_whatsapp')
        .eq('site_id', site_id)
        .limit(1);
      hasWhatsAppTokens = !!(tokens && tokens.length > 0);
    } catch (error) {
      console.warn('⚠️ [SendWhatsApp] Error verificando secure_tokens:', error);
    }
    
    console.log('🔍 [SendWhatsApp] Verificación de configuraciones:', {
      hasWhatsAppInSettings,
      hasWhatsAppInEnv,
      hasWhatsAppTokens,
      settingsEnabled: siteSettings.channels?.whatsapp?.enabled,
      settingsStatus: siteSettings.channels?.whatsapp?.status,
      envPhoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      envApiToken: !!process.env.WHATSAPP_API_TOKEN
    });
    
    if (!hasWhatsAppInSettings && !hasWhatsAppInEnv && !hasWhatsAppTokens) {
      console.error('❌ [SendWhatsApp] WhatsApp no está configurado:', {
        site_id,
        hasWhatsAppInSettings,
        hasWhatsAppInEnv,
        hasWhatsAppTokens,
        channels: siteSettings.channels
      });
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'WHATSAPP_NOT_CONFIGURED', 
            message: 'WhatsApp is not configured for this site. Please configure WhatsApp settings, environment variables, or secure tokens.' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log('✅ [SendWhatsApp] Configuración de WhatsApp válida, procediendo con validación de teléfono');
    
    // Validar formato del número de teléfono con rescate automático
    let validatedPhone = phone_number;
    
    if (!WhatsAppSendService.isValidPhoneNumber(phone_number)) {
      console.log(`⚠️ [SendWhatsApp] Formato de teléfono inválido detectado, intentando rescate: ${phone_number}`);
      
      // Intentar rescatar el número usando heurísticas
      const rescuedPhone = attemptPhoneRescue(phone_number);
      
      if (rescuedPhone && WhatsAppSendService.isValidPhoneNumber(rescuedPhone)) {
        validatedPhone = rescuedPhone;
        console.log(`✅ [SendWhatsApp] Teléfono rescatado exitosamente: ${phone_number} -> ${rescuedPhone}`);
      } else {
        console.error(`❌ [SendWhatsApp] No se pudo rescatar el teléfono: ${phone_number}`);
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'INVALID_PHONE_NUMBER', 
              message: `Invalid phone number format: "${phone_number}". Use international format (e.g., +1234567890). Attempted rescue but failed.` 
            } 
          },
          { status: 400 }
        );
      }
    }

    console.log('📤 [SendWhatsApp] Enviando mensaje via WhatsAppSendService con parámetros:', {
      phone_number: validatedPhone,
      originalPhone: phone_number !== validatedPhone ? phone_number : undefined,
      from: from || '',
      messageLength: message.length,
      agent_id,
      conversation_id,
      lead_id,
      site_id
    });

    // Enviar el mensaje usando el servicio con el teléfono validado
    const result = await WhatsAppSendService.sendMessage({
      phone_number: validatedPhone,
      from: from || '', // Nombre del remitente (opcional)
      message,
      agent_id,
      conversation_id,
      lead_id,
      site_id
    });

    console.log('📨 [SendWhatsApp] Resultado del envío:', {
      success: result.success,
      status: result.status,
      error: result.error,
      messageId: result.message_id,
      templateUsed: result.template_used,
      templateSid: result.template_sid,
      withinResponseWindow: result.within_response_window,
      hoursElapsed: result.hours_elapsed
    });

    if (!result.success) {
      // Determinar código de estado basado en el tipo de error
      let statusCode = 500; // Default para errores internos
      
      if (result.error?.code === 'WHATSAPP_CONFIG_NOT_FOUND') {
        statusCode = 404;
      } else if (result.errorType) {
        // Mapear tipos de error de Twilio a códigos HTTP apropiados
        switch (result.errorType) {
          case 'USER_LIMITATION':
          case 'INVALID_NUMBER':
            statusCode = 400; // Bad Request - problema con el destinatario
            break;
          case 'SENDER_CONFIG':
          case 'BUSINESS_SETUP':
            statusCode = 502; // Bad Gateway - configuración del servidor
            break;
          case 'RATE_LIMIT':
          case 'QUALITY_LIMIT':
            statusCode = 429; // Too Many Requests
            break;
          case 'RESPONSE_WINDOW':
            statusCode = 422; // Unprocessable Entity - necesita template
            break;
          case 'TEMPLATE_ERROR':
          case 'ACCOUNT_ERROR':
            statusCode = 503; // Service Unavailable - problema temporal del servicio
            break;
          default:
            statusCode = 500;
        }
      }
      
      console.error('❌ [SendWhatsApp] Error en el envío:', {
        error: result.error,
        errorCode: result.errorCode,
        errorType: result.errorType,
        suggestion: result.suggestion,
        statusCode
      });
      
      return NextResponse.json(
        { 
          success: false, 
          error: {
            message: result.error,
            code: result.errorCode || 'UNKNOWN',
            type: result.errorType || 'UNKNOWN',
            suggestion: result.suggestion || 'Contactar soporte técnico'
          }
        },
        { status: statusCode }
      );
    }

    const statusCode = result.status === 'skipped' ? 200 : 201;
    console.log('✅ [SendWhatsApp] Mensaje enviado exitosamente:', {
      statusCode,
      result: {
        success: result.success,
        status: result.status,
        message_id: result.message_id,
        template_used: result.template_used,
        template_sid: result.template_sid,
        within_response_window: result.within_response_window,
        hours_elapsed: result.hours_elapsed
      }
    });
    
    return NextResponse.json(result, { status: statusCode });
    
  } catch (error) {
    console.error('💥 [SendWhatsApp] Error general en endpoint:', {
      error: error instanceof Error ? error.message : 'Error desconocido',
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An internal server error occurred while sending the WhatsApp message' 
        } 
      },
      { status: 500 }
    );
  }
}

/**
 * Endpoint GET para consultar el estado de mensajes de WhatsApp enviados
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const messageId = searchParams.get('message_id');
    const agentId = searchParams.get('agent_id');
    const conversationId = searchParams.get('conversation_id');
    const limit = parseInt(searchParams.get('limit') || '10');
    
    // Construir query base
    let query = supabaseAdmin.from('whatsapp_logs').select('*');
    
    // Aplicar filtros
    if (messageId) {
      query = query.eq('whatsapp_message_id', messageId);
    }
    
    if (agentId) {
      query = query.eq('agent_id', agentId);
    }
    
    if (conversationId) {
      query = query.eq('conversation_id', conversationId);
    }
    
    // Aplicar límite y ordenamiento
    query = query.order('sent_at', { ascending: false }).limit(limit);
    
    const { data: whatsappLogs, error } = await query;
    
    if (error) {
      console.error('Error al consultar logs de WhatsApp:', error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'Failed to retrieve WhatsApp logs' 
          } 
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json({
      success: true,
      messages: whatsappLogs || [],
      count: whatsappLogs?.length || 0
    });
    
  } catch (error) {
    console.error('Error en consulta de mensajes de WhatsApp:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An internal server error occurred while retrieving WhatsApp logs' 
        } 
      },
      { status: 500 }
    );
  }
} 