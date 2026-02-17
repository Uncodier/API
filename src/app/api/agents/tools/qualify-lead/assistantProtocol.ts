/**
 * Assistant Protocol Wrapper for Qualify Lead Tool
 * Change lead status (contacted, qualified, converted, lost)
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface QualifyLeadToolParams {
  site_id: string;
  status: 'contacted' | 'qualified' | 'converted' | 'lost';
  lead_id?: string;
  email?: string;
  phone?: string;
  notes?: string;
}

/**
 * Creates a qualify_lead tool for OpenAI/assistant compatibility
 */
export function qualifyLeadTool(site_id: string) {
  return {
    name: 'qualify_lead',
    description:
      'Qualify or change lead status. Required: site_id, status (contacted, qualified, converted, lost). Provide one identifier: lead_id, email, or phone.',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'Lead UUID' },
        email: { type: 'string', description: 'Lead email (alternative to lead_id)' },
        phone: { type: 'string', description: 'Lead phone (alternative to lead_id)' },
        status: {
          type: 'string',
          description: 'New status: contacted, qualified, converted, lost',
        },
        notes: { type: 'string', description: 'Notes about the qualification' },
      },
      required: ['status'],
    },
    execute: async (args: Omit<QualifyLeadToolParams, 'site_id'> & { status: string }) => {
      const body = {
        ...args,
        site_id,
      };
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/qualify-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Qualify lead failed');
      }
      return data;
    },
  };
}
