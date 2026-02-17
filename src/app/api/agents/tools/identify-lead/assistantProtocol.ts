/**
 * Assistant Protocol Wrapper for Identify Lead Tool
 * Identify a visitor as a lead
 */

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface IdentifyLeadToolParams {
  visitor_id: string;
  lead_score?: number;
  source?: string;
  contact_info?: Record<string, unknown>;
  company_info?: Record<string, unknown>;
  interest_level?: string;
  product_interest?: string;
  pages_visited?: string[];
  time_spent?: number;
  visit_count?: number;
  notes?: string;
}

/**
 * Creates an identify_lead tool for OpenAI/assistant compatibility
 */
export function identifyLeadTool(site_id?: string) {
  return {
    name: 'identify_lead',
    description:
      'Identify a visitor as a potential lead. Required: visitor_id (UUID). Optional: lead_score (1-100), source, contact_info, company_info, interest_level, product_interest, pages_visited, time_spent, visit_count, notes.',
    parameters: {
      type: 'object',
      properties: {
        visitor_id: { type: 'string', description: 'Visitor UUID' },
        lead_score: { type: 'number', description: 'Score 1-100' },
        source: { type: 'string', description: 'Lead source' },
        contact_info: { type: 'object', description: 'Contact details' },
        company_info: { type: 'object', description: 'Company details' },
        interest_level: { type: 'string', description: 'Interest level' },
        product_interest: { type: 'string', description: 'Product interest' },
        notes: { type: 'string', description: 'Notes' },
      },
      required: ['visitor_id'],
    },
    execute: async (args: IdentifyLeadToolParams) => {
      const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/identify-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Identify lead failed');
      }
      return data;
    },
  };
}
