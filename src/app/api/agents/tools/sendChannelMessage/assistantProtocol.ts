import { ChannelSendService } from '@/lib/services/channels/ChannelSendService';
import type { OutboundMediaType } from '@/lib/services/channels/outbound-media';

interface SendChannelToolArgs {
  message_type?: 'text' | OutboundMediaType; media_url?: string; mime_type?: string;
  channel: string; to: string; message: string; subject?: string;
  conversation_id?: string; message_id?: string; lead_id?: string; agent_id?: string;
  response_format?: 'text' | 'audio';
}

export function sendChannelMessageTool(siteId: string) {
  return {
    name: 'sendChannelMessage',
    description: 'Send text or an existing image/video/audio/document on a connected channel. Use canonical message_type + public HTTPS media_url for attachments; never replace media with a text link. response_format audio generates speech from text and cannot be combined with existing media. Unsupported provider/media combinations fail explicitly. Prefer saved conversation/message IDs for exact routing and delivery tracking.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Connected messaging channel, e.g. telegram, messenger, whatsapp, email, instagram' },
        to: { type: 'string', description: 'Recipient phone, email or channel user ID' },
        message: { type: 'string', description: 'Text/caption; use empty string for media-only sends' },
        subject: { type: 'string' },
        message_type: { type: 'string', enum: ['text', 'image', 'video', 'audio', 'document'] },
        media_url: { type: 'string', description: 'Public HTTPS attachment URL' },
        mime_type: { type: 'string' },
        response_format: { type: 'string', enum: ['text', 'audio'] },
        conversation_id: { type: 'string' }, message_id: { type: 'string' },
        lead_id: { type: 'string' }, agent_id: { type: 'string' },
      },
      required: ['channel', 'to', 'message'],
    },
    execute: async (args: SendChannelToolArgs) => {
      const result = await ChannelSendService.sendMessage({ ...args, site_id: siteId });
      if (!result.success) throw new Error(result.error || 'Channel delivery failed');
      return result;
    },
  };
}