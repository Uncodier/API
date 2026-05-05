/**
 * Assistant Protocol Wrapper for Messages Tool
 * Read-only tool to list messages, optionally filtered by conversation or site-wide.
 */

import { getMessagesCore } from '@/app/api/agents/customerSupport/conversations/messages/core';

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
  const execute = async (args: MessagesToolParams) => {
    const { action, ...params } = args;

    if (action !== 'list') {
      return { success: false, error: `Invalid action: ${action}. Only "list" is supported.` };
    }

    try {
      const result = await getMessagesCore({
        site_id,
        conversation_id: params.conversation_id,
        lead_id: params.lead_id,
        role: params.role,
        interaction: params.interaction,
        custom_data_status: params.custom_data_status,
        limit: params.limit ? Math.max(1, params.limit) : 50,
        offset: params.offset ?? 0,
      });

      const { messages, pagination } = result.data;

      return {
        success: true,
        messages,
        pagination,
        // Signal to the agent when there are no more pages to fetch
        has_more: pagination.page < pagination.pages,
      };
    } catch (err: any) {
      const raw: string = err?.message ?? 'Unknown error';
      // Strip internal error prefixes so the agent gets a clean, readable message
      const clean = raw.replace(/^(DATABASE_ERROR|INVALID_REQUEST|NOT_FOUND):\s*/i, '');
      return { success: false, error: clean };
    }
  };

  return {
    name: 'messages',
    description: `List messages for this site. Rules:
- Always provide conversation_id when you have it — site-wide queries are slower and return less context.
- Use role="user" to see only visitor/lead messages; role="assistant" for bot replies.
- Default limit is 50 (max 100). Check pagination.has_more before paginating further.
- Stop paginating when has_more=false or when you have found the information you need — do NOT blindly paginate through hundreds of records.
- If you get an error, do NOT retry with a higher offset. Instead, try a narrower filter (e.g. add conversation_id or lead_id).`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list'],
          description: 'Action to perform (only "list" is supported).',
        },
        conversation_id: {
          type: 'string',
          description: 'Preferred. Filter to a single conversation UUID. Omit only when you need site-wide results.',
        },
        lead_id: {
          type: 'string',
          description: 'Filter by lead UUID.',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant', 'system', 'team_member'],
          description: 'Filter by message role.',
        },
        interaction: {
          type: 'string',
          description: 'Filter by interaction type (e.g. opened, clicked — for email tracking).',
        },
        custom_data_status: {
          type: 'string',
          description: 'Filter by custom_data.status (JSONB field).',
        },
        limit: {
          type: 'number',
          description: 'Max results per page. Default 50, max 100.',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset. Only increment if has_more=true in the previous response.',
        },
      },
      required: ['action'],
    },
    handler: execute,
    execute,
  };
}
