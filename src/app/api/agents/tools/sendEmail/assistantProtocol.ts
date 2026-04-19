/**
 * Assistant Protocol Wrapper for Send Email Tool
 * Send emails to leads and contacts via configured channels
 *
 * Calls sendEmailCore directly when running server-side (assistant) to avoid
 * fetch failures (localhost/URL issues in serverless or malformed env vars).
 */

import type { ContentPlaceholderPolicy } from '@/lib/messaging/lead-merge-fields';
import { sendEmailCore } from './route';

export interface SendEmailToolParams {
  email: string;
  subject: string;
  message: string;
  from?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
  /**
   * When lead_id is set: policy for unknown {{...}} tokens.
   * strip_tokens (default): remove unknown tokens. skip_recipient: fail send if any unknown token remains.
   */
  placeholder_policy?: ContentPlaceholderPolicy;
}

/**
 * Creates a sendEmail tool for OpenAI/assistant compatibility
 */
export function sendEmailTool(site_id: string) {
  return {
    name: 'sendEmail',
    description: `Send an email to a recipient. Required: email, subject, message. Optional: from, lead_id, conversation_id, agent_id, placeholder_policy.

Merge fields (use exactly this syntax for best compatibility): {{lead.name}}, {{lead.first_name}}, {{lead.email}}, {{lead.phone}}, {{lead.position}}, {{lead.company}}, {{lead.notes}}, {{lead.metadata.<key>}} (dot path under lead.metadata), {{site.name}}. Common aliases (e.g. {{lead.full_name}}, {{lead.correo}}) are normalized to canonical keys. Do not use [Name], {name}, or single braces.

When lead_id is set, subject and message are personalized. Unknown tokens: strip_tokens (default) removes them; skip_recipient aborts the send when unresolved tokens remain.`,
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject (may include merge fields if lead_id is set)' },
        message: { type: 'string', description: 'Email body (HTML or plain text); merge fields allowed with lead_id' },
        from: { type: 'string', description: 'Sender display name' },
        lead_id: { type: 'string', description: 'Lead UUID for tracking and merge fields' },
        conversation_id: { type: 'string', description: 'Conversation UUID for tracking' },
        agent_id: { type: 'string', description: 'Agent UUID for tracking' },
        placeholder_policy: {
          type: 'string',
          enum: ['strip_tokens', 'skip_recipient'],
          description: 'With lead_id: strip_tokens (default) or skip_recipient for unknown {{...}} tokens',
        },
      },
      required: ['email', 'subject', 'message'],
    },
    execute: async (args: SendEmailToolParams) => {
      const result = await sendEmailCore({
        ...args,
        site_id,
      });
      if (!result.success && result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result;
    },
  };
}
