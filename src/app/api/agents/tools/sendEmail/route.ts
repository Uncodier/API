import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';

/**
 * Endpoint para enviar emails desde un agente
 * 
 * @param request Solicitud entrante con los datos del email a enviar
 * @returns Respuesta con el estado del envío
 * 
 * Parámetros de la solicitud:
 * - email: (Requerido) Email del destinatario
 * - from: (Opcional) Nombre del remitente (el email se obtiene de la configuración del sitio)
 * - subject: (Requerido) Asunto del email
 * - message: (Requerido) Contenido del mensaje
 * - site_id: (Requerido) ID del sitio para obtener configuración SMTP
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { 
      email, 
      from, 
      subject, 
      message,
      agent_id,
      conversation_id,
      lead_id,
      site_id
    } = body;
    
    // Validar parámetros requeridos
    const requiredFields = [
      { field: 'email', value: email },
      { field: 'subject', value: subject },
      { field: 'message', value: message },
      { field: 'site_id', value: site_id }
    ];

    for (const { field, value } of requiredFields) {
      if (!value) {
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
    
    // Obtener configuración del sitio para validar el email del remitente
    const { data: siteSettings, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', site_id)
      .single();
      
    if (settingsError || !siteSettings) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SITE_CONFIG_NOT_FOUND', 
            message: 'Site configuration not found or email not configured' 
          } 
        },
        { status: 404 }
      );
    }
    
    const configuredEmail = siteSettings.channels?.email?.email;
    if (!configuredEmail) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'EMAIL_NOT_CONFIGURED', 
            message: 'Email is not configured for this site. Please configure email in site settings.' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Validar formato del email configurado
    if (!EmailSendService.isValidEmail(configuredEmail)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_CONFIGURED_EMAIL', 
            message: 'The configured email in site settings has an invalid format' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Validar formato del email destinatario
    const targetEmail = email === 'no-email@example.com' ? email : email;
    
    if (targetEmail !== 'no-email@example.com' && !EmailSendService.isValidEmail(targetEmail)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'Invalid recipient email format' 
          } 
        },
        { status: 400 }
      );
    }

    // Generar firma del agente basada en la información del sitio
    let signatureHtml = '';
    try {
      const signature = await EmailSignatureService.generateAgentSignature(site_id, from);
      // Solo usar la versión HTML de la firma, no agregarla al texto plano
      signatureHtml = signature.formatted;
    } catch (signatureError) {
      console.warn('No se pudo generar la firma del agente:', signatureError);
      // Continuar sin firma si hay error
    }

    // Enviar el email usando el servicio
    const result = await EmailSendService.sendEmail({
      email: targetEmail,
      from: from || '', // Nombre del remitente (opcional)
      fromEmail: configuredEmail, // Email del remitente desde configuración
      subject,
      message: message, // Usar el mensaje original sin agregar firma aquí
      signatureHtml, // Pasar la firma HTML
      agent_id,
      conversation_id,
      lead_id,
      site_id
    });

    // 🔍 DEBUG: Verificar qué IDs están disponibles en el resultado
    console.log(`[SEND_EMAIL] 🔍 DEBUG - Resultado del envío:`, {
      success: result.success,
      status: result.status,
      email_id: result.email_id,
      envelope_id: result.envelope_id,
      hasEnvelopeId: !!result.envelope_id,
      willUseEnvelopeId: !!(result.envelope_id && result.status === 'sent'),
      willUseFallback: !!(result.email_id && result.status === 'sent' && !result.envelope_id)
    });

    if (!result.success) {
      const statusCode = result.error?.code === 'EMAIL_CONFIG_NOT_FOUND' ? 404 : 500;
      return NextResponse.json(
        { 
          success: false, 
          error: result.error
        },
        { status: statusCode }
      );
    }

    // 🎯 NUEVO: Guardar el messageId en synced_objects para evitar duplicaciones en sync
    if (result.envelope_id && result.status === 'sent') {
      try {
        await SyncedObjectsService.createObject({
          external_id: result.envelope_id, // 🔄 Usar envelope_id en lugar de email_id para correlación perfecta
          site_id: site_id,
          object_type: 'sent_email',
          status: 'processed', // Marcar como ya procesado
          provider: 'smtp_send_service',
          metadata: {
            // Información del email enviado
            recipient: result.recipient,
            sender: result.sender,
            subject: result.subject,
            message_preview: result.message_preview,
            sent_at: result.sent_at,
            
            // Información del contexto
            agent_id,
            conversation_id,
            lead_id,
            
            // IDs para correlación
            smtp_message_id: result.email_id, // MessageId original del SMTP
            envelope_id: result.envelope_id,  // ID basado en envelope para correlación
            
            // Marcar que fue enviado por API, no sincronizado
            source: 'api_send',
            processed_at: new Date().toISOString()
          }
        });
        
        console.log(`✅ [SEND_EMAIL] Envelope ID ${result.envelope_id} guardado en synced_objects para evitar duplicación en sync`);
      } catch (syncError) {
        // No fallar el envío si hay error guardando en sync, solo logear
        console.warn(`⚠️ [SEND_EMAIL] No se pudo guardar envelope ID en synced_objects:`, syncError);
      }
    } else if (result.email_id && result.status === 'sent') {
      // Fallback: usar email_id si no hay envelope_id (compatibilidad con versiones anteriores)
      try {
        await SyncedObjectsService.createObject({
          external_id: result.email_id, // Fallback al messageId de nodemailer
          site_id: site_id,
          object_type: 'sent_email',
          status: 'processed',
          provider: 'smtp_send_service',
          metadata: {
            recipient: result.recipient,
            sender: result.sender,
            subject: result.subject,
            message_preview: result.message_preview,
            sent_at: result.sent_at,
            agent_id,
            conversation_id,
            lead_id,
            smtp_message_id: result.email_id,
            source: 'api_send_fallback',
            processed_at: new Date().toISOString()
          }
        });
        
        console.log(`✅ [SEND_EMAIL] MessageId ${result.email_id} guardado en synced_objects (fallback) para evitar duplicación en sync`);
      } catch (syncError) {
        console.warn(`⚠️ [SEND_EMAIL] No se pudo guardar messageId en synced_objects (fallback):`, syncError);
      }
    }

    // Agregar external_message_id a la respuesta para metadata del mensaje
    const responseData = {
      ...result,
      external_message_id: result.envelope_id || result.email_id // 🔄 Usar envelope_id cuando esté disponible, fallback a email_id
    };

    const statusCode = result.status === 'skipped' ? 200 : 201;
    return NextResponse.json(responseData, { status: statusCode });
    
  } catch (error) {
    console.error('Error en endpoint send_email_from_agent:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An internal server error occurred while sending the email' 
        } 
      },
      { status: 500 }
    );
  }
} 