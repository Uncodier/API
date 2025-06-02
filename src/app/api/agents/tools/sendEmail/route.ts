import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';

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

    const statusCode = result.status === 'skipped' ? 200 : 201;
    return NextResponse.json(result, { status: statusCode });
    
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

/**
 * Endpoint GET para consultar el estado de emails enviados
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const emailId = searchParams.get('email_id');
    const agentId = searchParams.get('agent_id');
    const conversationId = searchParams.get('conversation_id');
    const limit = parseInt(searchParams.get('limit') || '10');
    
    // Construir query base
    let query = supabaseAdmin.from('email_logs').select('*');
    
    // Aplicar filtros
    if (emailId) {
      query = query.eq('smtp_message_id', emailId);
    }
    
    if (agentId) {
      query = query.eq('agent_id', agentId);
    }
    
    if (conversationId) {
      query = query.eq('conversation_id', conversationId);
    }
    
    // Aplicar límite y ordenamiento
    query = query.order('sent_at', { ascending: false }).limit(limit);
    
    const { data: emailLogs, error } = await query;
    
    if (error) {
      console.error('Error al consultar logs de emails:', error);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'Failed to retrieve email logs' 
          } 
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json({
      success: true,
      emails: emailLogs || [],
      count: emailLogs?.length || 0
    });
    
  } catch (error) {
    console.error('Error en consulta de emails:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'An internal server error occurred while retrieving email logs' 
        } 
      },
      { status: 500 }
    );
  }
} 