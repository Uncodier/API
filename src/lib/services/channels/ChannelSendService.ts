import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { tryPrepareLongReplyAudio } from './long-reply-audio';

export interface SendChannelMessageParams {
  site_id: string;
  channel: string; // e.g. "telegram", "messenger", "facebook", "instagram", "threads", "linkedin", "x", "youtube"
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

const OUTSTAND_CHANNELS = ['facebook', 'instagram', 'threads', 'linkedin', 'x', 'twitter', 'youtube'];

export class ChannelSendService {
  /**
   * Send a generic channel message (e.g. Telegram, Messenger, or Outstand comments)
   * Resolves the correct sender or metadata from the site settings or DB.
   */
  static async sendMessage(params: SendChannelMessageParams): Promise<SendChannelMessageResult> {
    try {
      if (!params.site_id || !params.channel || !params.to || !params.message) {
        throw new Error('site_id, channel, to, and message are required');
      }

      console.log(`[ChannelSendService] Sending ${params.channel} message to ${params.to} for site ${params.site_id}`);

      // Handle Outstand Comments channels
      if (OUTSTAND_CHANNELS.includes(params.channel)) {
        if (!params.message_id && !params.conversation_id) {
          throw new Error(`Outstand replies require message_id or conversation_id to find the parent comment`);
        }
        
        let customData: any = {};
        
        // We need to fetch the original inbound message to get outstand metadata
        if (params.conversation_id) {
          // Find the last user message in this conversation
          const { data: messages } = await supabaseAdmin
            .from('messages')
            .select('custom_data')
            .eq('conversation_id', params.conversation_id)
            .eq('role', 'user')
            .order('created_at', { ascending: false })
            .limit(1);
            
          if (messages && messages.length > 0 && messages[0].custom_data) {
            customData = messages[0].custom_data;
          }
        }
        
        const outstandPostId = customData.outstand_post_id;
        const platformPostId = customData.platform_post_id;
        // Reply to the inbound comment itself, not that comment's parent
        const parentCommentId =
          customData.origin_message_id ||
          customData.platform_comment_id ||
          customData.parent_comment_id;
        const accountUsername = customData.account_username;
        
        if (!outstandPostId) {
          throw new Error(`No outstand_post_id found for conversation ${params.conversation_id}`);
        }
        
        const outstandClient = getOutstandClient();
        const result = await outstandClient.publishComment(outstandPostId, {
          content: params.message,
          platform_post_id: platformPostId,
          parent_comment_id: parentCommentId,
          account_username: accountUsername
        }, params.site_id);
        
        return {
          success: result.success !== false, // Some APIs might not return explicit success=true
          messageId: result.reply_id || `outstand-${Date.now()}`
        };
      }

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

      // Check if we should send this long reply as audio
      const audioReply = await tryPrepareLongReplyAudio({
        siteId: params.site_id,
        channel: params.channel,
        text: params.message
      });

      let result;
      if (audioReply) {
        result = await sendChannelMessage({
          to: params.to,
          channel: params.channel,
          senderId: connection.zavu_sender_id,
          messageType: 'audio',
          content: { mediaUrl: audioReply.audioUrl, mimeType: audioReply.mimeType },
          subject: params.subject
        });
      } else {
        result = await sendChannelMessage({
          to: params.to,
          text: params.message,
          channel: params.channel,
          senderId: connection.zavu_sender_id,
          subject: params.subject
        });
      }

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
