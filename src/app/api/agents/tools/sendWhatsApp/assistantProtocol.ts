/**
 * Assistant Protocol for Send WhatsApp Tool
 * Sends WhatsApp messages via WhatsAppSendService (handles 24h response window and templates).
 */

import { getLeadById } from '@/lib/database/lead-db';
import {
  type ContentPlaceholderPolicy,
  fetchSiteNameForMerge,
  personalizeMergeTemplate,
  placeholderPolicyToMergePolicy,
} from '@/lib/messaging/lead-merge-fields';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';

export interface SendWhatsAppToolParams {
  phone_number: string;
  message: string;
  from?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  responseWindowEnabled?: boolean;
  media_urls?: string[];
  /** Default strip_tokens when omitted. */
  placeholder_policy?: ContentPlaceholderPolicy;
}

/**
 * Creates the sendWhatsApp tool for the instance assistant.
 * If the result has template_required: true, the agent should use the whatsappTemplate tool next.
 */
export function sendWhatsAppTool(siteId: string) {
  return {
    name: 'sendWhatsApp',
    description:
      'Send a WhatsApp message to a phone number. Required: phone_number (international format e.g. +1234567890), message. Optional: from, lead_id (enables merge fields in message), placeholder_policy, conversation_id, media_urls. Merge tokens: {{lead.name}}, {{lead.first_name}}, {{lead.email}}, {{lead.phone}}, {{lead.position}}, {{lead.company}}, {{lead.notes}}, {{lead.metadata.<path>}}, {{site.name}} — double braces only. If template_required: true (outside 24h), use whatsappTemplate create_template then send_template.',
    parameters: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'Recipient phone in international format (e.g. +1234567890, no spaces)',
        },
        message: { type: 'string', description: 'Message text (merge fields resolved when lead_id is set)' },
        from: { type: 'string', description: 'Sender display name' },
        lead_id: { type: 'string', description: 'Lead UUID for tracking' },
        conversation_id: { type: 'string', description: 'Conversation UUID (used for 24h window check)' },
        agent_id: { type: 'string', description: 'Agent UUID for tracking' },
        media_urls: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Array of valid public URLs linking to media (images, videos, audio, pdfs) to attach to the message (max 10).' 
        },
        responseWindowEnabled: {
          type: 'boolean',
          description: 'If true, skip template check and send as within 24h window',
        },
        placeholder_policy: {
          type: 'string',
          enum: ['strip_tokens', 'skip_recipient'],
          description: 'With lead_id: policy for unknown {{...}} tokens (default strip_tokens)',
        },
      },
      required: ['phone_number', 'message'],
    },
    execute: async (args: SendWhatsAppToolParams) => {
      const {
        phone_number,
        from,
        agent_id,
        conversation_id,
        lead_id,
        responseWindowEnabled,
        media_urls,
        placeholder_policy,
      } = args;
      let message = args.message;
      if (lead_id) {
        const lead = await getLeadById(lead_id);
        if (lead) {
          const siteName = await fetchSiteNameForMerge(siteId);
          const mergePol = placeholderPolicyToMergePolicy(placeholder_policy);
          const merged = personalizeMergeTemplate(message, lead, siteName, mergePol);
          if (merged.aborted) {
            throw new Error(
              `Unresolved merge fields: ${merged.unresolved.join(', ')}`,
            );
          }
          message = merged.text;
        }
      }

      const result = await WhatsAppSendService.sendMessage({
        phone_number,
        message,
        from,
        agent_id,
        conversation_id,
        lead_id,
        responseWindowEnabled,
        media_urls,
        site_id: siteId,
      });
      if (!result.success && result.error) {
        throw new Error(result.error.message || 'Failed to send WhatsApp message');
      }
      return result;
    },
  };
}
