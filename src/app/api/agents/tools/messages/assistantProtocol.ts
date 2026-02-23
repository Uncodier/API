/**
 * Assistant Protocol Wrapper for Messages Tool
 * Read-only tool to list messages, optionally filtered by conversation or site-wide.
 */

import { getMessagesCore } from '@/app/api/agents/customerSupport/conversations/messages/route';

export interface MessagesToolParams {
  action: 'list';
  conversation_id?: string;
  lead_id?: string;
  role?: string;
  interaction?: string;
  custom_data_status?: string;
  limit?: number;
  offset?: number;
}

export function messagesTool(site_id: string) {
  return {
    name: 'messages',
    description:
      'List messages. Use action="list" with optional filters: conversation_id, lead_id, role (user/assistant/system), interaction (e.g. opened, clicked), custom_data_status (custom_data.status). When conversation_id is omitted, returns recent messages site-wide. Each message includes conversation_id when available.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list'],
          description: 'Action to perform (list only).'
        },
        conversation_id: {
          type: 'string',
          description: 'Optional. Filter by conversation UUID. If omitted, returns recent messages for the entire site.'
        },
        lead_id: { type: 'string', description: 'Filter by lead UUID (messages linked to this lead)' },
        role: { type: 'string', description: 'Filter by message role (e.g. user, assistant, system)' },
        interaction: { type: 'string', description: 'Filter by interaction (e.g. opened, clicked for email tracking)' },
        custom_data_status: { type: 'string', description: 'Filter by custom_data.status (JSONB key)' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' }
      },
      required: ['action']
    },
    execute: async (args: MessagesToolParams) => {
      const { action, ...params } = args;

      if (action !== 'list') {
        throw new Error(`Invalid action: ${action}`);
      }

      const result = await getMessagesCore({
        site_id,
        conversation_id: params.conversation_id,
        lead_id: params.lead_id,
        role: params.role,
        interaction: params.interaction,
        custom_data_status: params.custom_data_status,
        limit: params.limit,
        offset: params.offset
      });

      return result.data;
    }
  };
}
