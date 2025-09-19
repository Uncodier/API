import { NextRequest, NextResponse } from 'next/server';
import { WhatsAppTemplateService } from '../../../../../lib/services/whatsapp/WhatsAppTemplateService';
import { WhatsAppSendService } from '../../../../../lib/services/whatsapp/WhatsAppSendService';
import { supabaseAdmin } from '../../../../../lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';

/**
 * Ruta para determinar si se necesita plantilla y crearla si es necesario
 * 
 * Maneja dos escenarios:
 * A) Dentro de ventana de respuesta (< 24h): retorna template_required: false
 * B) Fuera de ventana (> 24h): crea plantilla y retorna template_required: true
 * 
 * POST /api/agents/whatsapp/createTemplate
 */

interface CreateTemplateRequest {
  phone_number: string;
  message: string;
  site_id: string;
  conversation_id?: string;
  from?: string;
}

interface CreateTemplateResponse {
  success: boolean;
  message_id: string;
  template_required: boolean;
  template_id?: string;
  template_status?: 'created' | 'pending_approval' | 'approved' | 'failed';
  window_hours_elapsed?: number;
  within_window?: boolean;
  error?: string;
  fallback_mode?: boolean;
  note?: string;
}

// Función auxiliar para validar UUID
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para formatear mensaje con información del sitio
async function formatMessageForTemplate(message: string, siteId: string, from?: string): Promise<string> {
  try {
    // Obtener información básica del sitio
    const { data: site, error } = await supabaseAdmin
      .from('sites')
      .select('business_name, business_website, business_description')
      .eq('id', siteId)
      .single();

    if (error || !site) {
      console.log('⚠️ [CreateTemplate] No se pudo obtener información del sitio, usando mensaje original');
      return message;
    }

    // Formatear mensaje con información del sitio si está disponible
    let formattedMessage = message;
    
    // Agregar firma si tenemos información del negocio
    if (site.business_name) {
      if (!message.includes(site.business_name)) {
        formattedMessage += `\n\n---\n${site.business_name}`;
        
        if (site.business_website) {
          formattedMessage += `\n${site.business_website}`;
        }
      }
    }

    return formattedMessage;
  } catch (error) {
    console.warn('⚠️ [CreateTemplate] Error formateando mensaje:', error);
    return message; // Fallback al mensaje original
  }
}

// Función para obtener configuración de WhatsApp del sitio
async function getWhatsAppConfig(siteId: string): Promise<{
  success: boolean;
  config?: {
    phoneNumberId: string;
    accessToken: string;
    fromNumber: string;
  };
  error?: string;
}> {
  try {
    console.log(`🔎 [CreateTemplate] Buscando configuración para site_id: ${siteId}`);
    
    // Obtener configuración del sitio para validar la configuración de WhatsApp
    const { data: siteSettings, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    console.log('📊 [CreateTemplate] Resultado de consulta settings:', {
      siteSettings,
      settingsError: settingsError?.message || settingsError,
      hasData: !!siteSettings
    });
      
    if (settingsError || !siteSettings) {
      console.error('❌ [CreateTemplate] No se encontró configuración del sitio:', {
        site_id: siteId,
        error: settingsError?.message || settingsError,
        hasData: !!siteSettings
      });
      return {
        success: false,
        error: 'Site configuration not found'
      };
    }
    
    console.log('🔧 [CreateTemplate] Configuración de channels encontrada:', {
      channels: siteSettings.channels,
      hasChannels: !!siteSettings.channels,
      hasWhatsApp: !!siteSettings.channels?.whatsapp,
      whatsappConfig: siteSettings.channels?.whatsapp
    });
    
    // Verificar si WhatsApp está configurado (en settings, secure_tokens o variables de entorno)
    const hasWhatsAppInSettings = siteSettings.channels?.whatsapp?.enabled === true;
    const hasWhatsAppInEnv = process.env.WHATSAPP_PHONE_NUMBER_ID && 
                            process.env.WHATSAPP_API_TOKEN;
    
    // Verificar si hay tokens en secure_tokens
    let hasWhatsAppTokens = false;
    let tokensData = null;
    try {
      const { data: tokens } = await supabaseAdmin
        .from('secure_tokens')
        .select('*')
        .eq('token_type', 'twilio_whatsapp')
        .eq('site_id', siteId)
        .eq('status', 'active')
        .limit(1)
        .single();
      hasWhatsAppTokens = !!tokens;
      tokensData = tokens;
    } catch (error) {
      console.warn('⚠️ [CreateTemplate] Error verificando secure_tokens:', error);
    }
    
    console.log('🔍 [CreateTemplate] Verificación de configuraciones:', {
      hasWhatsAppInSettings,
      hasWhatsAppInEnv,
      hasWhatsAppTokens,
      settingsEnabled: siteSettings.channels?.whatsapp?.enabled,
      settingsStatus: siteSettings.channels?.whatsapp?.status,
      envPhoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      envApiToken: !!process.env.WHATSAPP_API_TOKEN
    });
    
    if (!hasWhatsAppInSettings && !hasWhatsAppInEnv && !hasWhatsAppTokens) {
      console.error('❌ [CreateTemplate] WhatsApp no está configurado:', {
        site_id: siteId,
        hasWhatsAppInSettings,
        hasWhatsAppInEnv,
        hasWhatsAppTokens,
        channels: siteSettings.channels
      });
      return {
        success: false,
        error: 'WhatsApp is not configured for this site. Please configure WhatsApp settings, environment variables, or secure tokens.'
      };
    }

    // Determinar fuente de configuración y construir config
    let config: {
      phoneNumberId: string;
      accessToken: string;
      fromNumber: string;
    };

    if (hasWhatsAppTokens && tokensData) {
      // Usar secure_tokens
      console.log('🔐 [CreateTemplate] Usando configuración de secure_tokens');
      config = {
        phoneNumberId: tokensData.token_data?.account_sid || tokensData.identifier,
        accessToken: tokensData.secure_token,
        fromNumber: tokensData.metadata?.from_number || tokensData.identifier
      };
    } else if (hasWhatsAppInEnv) {
      // Usar variables de entorno
      console.log('🌍 [CreateTemplate] Usando configuración de variables de entorno');
      config = {
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
        accessToken: process.env.WHATSAPP_API_TOKEN!,
        fromNumber: process.env.WHATSAPP_PHONE_NUMBER_ID!
      };
    } else {
      // Fallback: intentar obtener de settings si está habilitado
      console.log('⚙️ [CreateTemplate] Usando configuración de settings');
      const whatsappSettings = siteSettings.channels?.whatsapp;
      config = {
        phoneNumberId: whatsappSettings?.phone_number_id || '',
        accessToken: whatsappSettings?.access_token || '',
        fromNumber: whatsappSettings?.from_number || whatsappSettings?.phone_number_id || ''
      };
    }

    console.log('✅ [CreateTemplate] Configuración de WhatsApp obtenida exitosamente');
    
    // Validar que accountSid (phoneNumberId) y accessToken no estén vacíos
    if (!config.phoneNumberId || !config.accessToken) {
      console.warn('⚠️ [CreateTemplate] Faltan credenciales después de primera búsqueda. Intentando variables de entorno estándar de Twilio...');
      const envAccountSid = process.env.TWILIO_ACCOUNT_SID || process.env.WHATSAPP_PHONE_NUMBER_ID;
      const envAuthToken  = process.env.TWILIO_AUTH_TOKEN  || process.env.WHATSAPP_API_TOKEN;
      if (envAccountSid && envAuthToken) {
        config.phoneNumberId = envAccountSid;
        config.accessToken   = envAuthToken;
        console.log('✅ [CreateTemplate] Credenciales obtenidas desde variables de entorno TWILIO_* / WHATSAPP_*');
      }
    }

    // Si aún faltan credenciales, intentar desencriptar desde secure_tokens (optimizado)
    if (!config.phoneNumberId || !config.accessToken) {
      try {
        console.log('🔓 [CreateTemplate] Intentando obtener token desde base de datos (local)...');
        
        // 1. PRIMERO: Intentar obtener directamente de la base de datos (MÁS RÁPIDO)
        const { data: tokenData, error } = await supabaseAdmin
          .from('secure_tokens')
          .select('*')
          .eq('site_id', siteId)
          .eq('token_type', 'twilio_whatsapp')
          .maybeSingle();
        
        if (tokenData?.encrypted_value && !error) {
          console.log('✅ [CreateTemplate] Token encontrado en DB, desencriptando localmente...');
          const decryptedValue = decryptToken(tokenData.encrypted_value);
          if (decryptedValue) {
            config.accessToken = decryptedValue;
            if (!config.phoneNumberId && siteSettings.channels?.whatsapp?.account_sid) {
              config.phoneNumberId = siteSettings.channels.whatsapp.account_sid;
            }
            console.log('✅ [CreateTemplate] Token desencriptado localmente');
          }
        } else {
          // 2. FALLBACK: Intentar desde servicio HTTP (MÁS LENTO)
          console.log('⚠️ [CreateTemplate] Token no encontrado en DB, intentando servicio HTTP...');
          const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || 'http://localhost:3000';
          const decryptUrl = new URL('/api/secure-tokens/decrypt', baseUrl).toString();
          const resp = await fetch(decryptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              site_id: siteId,
              token_type: 'twilio_whatsapp'
            })
          });
          const json = await resp.json();
          if (resp.ok && json.success && json.data?.tokenValue) {
            const tokenValue = typeof json.data.tokenValue === 'string' ? json.data.tokenValue : JSON.stringify(json.data.tokenValue);
            config.accessToken = tokenValue;
            if (!config.phoneNumberId && siteSettings.channels?.whatsapp?.account_sid) {
              config.phoneNumberId = siteSettings.channels.whatsapp.account_sid;
            }
            console.log('✅ [CreateTemplate] Token obtenido del servicio HTTP como fallback');
          }
        }
      } catch (decryptErr) {
        console.warn('⚠️ [CreateTemplate] Error obteniendo token:', decryptErr);
      }
    }

    // Última validación
    if (!config.phoneNumberId || !config.accessToken) {
      console.error('❌ [CreateTemplate] Credenciales de Twilio incompletas tras todas las estrategias');
      return { success: false, error: 'Twilio credentials (Account SID / Auth Token) are missing for this site' };
    }

    return { success: true, config };
    
  } catch (error) {
    console.error('💥 [CreateTemplate] Error obteniendo configuración:', error);
    return {
      success: false,
      error: 'Failed to retrieve WhatsApp configuration'
    };
  }
}

/**
 * POST handler - Verificar ventana y crear plantilla si es necesario
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📝 [CreateTemplate] Iniciando verificación de plantilla...');
    
    const body: CreateTemplateRequest = await request.json();
    const { phone_number, message, site_id, conversation_id, from } = body;

    // Validar campos requeridos
    if (!phone_number || !message || !site_id) {
      return NextResponse.json({
        success: false,
        error: 'phone_number, message, and site_id are required'
      } as CreateTemplateResponse, { status: 400 });
    }

    // Validar site_id UUID
    if (!isValidUUID(site_id)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid site_id format'
      } as CreateTemplateResponse, { status: 400 });
    }

    // Generar message_id único para tracking
    const messageId = uuidv4();
    console.log(`🆔 [CreateTemplate] Message ID generado: ${messageId}`);

    // Verificar ventana de respuesta
    console.log('🕐 [CreateTemplate] Verificando ventana de respuesta...');
    const windowCheck = await WhatsAppTemplateService.checkResponseWindow(
      conversation_id || null,
      phone_number,
      site_id
    );

    console.log(`⏰ [CreateTemplate] Resultado de ventana:`, {
      withinWindow: windowCheck.withinWindow,
      hoursElapsed: windowCheck.hoursElapsed,
      requiresTemplate: !windowCheck.withinWindow
    });

    // ESCENARIO A: Dentro de ventana de respuesta
    if (windowCheck.withinWindow) {
      console.log('✅ [CreateTemplate] Dentro de ventana - no se requiere plantilla');
      
      return NextResponse.json({
        success: true,
        message_id: messageId,
        template_required: false,
        within_window: true,
        window_hours_elapsed: windowCheck.hoursElapsed
      } as CreateTemplateResponse);
    }

    // ESCENARIO B: Fuera de ventana - crear plantilla
    console.log('📝 [CreateTemplate] Fuera de ventana - creando plantilla...');

    // Obtener configuración de WhatsApp
    const configResult = await getWhatsAppConfig(site_id);
    if (!configResult.success) {
      return NextResponse.json({
        success: false,
        error: configResult.error
      } as CreateTemplateResponse, { status: 404 });
    }

    const { config } = configResult;

    // Garantizar que config existe
    if (!config) {
      return NextResponse.json({
        success: false,
        error: 'WhatsApp configuration not available'
      } as CreateTemplateResponse, { status: 500 });
    }

    // Formatear mensaje (implementación simplificada)
    const formattedMessage = await formatMessageForTemplate(message, site_id, from);

    // Buscar plantilla existente similar
    console.log('🔍 [CreateTemplate] Buscando plantilla existente...');
    const existingTemplate = await WhatsAppTemplateService.findExistingTemplate(
      formattedMessage,
      site_id,
      config.phoneNumberId
    );

    if (existingTemplate?.templateSid) {
      console.log(`♻️ [CreateTemplate] Plantilla existente encontrada: ${existingTemplate.templateSid}`);
      
      return NextResponse.json({
        success: true,
        message_id: messageId,
        template_required: true,
        template_id: existingTemplate.templateSid,
        template_status: 'approved',
        within_window: false,
        window_hours_elapsed: windowCheck.hoursElapsed
      } as CreateTemplateResponse);
    }

    // Crear nueva plantilla con manejo mejorado de errores
    console.log('🆕 [CreateTemplate] Creando nueva plantilla...');
    const templateResult = await WhatsAppTemplateService.createTemplate(
      formattedMessage,
      config.phoneNumberId,
      config.accessToken,
      site_id
    );

    if (!templateResult.success) {
      console.error('❌ [CreateTemplate] Error creando plantilla:', templateResult.error);
      
      // Determinar si es un error de conectividad/DNS
      const isConnectivityError = templateResult.error?.includes('DNS resolution failed') ||
                                 templateResult.error?.includes('ENOTFOUND') ||
                                 templateResult.error?.includes('Request timeout') ||
                                 templateResult.error?.includes('Connection refused');
      
      // Si es error de conectividad, intentar estrategia de fallback
      if (isConnectivityError) {
        console.log('🔄 [CreateTemplate] Error de conectividad detectado, implementando fallback...');
        
        // Estrategia de fallback: marcar como "pending" y permitir que se resuelva en background
        // Esto permite que el flujo continúe sin bloquear al usuario
        try {
          const fallbackTemplateId = `fallback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          // Guardar como pendiente para reintento posterior
          await supabaseAdmin
            .from('whatsapp_template_tracking')
            .insert([{
              message_id: messageId,
              template_sid: fallbackTemplateId,
              site_id: site_id,
              phone_number: phone_number,
              original_message: message,
              formatted_message: formattedMessage,
              status: 'pending_retry',
              error_reason: templateResult.error,
              created_at: new Date().toISOString(),
              retry_count: 0
            }]);
          
          console.log('📝 [CreateTemplate] Template marcado para reintento con ID:', fallbackTemplateId);
          
          return NextResponse.json({
            success: true, // Marcar como éxito para no bloquear el flujo
            message_id: messageId,
            template_required: true,
            template_id: fallbackTemplateId,
            template_status: 'pending_approval', // Estado que indica que necesita ser procesado
            within_window: false,
            window_hours_elapsed: windowCheck.hoursElapsed,
            fallback_mode: true,
            note: 'Template creation is pending due to connectivity issues. It will be retried automatically.'
          } as CreateTemplateResponse);
          
        } catch (fallbackError) {
          console.error('❌ [CreateTemplate] Error en estrategia de fallback:', fallbackError);
        }
      }
      
      // Si no es error de conectividad o el fallback falló, devolver error original
      return NextResponse.json({
        success: false,
        message_id: messageId,
        error: `Failed to create template: ${templateResult.error}`,
        within_window: false,
        window_hours_elapsed: windowCheck.hoursElapsed
      } as CreateTemplateResponse, { status: 500 });
    }

    console.log(`✅ [CreateTemplate] Plantilla creada exitosamente: ${templateResult.templateSid}`);

    // Guardar relación message_id -> template_id para tracking
    try {
      await supabaseAdmin
        .from('whatsapp_template_tracking')
        .insert([{
          message_id: messageId,
          template_sid: templateResult.templateSid,
          site_id: site_id,
          phone_number: phone_number,
          original_message: message,
          formatted_message: formattedMessage,
          status: 'created',
          created_at: new Date().toISOString()
        }]);
    } catch (trackingError) {
      console.warn('⚠️ [CreateTemplate] Error guardando tracking (no crítico):', trackingError);
    }

    return NextResponse.json({
      success: true,
      message_id: messageId,
      template_required: true,
      template_id: templateResult.templateSid,
      template_status: 'created',
      within_window: false,
      window_hours_elapsed: windowCheck.hoursElapsed
    } as CreateTemplateResponse);

  } catch (error) {
    console.error('❌ [CreateTemplate] Error general:', error);
    
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
      message_id: uuidv4() // Generar ID aunque falle para consistencia
    } as CreateTemplateResponse, { status: 500 });
  }
}

/**
 * GET handler - Verificar estado de plantilla por message_id
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const messageId = searchParams.get('message_id');

    if (!messageId) {
      return NextResponse.json({
        success: false,
        error: 'message_id is required'
      }, { status: 400 });
    }

    console.log(`🔍 [CreateTemplate] Verificando estado de message_id: ${messageId}`);

    // Buscar en tracking
    const { data: tracking, error } = await supabaseAdmin
      .from('whatsapp_template_tracking')
      .select('*')
      .eq('message_id', messageId)
      .single();

    if (error || !tracking) {
      return NextResponse.json({
        success: false,
        error: 'Message ID not found'
      }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message_id: messageId,
      template_id: tracking.template_sid,
      template_status: tracking.status,
      phone_number: tracking.phone_number,
      created_at: tracking.created_at
    });

  } catch (error) {
    console.error('❌ [CreateTemplate] Error en GET:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error'
    }, { status: 500 });
  }
}

/**
 * Desencripta un token usando CryptoJS (copia de WhatsAppSendService)
 */
function decryptToken(encryptedValue: string): string | null {
  const encryptionKey = process.env.ENCRYPTION_KEY || '';
  
  if (!encryptionKey) {
    console.error("Missing ENCRYPTION_KEY environment variable");
    return null;
  }
  
  if (encryptedValue.includes(':')) {
    const [salt, encrypted] = encryptedValue.split(':');
    const combinedKey = encryptionKey + salt;
    
    try {
      const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
      const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
      
      if (decryptedText) {
        return decryptedText;
      }
    } catch (error) {
      console.error('Error desencriptando token:', error);
    }
  }
  
  return null;
} 