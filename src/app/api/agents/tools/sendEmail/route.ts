import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmailSendService } from '@/lib/services/email/EmailSendService';

/**
 * Endpoint para enviar emails desde un agente
 * 
 * @param request Solicitud entrante con los datos del email a enviar
 * @returns Respuesta con el estado del envío
 * 
 * Parámetros de la solicitud:
 * - email: (Requerido) Email del destinatario
 * - from: (Requerido) Email del remitente
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
      { field: 'from', value: from },
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
    
    // Validar formato de emails
    const targetEmail = email === 'no-email@example.com' ? email : email;
    
    if (targetEmail !== 'no-email@example.com' && !EmailSendService.isValidEmail(targetEmail)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'Invalid email format' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!EmailSendService.isValidEmail(from)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'Invalid from email format' 
          } 
        },
        { status: 400 }
      );
    }

    // Enviar el email usando el servicio
    const result = await EmailSendService.sendEmail({
      email: targetEmail,
      from,
      subject,
      message,
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