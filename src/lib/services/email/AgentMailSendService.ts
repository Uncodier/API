import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendMessage } from '@/lib/integrations/agentmail/agentmail-service';
import { EmailTrackingService } from '@/lib/services/tracking/EmailTrackingService';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';
import { EmailSendService } from './EmailSendService';

export interface AgentMailSendParams {
  email: string;
  subject: string;
  message: string;
  signatureHtml?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  site_id: string;
  username: string;
  domain: string;
  senderEmail: string;
  trackingId?: string; // 🆕 Permite reutilizar un ID de tracking existente
}

export class AgentMailSendService {
  static async sendViaAgentMail(params: AgentMailSendParams) {
    const {
      email,
      subject,
      message,
      signatureHtml,
      agent_id,
      conversation_id,
      lead_id,
      site_id,
      username,
      domain,
      senderEmail,
      trackingId: providedTrackingId
    } = params;

    const inboxId = `${username}@${domain}`;
    const targetEmail = email;

    // Prepare HTML content with signature
    let htmlContent = EmailSendService.renderMessageWithLists(message);
    if (signatureHtml) {
      htmlContent = `
        <div style="font-family: sans-serif; line-height: 1.5;">
          <div>${htmlContent}</div>
          <div style="margin-top: 20px;">${signatureHtml}</div>
        </div>
      `;
    } else {
      htmlContent = `<div style="font-family: sans-serif; line-height: 1.5;">${htmlContent}</div>`;
    }

    // Crear registro de mensaje para tracking o usar el proporcionado
    let trackingId = providedTrackingId;
    try {
      if (trackingId) {
        // Si ya tenemos trackingId, actualizamos el registro con los datos de AgentMail
        await supabaseAdmin
          .from('messages')
          .update({
            custom_data: {
              subject,
              recipient: targetEmail,
              sender: senderEmail,
              source: 'agentmail_tool'
            }
          })
          .eq('id', trackingId);
          
        htmlContent = EmailTrackingService.injectTracking(htmlContent, trackingId);
      } else {
        // Si no hay trackingId, creamos uno nuevo (comportamiento original)
        const { data: newMessage, error: msgError } = await supabaseAdmin
          .from('messages')
          .insert([{
            conversation_id,
            lead_id,
            agent_id,
            content: message,
            role: 'assistant',
            custom_data: {
              subject,
              recipient: targetEmail,
              sender: senderEmail,
              source: 'agentmail_tool'
            }
          }])
          .select('id')
          .single();

        if (!msgError && newMessage) {
          trackingId = newMessage.id;
          htmlContent = EmailTrackingService.injectTracking(htmlContent, trackingId);
        }
      }
    } catch (err) {
      console.warn(`[AGENTMAIL_SEND] ⚠️ Error with tracking message:`, err);
    }

    // Send via AgentMail
    const agentmailParams = {
      to: targetEmail,
      subject,
      text: message,
      html: htmlContent,
    };

    const agentmailResponse = await sendMessage(inboxId, agentmailParams);

    // Save to synced_objects
    if (agentmailResponse.message_id) {
      try {
        await SyncedObjectsService.createObject({
          external_id: agentmailResponse.message_id,
          site_id,
          object_type: 'sent_email',
          status: 'processed',
          provider: 'agentmail',
          metadata: {
            recipient: targetEmail,
            sender: senderEmail,
            subject,
            message_preview: message.substring(0, 200),
            sent_at: new Date().toISOString(),
            agent_id,
            conversation_id,
            lead_id,
            agentmail_message_id: agentmailResponse.message_id,
            agentmail_thread_id: agentmailResponse.thread_id,
            agentmail_inbox_id: inboxId,
            source: 'api_send_agentmail',
            processed_at: new Date().toISOString()
          }
        });
      } catch (syncError) {
        console.warn(`[AGENTMAIL_SEND] ⚠️ Error saving to synced_objects:`, syncError);
      }
    }

    return {
      success: true,
      status: 'sent',
      email_id: agentmailResponse.message_id,
      external_message_id: agentmailResponse.message_id,
      recipient: targetEmail,
      sender: senderEmail,
      subject,
      message_preview: message.substring(0, 200) + (message.length > 200 ? '...' : ''),
      sent_at: new Date().toISOString(),
      thread_id: agentmailResponse.thread_id
    };
  }
}
