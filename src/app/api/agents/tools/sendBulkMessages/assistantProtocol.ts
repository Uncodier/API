/**
 * Assistant Protocol for Send Bulk Messages Tool
 *
 * Sends a message to every lead in an audience via WhatsApp or email.
 * Iterates through all pages, tracks per-lead send status, and returns
 * a summary with totals.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  getAudienceById,
  getAudiencePageForSending,
  updateAudienceLeadStatus,
} from '@/lib/database/audience-db';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar un agente de ventas activo para un sitio
async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Sales')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error || !data || data.length === 0) {
      return null;
    }
    
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendBulkMessagesToolParams {
  audience_id: string;
  channel: 'whatsapp' | 'email';
  message: string;
  subject?: string;
  from?: string;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function sendBulkMessagesTool(siteId: string) {
  const execute = async (args: SendBulkMessagesToolParams) => {
    const { audience_id, channel, message, subject, from } = args;

    if (!audience_id) return { success: false, error: 'Missing required field: audience_id' };
    if (!channel) return { success: false, error: 'Missing required field: channel' };
    if (!message) return { success: false, error: 'Missing required field: message' };
    if (channel === 'email' && !subject) {
      return { success: false, error: 'Missing required field for email: subject' };
    }

    const audience = await getAudienceById(audience_id);
    if (!audience) return { success: false, error: 'Audience not found' };
    if (audience.site_id !== siteId) return { success: false, error: 'Audience does not belong to this site' };
    if (audience.status !== 'ready') {
      return { success: false, error: `Audience is not ready (status: ${audience.status})` };
    }

    const totalPages = Math.ceil(audience.total_count / audience.page_size);
    let totalSent = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    // Buscar agente activo una sola vez por campaña
    const agent = await findActiveSalesAgent(siteId);
    // Usaremos un ID nulo si no hay agente de ventas (se asignará al sistema o quedará nulo)
    const agentId = agent?.agentId || null;
    const userId = agent?.userId || null;

    for (let page = 1; page <= totalPages; page++) {
      const { leads } = await getAudiencePageForSending(audience_id, page);
      if (leads.length === 0) continue;

      for (const lead of leads) {
        const leadId = lead.id as string;

        try {
          // Validar existencia de datos de contacto
          if (channel === 'whatsapp') {
            if (!lead.phone) {
              await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No phone number');
              totalSkipped++;
              continue;
            }
          } else if (channel === 'email') {
            if (!lead.email) {
              await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No email address');
              totalSkipped++;
              continue;
            }
          }

          // 1. Crear Conversación
          const conversationData: any = {
            site_id: siteId,
            lead_id: leadId,
            title: subject || `Bulk Message: ${channel}`,
            channel: channel,
            custom_data: {
              source: 'sendBulkMessages',
              audience_id: audience_id
            }
          };

          if (userId) conversationData.user_id = userId;
          if (agentId) conversationData.agent_id = agentId;

          const { data: conversation, error: convError } = await supabaseAdmin
            .from('conversations')
            .insert([conversationData])
            .select()
            .single();

          if (convError || !conversation) {
            await updateAudienceLeadStatus(audience_id, leadId, 'failed', convError?.message || 'Failed to create conversation');
            totalFailed++;
            continue;
          }

          // 2. Crear Mensaje con estado 'approved'
          const messageData: any = {
            conversation_id: conversation.id,
            content: message,
            role: 'assistant',
            lead_id: leadId,
            custom_data: {
              status: 'approved',
              channel: channel,
              audience_id: audience_id,
              subject: subject // Guardar el subject en custom_data si es email
            }
          };

          // Si hay agente/usuario, lo asignamos. Aunque el rol es assistant, a veces se usa agent_id
          if (agentId) messageData.agent_id = agentId;
          // Note: No seteamos user_id aquí porque el agente es 'assistant'

          const { error: msgError } = await supabaseAdmin
            .from('messages')
            .insert([messageData]);

          if (msgError) {
            await updateAudienceLeadStatus(audience_id, leadId, 'failed', msgError.message);
            totalFailed++;
          } else {
            // El mensaje se guardó correctamente para ser procesado luego
            await updateAudienceLeadStatus(audience_id, leadId, 'sent');
            totalSent++;
          }

        } catch (err: any) {
          await updateAudienceLeadStatus(audience_id, leadId, 'failed', err?.message ?? 'Unexpected error');
          totalFailed++;
        }
      }
    }

    const totalRemaining = audience.total_count - totalSent - totalFailed - totalSkipped;

    return {
      success: true,
      audience_id,
      channel,
      total_sent: totalSent,
      total_failed: totalFailed,
      total_skipped: totalSkipped,
      total_remaining: totalRemaining,
      total_in_audience: audience.total_count,
    };
  };

  return {
    name: 'sendBulkMessages',
    description: `Send a message to all leads in an audience via WhatsApp or email.

Required: audience_id, channel ("whatsapp" or "email"), message.
For email: subject is also required.
Optional: from (sender display name).

The tool iterates through every lead in the audience:
- WhatsApp: requires lead.phone (international format). Leads without phone are skipped.
- Email: requires lead.email. Leads without email are skipped.

Instead of sending messages synchronously, this tool queues them by creating a conversation and message with an 'approved' status for each lead. The background workflow handles actual delivery and tracking.

Each lead's send_status is tracked (sent, failed, skipped) so the tool can be re-run safely — already processed leads are not re-queued.

Returns a summary: total_sent (queued), total_failed, total_skipped, total_remaining.

IMPORTANT:
- First create an audience using the "audience" tool, then pass its audience_id here.
- The audience must have status "ready" before sending.
- Review the audience contents with audience(get) before sending to confirm the target list.`,
    parameters: {
      type: 'object',
      properties: {
        audience_id: { type: 'string', description: 'Audience UUID to send messages to.' },
        channel: {
          type: 'string',
          enum: ['whatsapp', 'email'],
          description: 'Delivery channel.',
        },
        message: { type: 'string', description: 'Message text (plain text or HTML for email).' },
        subject: { type: 'string', description: 'Email subject (required when channel is "email").' },
        from: { type: 'string', description: 'Sender display name (optional).' },
      },
      required: ['audience_id', 'channel', 'message'],
    },
    execute,
  };
}
