/**
 * Assistant Protocol Wrapper for Update Lead Tool
 * Update existing leads (status, contact info, etc.)
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface UpdateLeadToolParams {
  lead_id: string;
  name?: string;
  email?: string;
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

export function updateLeadTool(site_id: string, _user_id?: string) {
  return {
    name: 'updateLead',
    description:
      'Update an existing lead. Required: lead_id. Optional: name, email, phone, position, company, notes, status (new, contacted, qualified, converted, lost), origin, segment_id, campaign_id, assignee_id.',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'Lead UUID to update' },
        name: { type: 'string', description: 'New name' },
        email: { type: 'string', description: 'New email' },
        phone: { type: 'string', description: 'Phone number' },
        position: { type: 'string', description: 'Job title' },
        company: { type: 'string', description: 'Company name' },
        notes: { type: 'string', description: 'Notes' },
        status: { type: 'string', description: 'new, contacted, qualified, converted, lost' },
        origin: { type: 'string', description: 'Lead source' },
        segment_id: { type: 'string', description: 'Segment UUID' },
        campaign_id: { type: 'string', description: 'Campaign UUID' },
        assignee_id: { type: 'string', description: 'Assignee user UUID' },
      },
      required: ['lead_id'],
    },
    execute: async (args: UpdateLeadToolParams) => {
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/updateLead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Update lead failed');
      }
      return data;
    },
  };
}
