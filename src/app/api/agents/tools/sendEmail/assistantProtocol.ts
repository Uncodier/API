/**
 * Assistant Protocol Wrapper for Send Email Tool
 * Send emails to leads and contacts via configured channels
 *
 * Calls sendEmailCore directly when running server-side (assistant) to avoid
 * fetch failures (localhost/URL issues in serverless or malformed env vars).
 */

import { sendEmailCore } from './route';

export interface SendEmailToolParams {
  email: string;
  subject: string;
  message: string;
  from?: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
}

/**
 * Creates a sendEmail tool for OpenAI/assistant compatibility
 */
export function sendEmailTool(site_id: string) {
  return {
    name: 'sendEmail',
    description:
      'Send an email to a recipient. Required: email (recipient), subject, message. Optional: from (sender name), lead_id, conversation_id for tracking.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        message: { type: 'string', description: 'Email body (HTML or plain text)' },
        from: { type: 'string', description: 'Sender display name' },
        lead_id: { type: 'string', description: 'Lead UUID for tracking' },
        conversation_id: { type: 'string', description: 'Conversation UUID for tracking' },
        agent_id: { type: 'string', description: 'Agent UUID for tracking' },
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
