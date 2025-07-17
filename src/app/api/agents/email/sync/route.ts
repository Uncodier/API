/**
 * API de Email Sync - Sincroniza emails enviados con leads y conversaciones
 * Route: POST /api/agents/email/sync
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';
import { ConversationService } from '@/lib/services/conversation-service';
import { createTask } from '@/lib/database/task-db';

// Create schemas for request validation
const EmailSyncRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().default(10).optional(),
  since_date: z.string().optional().refine(
    (date) => !date || !isNaN(Date.parse(date)),
    "since_date debe ser una fecha válida en formato ISO"
  ),
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMAIL_CONFIG_NOT_FOUND: 'EMAIL_CONFIG_NOT_FOUND',
  EMAIL_FETCH_ERROR: 'EMAIL_FETCH_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
};

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Función para buscar un lead por email
 */
async function findLeadByEmail(email: string, siteId: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 🔍 Buscando lead por email: ${email} en sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('email', email)
      .eq('site_id', siteId)
      .limit(1);
    
    if (error) {
      console.error('[EMAIL_SYNC] Error al buscar lead por email:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`[EMAIL_SYNC] ⚠️ No se encontró lead con email: ${email}`);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ✅ Lead encontrado con ID: ${data[0].id}`);
    return data[0].id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al buscar lead por email:', error);
    return null;
  }
}

/**
 * Función para crear un nuevo lead basado en email enviado
 */
async function createLeadFromSentEmail(toEmail: string, siteId: string, emailSubject: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] ➕ Creando nuevo lead para email: ${toEmail} en sitio: ${siteId}`);
    
    // Obtener información del sitio para user_id
    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', siteId)
      .single();
      
    if (siteError || !site) {
      console.error('[EMAIL_SYNC] Error al obtener información del sitio:', siteError);
      return null;
    }
    
    // Extraer nombre del email si es posible
    const extractedName = toEmail.split('@')[0].replace(/[._]/g, ' ').trim();
    const leadName = extractedName || 'Contact from Email';
    
    const leadData = {
      email: toEmail,
      name: leadName,
      status: 'contacted',
      origin: 'email',
      site_id: siteId,
      user_id: site.user_id,
      notes: `Lead creado automáticamente desde email enviado: "${emailSubject}"`
    };
    
    const { data, error } = await supabaseAdmin
      .from('leads')
      .insert([leadData])
      .select()
      .single();
      
    if (error) {
      console.error('[EMAIL_SYNC] Error al crear lead:', error);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ✅ Nuevo lead creado con ID: ${data.id}`);
    return data.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al crear lead:', error);
    return null;
  }
}

/**
 * Función para actualizar status del lead a 'contacted' si es necesario
 */
async function updateLeadStatusIfNeeded(leadId: string): Promise<boolean> {
  try {
    console.log(`[EMAIL_SYNC] 📝 Verificando status del lead: ${leadId}`);
    
    // Obtener status actual del lead
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('status')
      .eq('id', leadId)
      .single();
      
    if (leadError || !lead) {
      console.error('[EMAIL_SYNC] Error al obtener lead:', leadError);
      return false;
    }
    
    // Si el status actual no es al menos 'contacted', actualizarlo
    const currentStatus = lead.status;
    const statusHierarchy = ['new', 'contacted', 'qualified', 'converted'];
    const currentIndex = statusHierarchy.indexOf(currentStatus);
    const contactedIndex = statusHierarchy.indexOf('contacted');
    
    if (currentIndex < contactedIndex || currentIndex === -1) {
      console.log(`[EMAIL_SYNC] 🔄 Actualizando status de '${currentStatus}' a 'contacted'`);
      
      const { error: updateError } = await supabaseAdmin
        .from('leads')
        .update({ 
          status: 'contacted',
          updated_at: new Date().toISOString()
        })
        .eq('id', leadId);
        
      if (updateError) {
        console.error('[EMAIL_SYNC] Error al actualizar status del lead:', updateError);
        return false;
      }
      
      console.log(`[EMAIL_SYNC] ✅ Status del lead actualizado a 'contacted'`);
      return true;
    } else {
      console.log(`[EMAIL_SYNC] ℹ️ Lead ya tiene status '${currentStatus}', no se actualiza`);
      return false;
    }
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al actualizar status del lead:', error);
    return false;
  }
}

/**
 * Función para buscar o crear conversación de email para el lead
 */
async function findOrCreateEmailConversation(leadId: string, siteId: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 💬 Buscando conversación de email para lead: ${leadId}`);
    
    // Buscar conversación existente de email (últimos 30 días)
    const existingConversationId = await ConversationService.findExistingConversation(
      leadId,
      undefined, // visitorId
      siteId,
      'email' // origin/channel
    );
    
    if (existingConversationId) {
      console.log(`[EMAIL_SYNC] ✅ Conversación de email existente encontrada: ${existingConversationId}`);
      return existingConversationId;
    }
    
    // Crear nueva conversación de email
    console.log(`[EMAIL_SYNC] ➕ Creando nueva conversación de email para lead: ${leadId}`);
    
    // Obtener información del lead para el título
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('name, email, user_id')
      .eq('id', leadId)
      .single();
      
    if (leadError || !lead) {
      console.error('[EMAIL_SYNC] Error al obtener información del lead para conversación:', leadError);
      return null;
    }
    
    const conversationData = {
      lead_id: leadId,
      site_id: siteId,
      user_id: lead.user_id,
      channel: 'email',
      title: `Email Conversation - ${lead.name || lead.email}`,
      status: 'active',
      custom_data: {
        channel: 'email',
        sync_source: 'sent_email'
      }
    };
    
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .insert([conversationData])
      .select()
      .single();
      
    if (convError) {
      console.error('[EMAIL_SYNC] Error al crear conversación:', convError);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ✅ Nueva conversación de email creada: ${conversation.id}`);
    return conversation.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al buscar/crear conversación:', error);
    return null;
  }
}

/**
 * Función para agregar mensaje enviado a la conversación
 */
async function addSentMessageToConversation(
  conversationId: string, 
  email: any, 
  leadId: string, 
  siteId: string
): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 📧 Agregando mensaje enviado a conversación: ${conversationId}`);
    
    // Obtener user_id de la conversación
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('user_id')
      .eq('id', conversationId)
      .single();
      
    if (convError || !conversation) {
      console.error('[EMAIL_SYNC] Error al obtener conversación:', convError);
      return null;
    }
    
    const messageContent = `Subject: ${email.subject || 'No Subject'}
    
${email.body || 'No content available'}`;
    
    const messageData = {
      conversation_id: conversationId,
      content: messageContent,
      role: 'user', // Nosotros enviamos el email, somos el 'user'
      user_id: conversation.user_id,
      lead_id: leadId,
      custom_data: {
        type: 'sent_email',
        email_id: email.id,
        subject: email.subject,
        to: email.to,
        from: email.from,
        date: email.date,
        sync_source: 'email_sync'
      }
    };
    
    const { data: message, error: messageError } = await supabaseAdmin
      .from('messages')
      .insert([messageData])
      .select()
      .single();
      
    if (messageError) {
      console.error('[EMAIL_SYNC] Error al crear mensaje:', messageError);
      return null;
    }
    
    // Actualizar timestamp de última actividad de la conversación
    await supabaseAdmin
      .from('conversations')
      .update({ 
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId);
    
    console.log(`[EMAIL_SYNC] ✅ Mensaje enviado agregado a conversación: ${message.id}`);
    return message.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al agregar mensaje a conversación:', error);
    return null;
  }
}

/**
 * Función para verificar si el lead tiene tareas de awareness y crear si es necesario
 */
async function createFirstContactTaskIfNeeded(leadId: string, siteId: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_SYNC] 📋 Verificando tareas de awareness para lead: ${leadId}`);
    
    // Buscar tareas existentes en stage 'awareness'
    const { data: existingTasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id')
      .eq('lead_id', leadId)
      .eq('stage', 'awareness')
      .limit(1);
      
    if (tasksError) {
      console.error('[EMAIL_SYNC] Error al buscar tareas de awareness:', tasksError);
      return null;
    }
    
    if (existingTasks && existingTasks.length > 0) {
      console.log(`[EMAIL_SYNC] ℹ️ Lead ya tiene tareas de awareness, no se crea nueva`);
      return null;
    }
    
    // Obtener información del lead para la tarea
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('name, email, user_id')
      .eq('id', leadId)
      .single();
      
    if (leadError || !lead) {
      console.error('[EMAIL_SYNC] Error al obtener información del lead para tarea:', leadError);
      return null;
    }
    
    console.log(`[EMAIL_SYNC] ➕ Creando tarea de first contact para lead: ${leadId}`);
    
    const taskData = {
      title: `First Contact - ${lead.name || lead.email}`,
      description: `Tarea de primer contacto creada automáticamente al sincronizar email enviado. El lead ha sido contactado por primera vez vía email.`,
      type: 'first_contact',
      status: 'completed', // Marcada como completada porque ya se envió el email
      stage: 'awareness',
      priority: 1,
      user_id: lead.user_id,
      site_id: siteId,
      lead_id: leadId,
      scheduled_date: new Date().toISOString(),
      completed_date: new Date().toISOString(),
      notes: `Auto-created from email sync. First email sent to lead successfully.`
    };
    
    const task = await createTask(taskData);
    console.log(`[EMAIL_SYNC] ✅ Tarea de first contact creada: ${task.id}`);
    
    return task.id;
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al crear tarea de first contact:', error);
    return null;
  }
}

/**
 * Función para procesar un email enviado individual
 */
async function processSentEmail(email: any, siteId: string): Promise<{
  success: boolean;
  leadId?: string;
  conversationId?: string;
  messageId?: string;
  taskId?: string;
  isNewLead?: boolean;
  statusUpdated?: boolean;
  error?: string;
}> {
  try {
    console.log(`[EMAIL_SYNC] 🔄 Procesando email enviado a: ${email.to}`);
    
    const toEmail = email.to;
    if (!toEmail || !toEmail.includes('@')) {
      return {
        success: false,
        error: 'Email destinatario inválido'
      };
    }
    
    // 1. Buscar o crear lead
    let leadId = await findLeadByEmail(toEmail, siteId);
    let isNewLead = false;
    
    if (!leadId) {
      leadId = await createLeadFromSentEmail(toEmail, siteId, email.subject || 'No Subject');
      isNewLead = true;
    }
    
    if (!leadId) {
      return {
        success: false,
        error: 'No se pudo obtener o crear lead'
      };
    }
    
    // 2. Actualizar status del lead si es necesario
    const statusUpdated = await updateLeadStatusIfNeeded(leadId);
    
    // 3. Buscar o crear conversación de email
    const conversationId = await findOrCreateEmailConversation(leadId, siteId);
    
    if (!conversationId) {
      return {
        success: false,
        leadId,
        isNewLead,
        statusUpdated,
        error: 'No se pudo obtener o crear conversación'
      };
    }
    
    // 4. Agregar mensaje enviado a la conversación
    const messageId = await addSentMessageToConversation(conversationId, email, leadId, siteId);
    
    // 5. Crear tarea de first contact si es necesario
    const taskId = await createFirstContactTaskIfNeeded(leadId, siteId);
    
    return {
      success: true,
      leadId,
      conversationId,
      messageId: messageId || undefined,
      taskId: taskId || undefined,
      isNewLead,
      statusUpdated
    };
    
  } catch (error) {
    console.error('[EMAIL_SYNC] Error al procesar email enviado:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error desconocido'
    };
  }
}

// Main POST endpoint to sync sent emails
export async function POST(request: NextRequest) {
  try {
    // Get and validate request data
    const requestData = await request.json();
    console.log('[EMAIL_SYNC] Request data received:', JSON.stringify(requestData, null, 2));
    
    // Normalizar datos del request para aceptar tanto camelCase como snake_case
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    console.log('[EMAIL_SYNC] Normalized data:', JSON.stringify(normalizedData, null, 2));
    
    const validationResult = EmailSyncRequestSchema.safeParse(normalizedData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_SYNC] Validation error details:", JSON.stringify({
        error: validationResult.error.format(),
        issues: validationResult.error.issues,
      }, null, 2));
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: "Parámetros de solicitud inválidos",
            details: validationResult.error.format(),
          },
        },
        { status: 400 }
      );
    }
    
    console.log('[EMAIL_SYNC] Validation successful, parsed data:', JSON.stringify(validationResult.data, null, 2));
    
    // Extraer parámetros usando getFlexibleProperty para máxima compatibilidad
    const siteId = getFlexibleProperty(requestData, 'site_id') || validationResult.data.site_id;
    const limit = getFlexibleProperty(requestData, 'limit') || validationResult.data.limit || 10;
    const sinceDate = getFlexibleProperty(requestData, 'since_date') || validationResult.data.since_date;
    
    console.log('[EMAIL_SYNC] Extracted parameters:', {
      siteId, limit, sinceDate
    });
    
    try {
      // Get email configuration
      console.log(`[EMAIL_SYNC] 🔧 Obteniendo configuración de email para sitio: ${siteId}`);
      const emailConfig = await EmailConfigService.getEmailConfig(siteId);
      console.log(`[EMAIL_SYNC] ✅ Configuración de email obtenida exitosamente`);
      
      // Fetch sent emails
      console.log(`[EMAIL_SYNC] 📤 Obteniendo emails ENVIADOS con límite: ${limit}, desde: ${sinceDate || 'sin límite de fecha'}`);
      const sentEmails = await EmailService.fetchSentEmails(emailConfig, limit, sinceDate);
      console.log(`[EMAIL_SYNC] ✅ Emails enviados obtenidos exitosamente: ${sentEmails.length} emails`);
      
      if (sentEmails.length === 0) {
        return NextResponse.json({
          success: true,
          message: "No se encontraron emails enviados para sincronizar",
          emailCount: 0,
          processedCount: 0,
          results: []
        });
      }
      
      // Procesar cada email enviado
      console.log(`[EMAIL_SYNC] 🔄 Procesando ${sentEmails.length} emails enviados...`);
      const results = [];
      let processedCount = 0;
      let newLeadsCount = 0;
      let statusUpdatedCount = 0;
      let tasksCreatedCount = 0;
      
      for (const email of sentEmails) {
        const result = await processSentEmail(email, siteId);
        results.push({
          email_to: email.to,
          email_subject: email.subject,
          email_date: email.date,
          ...result
        });
        
        if (result.success) {
          processedCount++;
          if (result.isNewLead) newLeadsCount++;
          if (result.statusUpdated) statusUpdatedCount++;
          if (result.taskId) tasksCreatedCount++;
        }
      }
      
      console.log(`[EMAIL_SYNC] ✅ Sincronización completada:`);
      console.log(`[EMAIL_SYNC] - Emails enviados encontrados: ${sentEmails.length}`);
      console.log(`[EMAIL_SYNC] - Emails procesados exitosamente: ${processedCount}`);
      console.log(`[EMAIL_SYNC] - Nuevos leads creados: ${newLeadsCount}`);
      console.log(`[EMAIL_SYNC] - Leads con status actualizado: ${statusUpdatedCount}`);
      console.log(`[EMAIL_SYNC] - Tareas de first contact creadas: ${tasksCreatedCount}`);
      
      return NextResponse.json({
        success: true,
        message: "Sincronización de emails enviados completada exitosamente",
        emailCount: sentEmails.length,
        processedCount,
        newLeadsCount,
        statusUpdatedCount,
        tasksCreatedCount,
        results
      });
      
    } catch (error: unknown) {
      console.error(`[EMAIL_SYNC] 💥 Error en el flujo principal:`, error);
      console.error(`[EMAIL_SYNC] 📋 Detalles del error:`, {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
      
      const isConfigError = error instanceof Error && (
        error.message.includes('settings') || 
        error.message.includes('token')
      );
        
      const errorCode = isConfigError ? ERROR_CODES.EMAIL_CONFIG_NOT_FOUND : ERROR_CODES.EMAIL_FETCH_ERROR;
      const errorMessage = error instanceof Error ? error.message : "Error procesando emails enviados";
      
      console.error(`[EMAIL_SYNC] 🚨 Retornando error: ${errorCode} - ${errorMessage}`);
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
          },
        },
        { status: isConfigError ? 404 : 500 }
      );
    }
  } catch (error: unknown) {
    return NextResponse.json({
      success: false,
      error: {
        code: ERROR_CODES.SYSTEM_ERROR,
        message: error instanceof Error ? error.message : "Error interno del sistema",
      }
    }, { status: 500 });
  }
}

// GET method for information about the endpoint
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    message: "This endpoint synchronizes sent emails with leads, conversations, and customer journey. Use POST method with site_id, optional limit and since_date parameters.",
    method: "POST",
    required_parameters: ["site_id"],
    optional_parameters: ["limit", "since_date"],
    description: "Fetches sent emails, creates/updates leads, manages email conversations, updates lead status to 'contacted', and creates 'first contact' tasks for customer journey awareness stage."
  }, { status: 200 });
} 