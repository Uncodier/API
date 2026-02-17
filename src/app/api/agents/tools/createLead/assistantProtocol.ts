/**
 * Assistant Protocol Wrapper for Create Lead Tool
 * Creates leads for CRM workflows
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface CreateLeadToolParams {
  name: string;
  email: string;
  phone?: string;
  position?: string;
  company?: string | Record<string, unknown>;
  notes?: string;
  status?: string;
  origin?: string;
  segment_id?: string;
  campaign_id?: string;
  assignee_id?: string;
}

export function createLeadTool(site_id: string, user_id?: string) {
  return {
    name: 'createLead',
    description:
      'Create a new lead. Required: name, email. Optional: phone, position, company (name or object), notes, status (new, contacted, qualified), origin, segment_id, campaign_id, assignee_id.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lead full name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        position: { type: 'string', description: 'Job title/position' },
        company: { type: 'string', description: 'Company name' },
        notes: { type: 'string', description: 'Notes' },
        status: { type: 'string', description: 'new, contacted, qualified' },
        origin: { type: 'string', description: 'Lead source (e.g. website, referral)' },
        segment_id: { type: 'string', description: 'Segment UUID' },
        campaign_id: { type: 'string', description: 'Campaign UUID' },
        assignee_id: { type: 'string', description: 'Assignee user UUID' },
      },
      required: ['name', 'email'],
    },
    execute: async (args: CreateLeadToolParams) => {
      const body = {
        ...args,
        site_id,
        user_id,
      };
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/createLead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Create lead failed');
      }
      return data;
    },
  };
}
