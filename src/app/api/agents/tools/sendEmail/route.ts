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
  const startTime = Date.now();
  
  try {
    console.log(`[SEND_EMAIL] 🚀 Iniciando proceso de envío de email`);
    
    const body = await request.json();
    
    // Log inicial con información básica de la request
    console.log(`[SEND_EMAIL] 📋 Request recibida:`, {
      url: request.url,
      method: request.method,
      hasBody: !!body,
      bodySize: JSON.stringify(body).length,
      timestamp: new Date().toISOString()
    });
    
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
    
    // Log detallado de los parámetros recibidos
    console.log(`[SEND_EMAIL] 📝 Parámetros recibidos:`, {
      email: email ? `${email.substring(0, 3)}***${email.includes('@') ? email.substring(email.indexOf('@')) : ''}` : 'undefined',
      from: from || 'no-especificado',
      subject: subject ? `${subject.substring(0, 50)}${subject.length > 50 ? '...' : ''}` : 'undefined',
      messageLength: message?.length || 0,
      agent_id: agent_id || 'no-especificado',
      conversation_id: conversation_id || 'no-especificado',
      lead_id: lead_id || 'no-especificado',
      site_id: site_id || 'undefined'
    });
    
    // Validar parámetros requeridos
    console.log(`[SEND_EMAIL] 🔍 Iniciando validación de parámetros requeridos`);
    
    const requiredFields = [
      { field: 'email', value: email },
      { field: 'subject', value: subject },
      { field: 'message', value: message },
      { field: 'site_id', value: site_id }
    ];

    for (const { field, value } of requiredFields) {
      console.log(`[SEND_EMAIL] 🔍 Validando campo '${field}':`, {
        hasValue: !!value,
        valueType: typeof value,
        valueLength: value?.length || 0,
        isEmpty: value === '' || value === null || value === undefined
      });
      
      if (!value) {
        console.log(`[SEND_EMAIL] ❌ Error de validación: Campo '${field}' requerido no proporcionado`);
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
    
    console.log(`[SEND_EMAIL] ✅ Validación de parámetros requeridos completada exitosamente`);
    
    // Obtener configuración del sitio para validar el email del remitente
    console.log(`[SEND_EMAIL] 🔍 Obteniendo configuración del sitio para site_id: ${site_id}`);
    
    const { data: siteSettings, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', site_id)
      .single();
    
    console.log(`[SEND_EMAIL] 📊 Resultado de consulta de configuración:`, {
      hasData: !!siteSettings,
      hasError: !!settingsError,
      errorCode: settingsError?.code,
      errorMessage: settingsError?.message,
      errorDetails: settingsError?.details,
      dataStructure: siteSettings ? {
        hasChannels: !!siteSettings.channels,
        hasEmailConfig: !!siteSettings.channels?.email,
        emailConfigKeys: siteSettings.channels?.email ? Object.keys(siteSettings.channels.email) : []
      } : null
    });
      
    if (settingsError || !siteSettings) {
      console.log(`[SEND_EMAIL] ❌ Error obteniendo configuración del sitio:`, {
        site_id,
        error: settingsError,
        hasData: !!siteSettings
      });
      
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
    console.log(`[SEND_EMAIL] 📧 Email configurado encontrado:`, {
      hasConfiguredEmail: !!configuredEmail,
      emailMask: configuredEmail ? `${configuredEmail.substring(0, 3)}***${configuredEmail.includes('@') ? configuredEmail.substring(configuredEmail.indexOf('@')) : ''}` : 'no-encontrado',
      channelsStructure: siteSettings.channels ? Object.keys(siteSettings.channels) : []
    });
    
    if (!configuredEmail) {
      console.log(`[SEND_EMAIL] ❌ Email no configurado para el sitio ${site_id}`);
      
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
    console.log(`[SEND_EMAIL] 🔍 Validando formato del email configurado`);
    const isConfiguredEmailValid = EmailSendService.isValidEmail(configuredEmail);
    
    console.log(`[SEND_EMAIL] 📧 Validación de email configurado:`, {
      email: configuredEmail ? `${configuredEmail.substring(0, 3)}***${configuredEmail.includes('@') ? configuredEmail.substring(configuredEmail.indexOf('@')) : ''}` : 'null',
      isValid: isConfiguredEmailValid
    });
    
    if (!isConfiguredEmailValid) {
      console.log(`[SEND_EMAIL] ❌ Email configurado tiene formato inválido: ${configuredEmail}`);
      
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
    console.log(`[SEND_EMAIL] 🔍 Validando formato del email destinatario`);
    
    const isTargetEmailValid = targetEmail === 'no-email@example.com' || EmailSendService.isValidEmail(targetEmail);
    
    console.log(`[SEND_EMAIL] 📧 Validación de email destinatario:`, {
      originalEmail: email ? `${email.substring(0, 3)}***${email.includes('@') ? email.substring(email.indexOf('@')) : ''}` : 'null',
      targetEmail: targetEmail ? `${targetEmail.substring(0, 3)}***${targetEmail.includes('@') ? targetEmail.substring(targetEmail.indexOf('@')) : ''}` : 'null',
      isSpecialCase: targetEmail === 'no-email@example.com',
      isValid: isTargetEmailValid
    });
    
    if (!isTargetEmailValid) {
      console.log(`[SEND_EMAIL] ❌ Email destinatario tiene formato inválido: ${targetEmail}`);
      
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
    console.log(`[SEND_EMAIL] 🖋️ Generando firma del agente para site_id: ${site_id}, from: ${from || 'no-especificado'}`);
    let signatureHtml = '';
    try {
      const signature = await EmailSignatureService.generateAgentSignature(site_id, from);
      // Solo usar la versión HTML de la firma, no agregarla al texto plano
      signatureHtml = signature.formatted;
      
      console.log(`[SEND_EMAIL] ✅ Firma del agente generada exitosamente:`, {
        hasSignature: !!signatureHtml,
        signatureLength: signatureHtml?.length || 0,
        signaturePreview: signatureHtml ? signatureHtml.substring(0, 100) + '...' : 'vacía'
      });
    } catch (signatureError) {
      console.warn(`[SEND_EMAIL] ⚠️ No se pudo generar la firma del agente:`, {
        site_id,
        from,
        error: (signatureError as Error)?.message || String(signatureError),
        errorType: signatureError?.constructor?.name
      });
      // Continuar sin firma si hay error
    }

    // Preparar parámetros para EmailSendService
    const emailParams = {
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
    };
    
    console.log(`[SEND_EMAIL] 📤 Llamando a EmailSendService con parámetros:`, {
      targetEmail: targetEmail ? `${targetEmail.substring(0, 3)}***${targetEmail.includes('@') ? targetEmail.substring(targetEmail.indexOf('@')) : ''}` : 'null',
      fromName: from || 'sin-nombre',
      fromEmail: configuredEmail ? `${configuredEmail.substring(0, 3)}***${configuredEmail.includes('@') ? configuredEmail.substring(configuredEmail.indexOf('@')) : ''}` : 'null',
      subjectLength: subject?.length || 0,
      messageLength: message?.length || 0,
      hasSignature: !!signatureHtml,
      agent_id: agent_id || 'no-especificado',
      conversation_id: conversation_id || 'no-especificado',
      lead_id: lead_id || 'no-especificado',
      site_id: site_id || 'undefined'
    });

    // Enviar el email usando el servicio
    const result = await EmailSendService.sendEmail(emailParams);
    
    console.log(`[SEND_EMAIL] 📨 Resultado de EmailSendService:`, {
      success: result.success,
      status: result.status,
      hasEmailId: !!result.email_id,
      hasEnvelopeId: !!result.envelope_id,
      hasError: !!result.error,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      recipient: result.recipient,
      sender: result.sender,
      sentAt: result.sent_at
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
      console.log(`[SEND_EMAIL] ❌ Error en EmailSendService:`, {
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
        errorDetails: (result.error as any)?.details || result.error,
        site_id,
        targetEmail: targetEmail ? `${targetEmail.substring(0, 3)}***${targetEmail.includes('@') ? targetEmail.substring(targetEmail.indexOf('@')) : ''}` : 'null',
        agent_id: agent_id || 'no-especificado'
      });
      
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
    
    console.log(`[SEND_EMAIL] ✅ Proceso completado exitosamente:`, {
      status: result.status,
      statusCode,
      hasExternalMessageId: !!(result.envelope_id || result.email_id),
      externalMessageId: (result.envelope_id || result.email_id) ? `${(result.envelope_id || result.email_id)!.substring(0, 8)}...` : 'no-disponible',
      recipient: result.recipient,
      duration: `${Date.now() - startTime}ms`
    });
    
    return NextResponse.json(responseData, { status: statusCode });
    
  } catch (error) {
    console.error(`[SEND_EMAIL] 💥 Error crítico en endpoint send_email_from_agent:`, {
      error: (error as Error)?.message || String(error),
      errorType: (error as Error)?.constructor?.name,
      stack: (error as Error)?.stack,
      timestamp: new Date().toISOString(),
      // Información de contexto disponible en este punto
      requestUrl: request?.url,
      requestMethod: request?.method
    });
    
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