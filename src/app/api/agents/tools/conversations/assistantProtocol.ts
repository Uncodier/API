/**
 * Assistant Protocol Wrapper for Conversations Tool
 * Read-only tool to list company conversations (support, chat, email, etc.)
 */

import { getConversationsCore } from '@/app/api/agents/customerSupport/conversations/route';

export interface ConversationsToolParams {
  action: 'list';
  lead_id?: string;
  visitor_id?: string;
  user_id?: string;
  agent_id?: string;
  status?: string;
  channel?: string;
  custom_data_status?: string;
  limit?: number;
  offset?: number;
}

export function conversationsTool(site_id: string, user_id?: string) {
  return {
    name: 'conversations',
    description:
      'List company conversations. Use action="list" with optional filters: lead_id, visitor_id, user_id, agent_id, status (conversation status e.g. active), channel (e.g. whatsapp, email, chat), custom_data_status (value of custom_data.status).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list'],
          description: 'Action to perform (list only).'
        },
        lead_id: { type: 'string', description: 'Filter by lead UUID' },
        visitor_id: { type: 'string', description: 'Filter by visitor UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        agent_id: { type: 'string', description: 'Filter by agent UUID' },
        status: { type: 'string', description: 'Filter by conversation status (e.g. active, closed)' },
        channel: { type: 'string', description: 'Filter by channel (e.g. whatsapp, email, chat)' },
        custom_data_status: { type: 'string', description: 'Filter by custom_data.status (JSONB key)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        offset: { type: 'number', description: 'Pagination offset' }
      },
      required: ['action']
    },
    execute: async (args: ConversationsToolParams) => {
      const { action, ...params } = args;

      if (action !== 'list') {
        throw new Error(`Invalid action: ${action}`);
      }

      const result = await getConversationsCore({
        site_id,
        lead_id: params.lead_id,
        visitor_id: params.visitor_id,
        user_id: params.user_id ?? user_id,
        agent_id: params.agent_id,
        status: params.status,
        channel: params.channel,
        custom_data_status: params.custom_data_status,
        limit: params.limit,
        offset: params.offset
      });

      return result.data;
    }
  };
}
