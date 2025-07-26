import { NextRequest, NextResponse } from 'next/server';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

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

// Función para obtener configuración de WhatsApp del sitio - usando la misma lógica que WhatsAppSendService
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
    console.log(`🔍 [SendTemplate] Buscando configuración de WhatsApp para site_id: ${siteId}`);

    // Primero intentar obtener desde variables de entorno globales
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_API_TOKEN;
    
    if (phoneNumberId && accessToken) {
      console.log('✅ [SendTemplate] Usando configuración de variables de entorno');
      return { 
        success: true, 
        config: {
          accountSid: phoneNumberId,
          authToken: accessToken,
          fromNumber: process.env.TWILIO_WHATSAPP_FROM || '+14155238886'
        }
      };
    }

    // Si no están en env, buscar y desencriptar desde secure_tokens
    console.log('🔎 [SendTemplate] Buscando en secure_tokens...');
    
    const decryptedToken = await getTokenFromService(siteId);
    
    if (decryptedToken) {
      console.log('✅ [SendTemplate] Token desencriptado exitosamente desde secure_tokens');
      
      // El token desencriptado es directamente el auth token de Twilio
      const authToken = typeof decryptedToken === 'string' ? decryptedToken : String(decryptedToken);
      
      // Obtener el Account SID desde settings.channels.whatsapp
      console.log('🔍 [SendTemplate] Obteniendo Account SID desde settings...');
      
      const { data: siteSettings, error: settingsError } = await supabaseAdmin
        .from('settings')
        .select('channels')
        .eq('site_id', siteId)
        .single();
        
      if (settingsError || !siteSettings?.channels?.whatsapp) {
        console.error('❌ [SendTemplate] No se pudo obtener settings para Account SID:', settingsError);
        throw new Error('No se pudo obtener Account SID desde settings');
      }
      
      const accountSid = siteSettings.channels.whatsapp.account_sid;
      
      console.log('📋 [SendTemplate] Credenciales obtenidas:', {
        hasAccountSid: !!accountSid,
        hasAuthToken: !!authToken,
        accountSidPreview: accountSid ? accountSid.substring(0, 10) + '...' : 'No encontrado',
        authTokenPreview: authToken ? authToken.substring(0, 10) + '...' : 'No encontrado',
        whatsappConfig: siteSettings.channels.whatsapp
      });
      
      if (!accountSid || !authToken) {
        throw new Error('AccountSid or AuthToken missing - accountSid debe estar en settings.channels.whatsapp.account_sid');
      }
      
      return {
        success: true,
        config: {
          accountSid: accountSid, 
          authToken: authToken,
          fromNumber: siteSettings.channels.whatsapp.existingNumber
        }
      };
    } else {
      console.log('❌ [SendTemplate] No se pudo desencriptar el token desde secure_tokens');
      throw new Error('WhatsApp configuration not found in secure_tokens');
    }

  } catch (error) {
    console.error('❌ [SendTemplate] Error obteniendo configuración de WhatsApp:', error);
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to retrieve WhatsApp configuration'
    };
  }
}

// Copia exacta de getTokenFromService de WhatsAppSendService
async function getTokenFromService(siteId: string): Promise<any | null> {
  try {
    console.log('🔓 [SendTemplate] Obteniendo token directamente desde base de datos...');
    
    // 1. Intentar obtener el token del servicio de desencriptación (con try-catch para evitar fallos)
    try {
      const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || 'http://localhost:3000';
      const decryptUrl = new URL('/api/secure-tokens/decrypt', baseUrl).toString();
      
      const response = await fetch(decryptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: siteId,
          token_type: 'twilio_whatsapp'
        })
      });
      
      const result = await response.json();
      
      if (response.ok && result.success && result.data?.tokenValue) {
        console.log('✅ [SendTemplate] Token obtenido del servicio HTTP');
        const decryptedValue = result.data.tokenValue;
        return typeof decryptedValue === 'object' ? decryptedValue : JSON.parse(decryptedValue);
      }
    } catch (httpError) {
      console.log('⚠️ [SendTemplate] Servicio HTTP falló, intentando acceso directo:', httpError);
    }
    
    // 2. Si el servicio falla, obtener directamente de la base de datos
    const { data, error } = await supabaseAdmin
      .from('secure_tokens')
      .select('*')
      .eq('site_id', siteId)
      .eq('token_type', 'twilio_whatsapp')
      .maybeSingle();
    
    if (error) {
      console.error('❌ [SendTemplate] Error consultando secure_tokens:', error);
      return null;
    }
    
    if (!data) {
      console.log('❌ [SendTemplate] No se encontró token en secure_tokens');
      return null;
    }
    
    console.log('📊 [SendTemplate] Token encontrado en base de datos:', {
      id: data.id,
      hasEncryptedValue: !!data.encrypted_value,
      hasValue: !!data.value,
      hasTokenValue: !!data.token_value
    });
    
    // 3. Determinar qué campo usar para desencriptar
    let encryptedValue;
    if (data.encrypted_value) {
      encryptedValue = data.encrypted_value;
    } else if (data.value && typeof data.value === 'string' && data.value.includes(':')) {
      encryptedValue = data.value;
    } else if (data.token_value && typeof data.token_value === 'string' && data.token_value.includes(':')) {
      encryptedValue = data.token_value;
    } else {
      console.log('❌ [SendTemplate] No se encontró valor encriptado válido');
      return null;
    }
    
    console.log('🔐 [SendTemplate] Desencriptando token...');
    
    // 4. Desencriptar el token
    const decryptedValue = decryptToken(encryptedValue);
    
    if (!decryptedValue) {
      console.log('❌ [SendTemplate] Falló la desencriptación');
      return null;
    }
    
    console.log('✅ [SendTemplate] Token desencriptado exitosamente');
    
    // 5. Actualizar last_used si el campo existe
    if (data.hasOwnProperty('last_used')) {
      await supabaseAdmin
        .from('secure_tokens')
        .update({ last_used: new Date().toISOString() })
        .eq('id', data.id);
    }
    
    // 6. Intentar parsear como JSON
    try {
      return JSON.parse(decryptedValue);
    } catch (jsonError) {
      // Si no es JSON, retornar como string
      console.log('⚠️ [SendTemplate] Token no es JSON, retornando como string:', decryptedValue);
      return decryptedValue;
    }
    
  } catch (error) {
    console.error('❌ [SendTemplate] Error obteniendo/desencriptando token:', error);
    return null;
  }
}

// Copia exacta de decryptToken de WhatsAppSendService  
function decryptToken(encryptedValue: string): string | null {
  const CryptoJS = require('crypto-js');
  const encryptionKey = process.env.ENCRYPTION_KEY || '';
  
  if (!encryptionKey) {
    console.error('❌ [SendTemplate] ENCRYPTION_KEY no está configurada');
    return null;
  }
  
  if (encryptedValue.includes(':')) {
    const [salt, encrypted] = encryptedValue.split(':');
    const combinedKey = encryptionKey + salt;
    
    try {
      console.log('🔑 [SendTemplate] Intentando desencriptar con clave del environment...');
      // 1. Intentar con la clave del environment
      const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
      const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
      
      if (decryptedText) {
        console.log('✅ [SendTemplate] Desencriptado exitosamente con clave del environment');
        return decryptedText;
      }

      throw new Error("La desencriptación produjo un texto vacío");
    } catch (error) {
      try {
        console.log('🔑 [SendTemplate] Intentando con clave fija original...');
        // 2. Intentar con la clave fija original
        const originalKey = 'Encryption-key';
        const decrypted = CryptoJS.AES.decrypt(encrypted, originalKey + salt);
        const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
        
        if (decryptedText) {
          console.log('✅ [SendTemplate] Desencriptado exitosamente con clave original');
          return decryptedText;
        }
        
        throw new Error("La desencriptación produjo un texto vacío con clave original");
      } catch (errorOriginal) {
        // 3. Intentar con clave alternativa en desarrollo
        const altEncryptionKey = process.env.ALT_ENCRYPTION_KEY;
        if (altEncryptionKey && process.env.NODE_ENV === 'development') {
          try {
            console.log('🔑 [SendTemplate] Intentando con clave alternativa de desarrollo...');
            const altCombinedKey = altEncryptionKey + salt;
            const decrypted = CryptoJS.AES.decrypt(encrypted, altCombinedKey);
            const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
            
            if (decryptedText) {
              console.log('✅ [SendTemplate] Desencriptado exitosamente con clave alternativa');
              return decryptedText;
            }
          } catch (altError) {
            console.log('❌ [SendTemplate] Falló clave alternativa también');
          }
        }
        
        console.error('❌ [SendTemplate] No se pudo desencriptar el token con ninguna clave disponible');
        return null;
      }
    }
  }
  
  console.error('❌ [SendTemplate] Formato de token no soportado, se esperaba salt:encrypted');
  return null;
}

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

    // Validar que el teléfono tenga formato internacional
    let normalizedPhone = phone_number;
    if (!normalizedPhone.startsWith('+')) {
      normalizedPhone = `+${normalizedPhone}`;
    }

    console.log(`📋 [SendTemplate] Configuración obtenida para site: ${site_id}`);
    console.log(`🔐 [SendTemplate] Usando accountSid: ${config.accountSid.substring(0, 6)}***`);

    // Enviar mensaje usando la plantilla
    const sendResult = await WhatsAppTemplateService.sendMessageWithTemplate(
      normalizedPhone,
      template_id,
      config.accountSid,
      config.authToken,
      config.fromNumber,
      original_message || 'Template message'
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