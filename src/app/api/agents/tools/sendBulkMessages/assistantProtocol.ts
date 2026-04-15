/**
 * Assistant Protocol for Send Bulk Messages Tool
 *
 * Sends a message to every lead in an audience via WhatsApp or email.
 * Iterates through all pages, tracks per-lead send status, and returns
 * a summary with totals.
 */

import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { sendEmailCore } from '@/app/api/agents/tools/sendEmail/route';
import {
  getAudienceById,
  getAudiencePageForSending,
  updateAudienceLeadStatus,
} from '@/lib/database/audience-db';

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

    for (let page = 1; page <= totalPages; page++) {
      const { leads } = await getAudiencePageForSending(audience_id, page);
      if (leads.length === 0) continue;

      for (const lead of leads) {
        const leadId = lead.id as string;

        try {
          if (channel === 'whatsapp') {
            const phone = lead.phone as string | null;
            if (!phone) {
              await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No phone number');
              totalSkipped++;
              continue;
            }

            const result = await WhatsAppSendService.sendMessage({
              phone_number: phone,
              message,
              from,
              lead_id: leadId,
              site_id: siteId,
            });

            if (result.success) {
              await updateAudienceLeadStatus(audience_id, leadId, 'sent');
              totalSent++;
            } else {
              const errMsg = result.error?.message ?? 'Send failed';
              await updateAudienceLeadStatus(audience_id, leadId, 'failed', errMsg);
              totalFailed++;
            }
          } else {
            const email = lead.email as string | null;
            if (!email) {
              await updateAudienceLeadStatus(audience_id, leadId, 'skipped', 'No email address');
              totalSkipped++;
              continue;
            }

            const result = await sendEmailCore({
              email,
              subject: subject!,
              message,
              from,
              lead_id: leadId,
              site_id: siteId,
            });

            if (result.success) {
              await updateAudienceLeadStatus(audience_id, leadId, 'sent');
              totalSent++;
            } else {
              const errMsg = result.error?.message ?? 'Send failed';
              await updateAudienceLeadStatus(audience_id, leadId, 'failed', errMsg);
              totalFailed++;
            }
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

Each lead's send_status is tracked (sent, failed, skipped) so the tool can be re-run safely — already sent leads are not re-sent.

Returns a summary: total_sent, total_failed, total_skipped, total_remaining.

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
