import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { TeamNotificationService, type NotifyTeamResult } from '@/lib/services/team-notification-service';
import { VisitorNotificationService } from '@/lib/services/visitor-notification-service';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { ChannelSendService, sanitizeZavuRecipient } from '@/lib/services/channels/ChannelSendService';
import { createHash } from 'crypto';

export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export async function notifyVoiceTeamWithinBudget(
  params: Parameters<typeof TeamNotificationService.notifyHumanIntervention>[0]
): Promise<{ result: NotifyTeamResult | null; timedOut: boolean }> {
  // The caller-facing voice tool has a short response budget. Keep the ongoing
  // team notification alive after the response without claiming it was accepted.
  const notification = Promise.resolve()
    .then(() => TeamNotificationService.notifyHumanIntervention(params))
    .catch(() => null);
  try {
    after(async () => { await notification; });
  } catch {
    // A missing request lifecycle must not hide a task that already persisted.
    // The promise still handles late rejection, even without after support.
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      notification.then(result => ({ result, timedOut: false })),
      new Promise<{ result: null; timedOut: boolean }>(resolve => {
        timer = setTimeout(() => resolve({ result: null, timedOut: true }), 2_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Crea un task de soporte para el lead asociado a la conversación
 */
export async function createSupportTask(
  conversationId: string,
  leadId: string | null,
  siteId: string,
  userId: string,
  message: string,
  summary?: string,
  contactName?: string,
  priorityInput?: 'low' | 'normal' | 'high' | 'urgent' | number
): Promise<string | null> {
  try {
    if (!leadId) {
      console.log('No se puede crear task de soporte: no hay lead asociado a la conversación');
      return null;
    }

    console.log(`📋 Creando task de soporte para lead: ${leadId}`);

    // Obtener información del lead para usar en el task
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('name, email')
      .eq('id', leadId)
      .maybeSingle();

    if (leadError) {
      // Permitir continuar si el error es por no encontrar filas (PGRST116)
      if (leadError.code && leadError.code !== 'PGRST116') {
        console.error('Error al obtener información del lead para el task:', leadError);
        return null;
      }
    }

    // Generar un serial_id determinístico para idempotencia de esta solicitud
    const hashInput = `${conversationId}|${leadId}|${(message || '').slice(0, 200)}|${summary || ''}`;
    const serialId = `SUPPORT-${createHash('sha256').update(hashInput).digest('hex').slice(0, 24)}`;

    // Dedupe 1: verificar por serial_id existente
    const { data: existingBySerial, error: existingSerialError } = await supabaseAdmin
      .from('tasks')
      .select('id, serial_id, created_at')
      .eq('serial_id', serialId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!existingSerialError && existingBySerial && existingBySerial.length > 0) {
      const existing = existingBySerial[0];
      console.log(`🔁 Task de soporte ya existe por serial_id (${existing.serial_id}): ${existing.id}`);
      return existing.id;
    }

    // Dedupe 2: verificar por conversación/tipo/estado reciente (protege contra reintentos sin mismo payload)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentTasks, error: recentError } = await supabaseAdmin
      .from('tasks')
      .select('id, created_at, type, status, conversation_id, lead_id')
      .eq('conversation_id', conversationId)
      .eq('lead_id', leadId)
      .eq('type', 'support')
      .in('status', ['pending', 'active'])
      .gte('created_at', tenMinutesAgo)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!recentError && recentTasks && recentTasks.length > 0) {
      console.log(`🔁 Task de soporte duplicado detectado en ventana reciente, reutilizando ${recentTasks[0].id}`);
      return recentTasks[0].id;
    }

    // Preparar datos para el task
    const taskTitleName = contactName || lead?.name || 'Lead';
    // Map incoming priority to numeric; default to low (0)
    const priorityMap: Record<string, number> = {
      low: 0,
      normal: 1,
      high: 10,
      urgent: 15
    };
    const normalizedPriority = (() => {
      if (typeof priorityInput === 'number' && Number.isFinite(priorityInput)) {
        return priorityInput;
      }
      if (typeof priorityInput === 'string') {
        const key = priorityInput.toLowerCase();
        if (key in priorityMap) return priorityMap[key];
        const parsed = parseInt(priorityInput, 10);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return 0; // low default
    })();

    const taskData = {
      lead_id: leadId,
      conversation_id: conversationId,
      title: `Soporte solicitado - ${taskTitleName}`,
      description: `Tarea de soporte creada automáticamente cuando el usuario solicitó ayuda humana.\n\nMensaje del usuario: "${message}"${summary ? `\n\nResumen de la conversación: ${summary}` : ''}`,
      type: 'support',
      stage: 'retention',
      status: 'pending',
      priority: normalizedPriority,
      user_id: userId,
      site_id: siteId,
      scheduled_date: new Date().toISOString(),
      notes: `Intervención humana solicitada. Conversación ID: ${conversationId}`,
      serial_id: serialId
    };

    console.log(`📋 Datos para el task de soporte:`, JSON.stringify(taskData));

    // Insertar el task en la base de datos
    const { data: task, error: taskError } = await supabaseAdmin
      .from('tasks')
      .insert([taskData])
      .select()
      .maybeSingle();

    if (taskError) {
      console.error('Error al crear task de soporte:', taskError);
      return null;
    }

    console.log(`✅ Task de soporte creado exitosamente: ${task.id}`);
    return task.id;

  } catch (error) {
    console.error('Error inesperado al crear task de soporte:', error);
    return null;
  }
}

/**
 * Función para enviar respuesta automática via WhatsApp
 */
export async function sendWhatsAppAutoResponse(
  conversationData: any,
  message: string,
  contactName?: string
): Promise<boolean> {
  try {
    console.log(`📱 Enviando respuesta automática vía WhatsApp para conversación ${conversationData.id}`);

    // Obtener el número de teléfono desde custom_data
    let phoneNumber: string | null = null;

    if (conversationData.custom_data?.whatsapp_phone) {
      phoneNumber = conversationData.custom_data.whatsapp_phone;
    } else if (conversationData.custom_data?.phone) {
      phoneNumber = conversationData.custom_data.phone;
    }

    if (!phoneNumber) {
      console.error('❌ No se encontró número de teléfono en la conversación de WhatsApp');
      return false;
    }

    // Mensaje automático informando que se contactará un humano
    const autoMessage = `Hola ${contactName || 'estimado/a cliente'}, ` +
      `hemos recibido tu solicitud de ayuda: "${message}". ` +
      `Un miembro de nuestro equipo se pondrá en contacto contigo pronto. ` +
      `Gracias por tu paciencia. 🙏`;

    const result = await WhatsAppSendService.sendMessage({
      phone_number: phoneNumber,
      message: autoMessage,
      from: 'Equipo de Soporte',
      site_id: conversationData.site_id,
      conversation_id: conversationData.id,
      lead_id: conversationData.lead_id
    });

    if (result.success) {
      console.log(`✅ Respuesta automática de WhatsApp enviada: ${result.message_id}`);
      return true;
    } else {
      console.error(`❌ Error al enviar respuesta automática de WhatsApp:`, result.error);
      return false;
    }

  } catch (error) {
    console.error('❌ Error inesperado al enviar respuesta automática de WhatsApp:', error);
    return false;
  }
}

/**
 * Función para enviar respuesta automática vía email
 */
export async function sendEmailAutoResponse(
  conversationData: any,
  message: string,
  contactEmail?: string,
  contactName?: string
): Promise<boolean> {
  try {
    console.log(`📧 Enviando respuesta automática vía email para conversación ${conversationData.id}`);

    let emailAddress = contactEmail;

    // Si no se proporciona email, intentar obtenerlo del lead
    if (!emailAddress && conversationData.lead_id) {
      const { data: lead, error: leadError } = await supabaseAdmin
        .from('leads')
        .select('email')
        .eq('id', conversationData.lead_id)
        .single();

      if (!leadError && lead?.email) {
        emailAddress = lead.email;
      }
    }

    if (!emailAddress) {
      console.error('❌ No se encontró dirección de email para enviar respuesta automática');
      return false;
    }

    // Usar VisitorNotificationService para enviar el email
    const result = await VisitorNotificationService.notifyMessageReceived({
      visitorEmail: emailAddress,
      visitorName: contactName,
      message: `Hemos recibido tu solicitud: "${message}". Un miembro de nuestro equipo se pondrá en contacto contigo pronto.`,
      agentName: 'Sistema de Soporte',
      summary: 'Solicitud de ayuda humana recibida y en proceso',
      supportEmail: process.env.SUPPORT_EMAIL || 'support@makinari.com'
    });

    if (result.success) {
      console.log(`✅ Respuesta automática por email enviada a: ${emailAddress}`);
      return true;
    } else {
      console.error(`❌ Error al enviar respuesta automática por email:`, result.error);
      return false;
    }

  } catch (error) {
    console.error('❌ Error inesperado al enviar respuesta automática por email:', error);
    return false;
  }
}

/**
 * Función para enviar respuesta automática vía Zavu channels (Telegram, Messenger)
 */
export async function sendChannelAutoResponse(
  conversationData: any,
  channel: string,
  message: string,
  contactName?: string
): Promise<boolean> {
  try {
    console.log(`📺 Enviando respuesta automática vía ${channel} para conversación ${conversationData.id}`);

    // Obtener el ID desde custom_data o usar el teléfono del lead
    let recipientId: string | null = null;

    if (conversationData.custom_data?.phone) {
      recipientId = conversationData.custom_data.phone;
    }

    // Si no se encuentra, intentar obtenerlo del lead
    if (!recipientId && conversationData.lead_id) {
      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('phone')
        .eq('id', conversationData.lead_id)
        .single();

      if (lead?.phone) {
        recipientId = lead.phone;
      }
    }

    if (!recipientId) {
      console.error(`❌ No se encontró ID (teléfono) en la conversación o lead para enviar respuesta automática de ${channel}`);
      return false;
    }

    recipientId = sanitizeZavuRecipient(recipientId);

    const autoMessage = `Hola ${contactName || 'estimado/a cliente'}, ` +
      `hemos recibido tu solicitud de ayuda: "${message}". ` +
      `Un miembro de nuestro equipo se pondrá en contacto contigo pronto. ` +
      `Gracias por tu paciencia. 🙏`;

    const result = await ChannelSendService.sendMessage({
      channel: channel,
      to: recipientId,
      message: autoMessage,
      site_id: conversationData.site_id,
      conversation_id: conversationData.id,
      lead_id: conversationData.lead_id
    });

    if (result.success) {
      console.log(`✅ Respuesta automática de ${channel} enviada: ${result.messageId}`);
      return true;
    } else {
      console.error(`❌ Error al enviar respuesta automática de ${channel}:`, result.error);
      return false;
    }

  } catch (error) {
    console.error(`❌ Error inesperado al enviar respuesta automática de ${channel}:`, error);
    return false;
  }
}
