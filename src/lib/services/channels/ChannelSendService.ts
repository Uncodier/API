import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendChannelMessage } from '@/lib/services/zavu/client';

export interface SendChannelMessageParams {
  site_id: string;
  channel: string; // e.g. "telegram", "messenger"
  to: string; // chat ID
  message: string;
  subject?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  message_id?: string;
}

export interface SendChannelMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Reverses Mexican phone normalization accidentally applied to Zavu chat IDs.
 * A 10-digit Telegram id like 1888278689 was stored as +521888278689.
 * Strip +52 first (not +521) so the leading 1 of the chat id is kept.
 */
export function sanitizeZavuRecipient(recipient: string): string {
  if (recipient.startsWith('+52')) {
    return recipient.substring(3);
  }
  if (recipient.startsWith('+')) {
    return recipient.substring(1);
  }
  return recipient;
}

export class ChannelSendService {
  /**
   * Send a generic channel message (e.g. Telegram, Messenger)
   * Resolves the correct zavu_sender_id from the site settings.
   */
  static async sendMessage(params: SendChannelMessageParams): Promise<SendChannelMessageResult> {
    try {
      if (!params.site_id || !params.channel || !params.to || !params.message) {
        throw new Error('site_id, channel, to, and message are required');
      }

      console.log(`[ChannelSendService] Sending ${params.channel} message to ${params.to} for site ${params.site_id}`);

      // 1. Get site channels connections to find the zavu_sender_id for this channel type
      const { data: siteSettings, error: settingsError } = await supabaseAdmin
        .from('settings')
        .select('channels')
        .eq('site_id', params.site_id)
        .single();

      if (settingsError || !siteSettings) {
        throw new Error(`Settings not found for site ${params.site_id}`);
      }

      const connections = (siteSettings.channels as any)?.connections || [];
      const connection = connections.find((c: any) => c.type === params.channel && c.zavu_sender_id);

      if (!connection?.zavu_sender_id) {
        throw new Error(`No sender configured for channel ${params.channel} on site ${params.site_id}`);
      }

      const result = await sendChannelMessage({
        to: params.to,
        text: params.message,
        channel: params.channel,
        senderId: connection.zavu_sender_id,
        subject: params.subject
      });

      console.log(`[ChannelSendService] Message sent successfully. ID: ${result?.message?.id || 'unknown'}`);

      return {
        success: true,
        messageId: result?.message?.id
      };
    } catch (error: any) {
      console.error(`[ChannelSendService] Error sending ${params.channel} message:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
