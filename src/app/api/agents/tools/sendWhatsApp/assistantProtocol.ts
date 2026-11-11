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
import { type OutboundMediaType } from '@/lib/services/channels/outbound-media';

export interface SendWhatsAppToolParams {
  phone_number: string;
  message: string;
  from?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  responseWindowEnabled?: boolean;
  media_urls?: string[];
  message_type?: 'text' | OutboundMediaType;
  media_url?: string;
  mime_type?: string;
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
      'Send a WhatsApp message or an existing media attachment to a phone number. Use message_type and media_url for images, videos, audio or documents; URLs inside message stay ordinary links. message can be empty for media-only sends. Optional: from, lead_id (enables merge fields), placeholder_policy, conversation_id. Merge tokens: {{lead.name}}, {{lead.first_name}}, {{lead.email}}, {{lead.phone}}, {{lead.position}}, {{lead.company}}, {{lead.notes}}, {{lead.metadata.<path>}}, {{site.name}} — double braces only. If template_required: true (outside 24h), use whatsappTemplate create_template then send_template; do not claim media was delivered.',
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
          maxItems: 1,
          description: 'Legacy attachment field: one public HTTPS media URL. Prefer message_type + media_url; do not supply both.'
        },
        message_type: { type: 'string', enum: ['text', 'image', 'video', 'audio', 'document'], description: 'Type of existing attachment; does not generate media.' },
        media_url: { type: 'string', description: 'Public HTTPS URL of an existing file to deliver as media, not as a text link.' },
        mime_type: { type: 'string', description: 'Optional MIME type matching the attachment.' },
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
        message_type,
        media_url,
        mime_type,
        placeholder_policy,
      } = args;
      let message = args.message ?? '';
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
        message_type,
        media_url,
        mime_type,
        site_id: siteId,
      });
      if (!result.success && result.error) {
        throw new Error(result.error.message || 'Failed to send WhatsApp message');
      }
      return result;
    },
  };
}
