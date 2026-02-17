/**
 * Assistant Protocol Wrapper for Get Task Tool
 * Retrieve tasks with filters for lead follow-up and CRM
 */

import { getTaskCore } from './route';

export interface GetTaskToolParams {
  lead_id?: string;
  user_id?: string;
  site_id?: string;
  visitor_id?: string;
  assignee?: string;
  type?: string;
  status?: string;
  stage?: string;
  priority?: number;
  scheduled_date_from?: string;
  scheduled_date_to?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * Creates a getTask tool for OpenAI/assistant compatibility
 */
export function getTaskTool(site_id: string, user_id?: string) {
  return {
    name: 'getTask',
    description:
      'Get tasks with optional filters. PREFER A SINGLE CALL: omit type to get all tasks, or pass lead_id/site_id for scope. Filters: lead_id, site_id, user_id, assignee, type (meeting, email, call, follow_up, etc.), status (active, inactive, archived), stage, limit (default 50). Returns tasks, pagination, and summary.',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'Filter by lead UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        site_id: { type: 'string', description: 'Filter by site UUID' },
        assignee: { type: 'string', description: 'Filter by assignee UUID' },
        type: { type: 'string', description: 'Task type filter' },
        status: { type: 'string', description: 'active, inactive, archived' },
        stage: { type: 'string', description: 'Stage filter' },
        priority: { type: 'number', description: 'Priority filter' },
        scheduled_date_from: { type: 'string', description: 'ISO 8601 start' },
        scheduled_date_to: { type: 'string', description: 'ISO 8601 end' },
        search: { type: 'string', description: 'Text search' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: [],
    },
    execute: async (args: GetTaskToolParams) => {
      const filters = {
        ...args,
        site_id: args.site_id || site_id,
        user_id: args.user_id || user_id,
      };
      return getTaskCore(filters);
    },
  };
}
