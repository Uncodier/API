/**
 * Assistant Protocol for Send WhatsApp Tool
 * Sends WhatsApp messages via WhatsAppSendService (handles 24h response window and templates).
 */

import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';

export interface SendWhatsAppToolParams {
  phone_number: string;
  message: string;
  from?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  responseWindowEnabled?: boolean;
}

/**
 * Creates the sendWhatsApp tool for the instance assistant.
 * If the result has template_required: true, the agent should use the whatsappTemplate tool next.
 */
export function sendWhatsAppTool(siteId: string) {
  return {
    name: 'sendWhatsApp',
    description:
      'Send a WhatsApp message to a phone number. Required: phone_number (international format e.g. +1234567890), message. Optional: from (sender name), lead_id, conversation_id for tracking. If the response indicates template_required: true (outside 24h reply window), use the whatsappTemplate tool with action create_template then send_template to deliver the message.',
    parameters: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'Recipient phone in international format (e.g. +1234567890, no spaces)',
        },
        message: { type: 'string', description: 'Message text to send' },
        from: { type: 'string', description: 'Sender display name' },
        lead_id: { type: 'string', description: 'Lead UUID for tracking' },
        conversation_id: { type: 'string', description: 'Conversation UUID (used for 24h window check)' },
        agent_id: { type: 'string', description: 'Agent UUID for tracking' },
        responseWindowEnabled: {
          type: 'boolean',
          description: 'If true, skip template check and send as within 24h window',
        },
      },
      required: ['phone_number', 'message'],
    },
    execute: async (args: SendWhatsAppToolParams) => {
      const result = await WhatsAppSendService.sendMessage({
        ...args,
        site_id: siteId,
      });
      if (!result.success && result.error) {
        throw new Error(result.error.message || 'Failed to send WhatsApp message');
      }
      return result;
    },
  };
}
