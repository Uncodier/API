/**
 * Assistant Protocol Wrapper for Update Task Tool
 * Update existing tasks (status, stage, dates, etc.)
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface UpdateTaskToolParams {
  task_id: string;
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  stage?: string;
  priority?: number;
  scheduled_date?: string;
  completed_date?: string;
  amount?: number;
  assignee?: string;
  notes?: string;
  address?: Record<string, unknown>;
}

/**
 * Creates an updateTask tool for OpenAI/assistant compatibility
 */
export function updateTaskTool(site_id: string, user_id?: string) {
  return {
    name: 'updateTask',
    description:
      'Update an existing task. Required: task_id. Optional: title, description, type, status, stage, priority, scheduled_date, completed_date, amount, assignee, notes.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        type: { type: 'string', description: 'Task type' },
        status: { type: 'string', description: 'pending, in_progress, completed, failed' },
        stage: { type: 'string', description: 'Pipeline stage' },
        priority: { type: 'number', description: 'Priority 0-10' },
        scheduled_date: { type: 'string', description: 'ISO 8601 datetime' },
        completed_date: { type: 'string', description: 'ISO 8601 when completed' },
        amount: { type: 'number', description: 'Monetary amount' },
        assignee: { type: 'string', description: 'Assignee user UUID' },
        notes: { type: 'string', description: 'Notes' },
      },
      required: ['task_id'],
    },
    execute: async (args: UpdateTaskToolParams) => {
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/updateTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Update task failed');
      }
      return data;
    },
  };
}
