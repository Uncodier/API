/**
 * Assistant Protocol for WhatsApp Template Tool
 * Create templates when outside 24h reply window and send messages using templates.
 */

import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface WhatsAppTemplateToolParams {
  action: 'create_template' | 'send_template';
  phone_number?: string;
  message?: string;
  template_id?: string;
  conversation_id?: string;
  from?: string;
  original_message?: string;
}

async function formatMessageForTemplate(
  message: string,
  siteId: string,
  from?: string
): Promise<string> {
  try {
    const { data: site } = await supabaseAdmin
      .from('sites')
      .select('business_name, business_website')
      .eq('id', siteId)
      .single();
    if (!site?.business_name) return message;
    if (message.includes(site.business_name)) return message;
    let out = message + `\n\n---\n${site.business_name}`;
    if (site.business_website) out += `\n${site.business_website}`;
    return out;
  } catch {
    return message;
  }
}

/**
 * Creates the whatsappTemplate tool for the instance assistant.
 * Use when sendWhatsApp returns template_required: true (message outside 24h window).
 * Flow: 1) create_template (phone_number, message) -> get template_id; 2) send_template (template_id, phone_number, original_message).
 */
export function whatsappTemplateTool(siteId: string) {
  return {
    name: 'whatsappTemplate',
    description:
      'WhatsApp templates are required when sending to a user more than 24 hours after their last message. Use action create_template first (phone_number, message); if it returns template_id, then use action send_template (template_id, phone_number, original_message) to deliver the message. If create_template returns template_required: false, the conversation is within the 24h window—use sendWhatsApp instead.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_template', 'send_template'],
          description:
            'create_template: check 24h window and create or find template, returns template_id when needed. send_template: send a message using an existing template_id.',
        },
        phone_number: {
          type: 'string',
          description: 'Recipient phone in international format (required for both actions)',
        },
        message: {
          type: 'string',
          description: 'Message content (required for create_template; used as template body)',
        },
        template_id: {
          type: 'string',
          description: 'Template SID from create_template result (required for send_template)',
        },
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID for 24h window check (optional for create_template)',
        },
        from: { type: 'string', description: 'Sender name (optional)' },
        original_message: {
          type: 'string',
          description: 'Original message text for logging (optional for send_template)',
        },
      },
      required: ['action'],
    },
    execute: async (args: WhatsAppTemplateToolParams) => {
      const { action } = args;

      if (action === 'create_template') {
        const { phone_number, message, conversation_id, from } = args;
        if (!phone_number || !message) {
          throw new Error('create_template requires phone_number and message');
        }
        const windowCheck = await WhatsAppTemplateService.checkResponseWindow(
          conversation_id ?? null,
          phone_number,
          siteId
        );
        if (windowCheck.withinWindow) {
          return {
            success: true,
            template_required: false,
            within_window: true,
            window_hours_elapsed: windowCheck.hoursElapsed,
            note: 'Conversation is within 24h reply window; use sendWhatsApp to send directly.',
          };
        }
        const config = await WhatsAppSendService.getWhatsAppConfig(siteId);
        const formattedMessage = await formatMessageForTemplate(message, siteId, from);
        const existing = await WhatsAppTemplateService.findExistingTemplate(
          formattedMessage,
          siteId,
          config.phoneNumberId
        );
        if (existing?.templateSid) {
          return {
            success: true,
            template_required: true,
            template_id: existing.templateSid,
            template_status: 'approved',
            note: 'Use send_template with this template_id to send the message.',
          };
        }
        const createResult = await WhatsAppTemplateService.createTemplate(
          formattedMessage,
          config.phoneNumberId,
          config.accessToken,
          siteId
        );
        if (!createResult.success) {
          throw new Error(createResult.error ?? 'Failed to create template');
        }
        return {
          success: true,
          template_required: true,
          template_id: createResult.templateSid,
          template_status: 'created',
          note: 'Use send_template with this template_id to send the message. Template may need a short time to be approved.',
        };
      }

      if (action === 'send_template') {
        const { template_id, phone_number, original_message } = args;
        if (!template_id || !phone_number) {
          throw new Error('send_template requires template_id and phone_number');
        }
        const config = await WhatsAppSendService.getWhatsAppConfig(siteId);
        const sendResult = await WhatsAppTemplateService.sendMessageWithTemplate(
          phone_number.replace(/\s+/g, ''),
          template_id,
          config.phoneNumberId,
          config.accessToken,
          config.fromNumber,
          original_message ?? 'Template message'
        );
        if (!sendResult.success) {
          throw new Error(
            sendResult.error ?? 'Failed to send WhatsApp message with template'
          );
        }
        return {
          success: true,
          message_id: sendResult.messageId,
          template_id,
          status: 'sent',
        };
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
