/**
 * Assistant Protocol Wrapper for Tasks Tool
 * Unified tool for managing tasks (create, list, update)
 */

import { getTaskCore } from './get/route';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';



export interface TasksToolParams {
  action: 'create' | 'list' | 'update';
  
  // Create/Update params
  task_id?: string; // Required for update
  title?: string; // Required for create
  type?: string; // Required for create
  lead_id?: string; // Required for create
  description?: string;
  status?: string;
  stage?: string;
  priority?: number;
  scheduled_date?: string;
  completed_date?: string;
  amount?: number;
  assignee?: string;
  notes?: string;
  conversation_id?: string;
  command_id?: string;
  address?: Record<string, unknown>;

  // List params
  user_id?: string;
  site_id?: string;
  visitor_id?: string;
  scheduled_date_from?: string;
  scheduled_date_to?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function tasksTool(site_id: string, user_id?: string) {
  return {
    name: 'tasks',
    description:
      'Manage CRM tasks. Use action="create" to create a new task (requires title, type, lead_id). Use action="update" to update an existing task (requires task_id). Use action="list" to get tasks with filters. Note that type: "meeting" is for CRM/team appointments, not catalog capacity reservations.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update'],
          description: 'Action to perform on tasks.'
        },
        // Common/Create/Update fields
        task_id: { type: 'string', description: 'Task UUID (required for update)' },
        title: { type: 'string', description: 'Task title (required for create)' },
        type: { type: 'string', description: 'Task type: website_visit, demo, meeting, email, call, quote, contract, payment, referral, feedback (required for create)' },
        lead_id: { type: 'string', description: 'Lead UUID (required for create)' },
        description: { type: 'string', description: 'Task description' },
        status: { type: 'string', description: 'pending, in_progress, completed, failed' },
        stage: { type: 'string', description: 'Task stage in pipeline' },
        priority: { type: 'number', description: 'Priority 0-10' },
        scheduled_date: { type: 'string', description: 'ISO 8601 datetime' },
        completed_date: { type: 'string', description: 'ISO 8601 when completed' },
        amount: { type: 'number', description: 'Monetary amount if applicable' },
        assignee: { type: 'string', description: 'Assignee user UUID' },
        notes: { type: 'string', description: 'Additional notes' },
        conversation_id: { type: 'string', description: 'Conversation UUID' },
        address: { type: 'string', description: 'Address/location data (JSON string)' },
        
        // List specific filters
        user_id: { type: 'string', description: 'Filter by user UUID' },
        site_id: { type: 'string', description: 'Filter by site UUID' },
        visitor_id: { type: 'string', description: 'Filter by visitor UUID' },
        scheduled_date_from: { type: 'string', description: 'ISO 8601 start' },
        scheduled_date_to: { type: 'string', description: 'ISO 8601 end' },
        search: { type: 'string', description: 'Text search' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: TasksToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        const body = {
          ...params,
          address: params.address && typeof params.address === 'string' ? JSON.parse(params.address) : params.address,
          site_id,
          user_id: user_id || params.assignee,
        };
        // Check required fields for create
        if (!params.title || !params.type || !params.lead_id) {
           throw new Error('Missing required fields for create task: title, type, lead_id');
        }

        const data = await fetchApiTool('/api/agents/tools/tasks/create', body, 'Create task failed');
        return data;
      }

      if (action === 'update') {
        if (!params.task_id) {
            throw new Error('Missing required field for update task: task_id');
        }
        const body = {
          ...params,
          address: params.address && typeof params.address === 'string' ? JSON.parse(params.address) : params.address,
          site_id,
        };
        const data = await fetchApiTool('/api/agents/tools/tasks/update', body, 'Update task failed');
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        return getTaskCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
