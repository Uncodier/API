/**
 * Assistant Protocol Wrapper for Create Task Tool
 * Creates tasks for lead follow-up and CRM workflows
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface CreateTaskToolParams {
  title: string;
  type: string;
  lead_id: string;
  description?: string;
  status?: string;
  stage?: string;
  priority?: number;
  scheduled_date?: string;
  amount?: number;
  assignee?: string;
  notes?: string;
  conversation_id?: string;
  command_id?: string;
  address?: Record<string, unknown>;
}

/**
 * Creates a createTask tool for OpenAI/assistant compatibility
 */
export function createTaskTool(site_id: string, user_id?: string) {
  return {
    name: 'createTask',
    description:
      'Create a new task for lead follow-up. Use for scheduling calls, meetings, demos, or any actionable item. Required: title, type (website_visit, demo, meeting, email, call, quote, contract, payment, referral, feedback), lead_id.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        type: {
          type: 'string',
          description: 'Task type: website_visit, demo, meeting, email, call, quote, contract, payment, referral, feedback',
        },
        lead_id: { type: 'string', description: 'Lead UUID' },
        description: { type: 'string', description: 'Task description' },
        status: { type: 'string', description: 'pending, in_progress, completed, failed' },
        stage: { type: 'string', description: 'Task stage in pipeline' },
        priority: { type: 'number', description: 'Priority 0-10' },
        scheduled_date: { type: 'string', description: 'ISO 8601 datetime' },
        amount: { type: 'number', description: 'Monetary amount if applicable' },
        assignee: { type: 'string', description: 'Assignee user UUID' },
        notes: { type: 'string', description: 'Additional notes' },
        conversation_id: { type: 'string', description: 'Conversation UUID' },
        address: { type: 'object', description: 'Address/location data' },
      },
      required: ['title', 'type', 'lead_id'],
    },
    execute: async (args: CreateTaskToolParams) => {
      const body = {
        ...args,
        site_id,
        user_id: user_id || args.assignee,
      };
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/createTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Create task failed');
      }
      return data;
    },
  };
}
