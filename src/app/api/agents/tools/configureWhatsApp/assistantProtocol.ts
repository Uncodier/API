/**
 * Assistant Protocol for Configure WhatsApp Tool
 * Single tool for WhatsApp configuration: get status or set credentials (Twilio/WhatsApp Business).
 * Sending messages is handled by the sendWhatsApp and whatsappTemplate tools.
 */

import { configureWhatsAppCore } from './route';
import type { ConfigureWhatsAppAction } from './route';

export interface ConfigureWhatsAppToolParams {
  action: ConfigureWhatsAppAction;
  account_sid?: string;
  access_token?: string;
  from_number?: string;
}

const ACTION_DESCRIPTION = `One of: get_config (check if WhatsApp is configured for the site; returns configured, from_number, token_stored), set_credentials (save account_sid, access_token, and optional from_number; stores token encrypted in secure_tokens).`;

/**
 * Creates the configure_whatsapp tool for OpenAI/assistant compatibility.
 * Use this to check WhatsApp config status or to set Twilio/WhatsApp Business credentials.
 */
export function configureWhatsAppTool(site_id: string) {
  return {
    name: 'configure_whatsapp',
    description:
      'Configure WhatsApp for the site: get_config (check if WhatsApp is set up and which number is used) or set_credentials (save Twilio/WhatsApp Business account_sid, access_token, and optional from_number). Required: action. For set_credentials also provide account_sid, access_token, and optionally from_number (e.g. +1234567890).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_config', 'set_credentials'],
          description: ACTION_DESCRIPTION,
        },
        account_sid: {
          type: 'string',
          description:
            'For set_credentials: Twilio Account SID (or WhatsApp Business phone number ID).',
        },
        access_token: {
          type: 'string',
          description:
            'For set_credentials: Twilio Auth Token or WhatsApp API access token (stored encrypted).',
        },
        from_number: {
          type: 'string',
          description:
            'For set_credentials: WhatsApp Business phone number in international format (e.g. +1234567890).',
        },
      },
      required: ['action'],
    },
    execute: async (args: ConfigureWhatsAppToolParams) => {
      const result = await configureWhatsAppCore({
        site_id,
        action: args.action,
        account_sid: args.account_sid,
        access_token: args.access_token,
        from_number: args.from_number,
      });
      if (!result.success && result.error) {
        throw new Error(result.error);
      }
      return result;
    },
  };
}
