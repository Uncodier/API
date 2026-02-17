/**
 * Assistant Protocol Wrapper for Create Requirement Tool
 * Creates requirements for campaigns and site workflows
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface CreateRequirementToolParams {
  title: string;
  description?: string;
  instructions?: string;
  priority?: string;
  status?: string;
  type?: string;
  budget?: number;
  campaign_id?: string;
}

export function createRequirementTool(site_id: string, user_id?: string) {
  return {
    name: 'createRequirement',
    description:
      'Create a new requirement for campaigns or site. Required: title. Optional: description, instructions, priority (high, medium, low), status (backlog, validated, in-progress), type (content, design, task, develop, etc.), budget, campaign_id to link to a campaign.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Requirement title' },
        description: { type: 'string', description: 'Detailed description' },
        instructions: { type: 'string', description: 'Implementation instructions' },
        priority: { type: 'string', description: 'high, medium, low' },
        status: { type: 'string', description: 'backlog, validated, in-progress' },
        type: { type: 'string', description: 'content, design, task, develop, analytics, etc.' },
        budget: { type: 'number', description: 'Budget amount (numeric)' },
        campaign_id: { type: 'string', description: 'Campaign UUID to link requirement' },
      },
      required: ['title'],
    },
    execute: async (args: CreateRequirementToolParams) => {
      const body = {
        ...args,
        site_id,
        user_id,
      };
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/createRequirement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Create requirement failed');
      }
      return data;
    },
  };
}
