import { NextRequest, NextResponse } from 'next/server';
import { WhatsAppTemplateService } from '../../../../../lib/services/whatsapp/WhatsAppTemplateService';
import { WhatsAppSendService } from '../../../../../lib/services/whatsapp/WhatsAppSendService';
import { supabaseAdmin } from '../../../../../lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

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

// Usa el mismo servicio centralizado que tools/sendWhatsApp
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
    const cfg = await WhatsAppSendService.getWhatsAppConfig(siteId);
    if (!cfg?.phoneNumberId || !cfg?.accessToken) {
      return { success: false, error: 'Twilio credentials (Account SID / Auth Token) are missing for this site' };
    }
    return { success: true, config: cfg };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Failed to retrieve WhatsApp configuration' };
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

    // Obtener configuración de WhatsApp (servicio centralizado: settings + secure_tokens; sin .env)
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

// decryptToken eliminado: la desencriptación queda encapsulada en WhatsAppSendService