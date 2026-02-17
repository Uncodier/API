/**
 * Assistant Protocol Wrapper for Update Requirement Tool
 * Update existing requirements (status, priority, completion, etc.)
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface UpdateRequirementToolParams {
  requirement_id: string;
  title?: string;
  description?: string;
  instructions?: string;
  priority?: string;
  status?: string;
  completion_status?: string;
  type?: string;
  budget?: number;
}

export function updateRequirementTool(site_id: string, _user_id?: string) {
  return {
    name: 'updateRequirement',
    description:
      'Update an existing requirement. Required: requirement_id. Optional: title, description, instructions, priority, status, completion_status (pending, completed, rejected), type, budget.',
    parameters: {
      type: 'object',
      properties: {
        requirement_id: { type: 'string', description: 'Requirement UUID to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        instructions: { type: 'string', description: 'Implementation instructions' },
        priority: { type: 'string', description: 'high, medium, low' },
        status: { type: 'string', description: 'backlog, validated, in-progress, done, canceled' },
        completion_status: { type: 'string', description: 'pending, completed, rejected' },
        type: { type: 'string', description: 'Requirement type' },
        budget: { type: 'number', description: 'Budget amount' },
      },
      required: ['requirement_id'],
    },
    execute: async (args: UpdateRequirementToolParams) => {
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/updateRequirement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Update requirement failed');
      }
      return data;
    },
  };
}
