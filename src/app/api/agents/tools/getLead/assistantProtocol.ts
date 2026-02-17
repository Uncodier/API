/**
 * Assistant Protocol Wrapper for Get Lead Tool
 * Retrieve leads with filters for CRM
 */

import { getLeadCore } from './route';

export interface GetLeadToolParams {
  lead_id?: string;
  site_id?: string;
  user_id?: string;
  status?: string;
  segment_id?: string;
  campaign_id?: string;
  assignee_id?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function getLeadTool(site_id: string, user_id?: string) {
  return {
    name: 'getLead',
    description:
      'Get leads with optional filters. Pass lead_id to get a single lead by ID. Or use filters: site_id, user_id, status (new, contacted, qualified, converted, lost), segment_id, campaign_id, assignee_id, search (name/email/notes), limit (default 50). Returns leads and pagination.',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'Get single lead by UUID' },
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        status: { type: 'string', description: 'new, contacted, qualified, converted, lost' },
        segment_id: { type: 'string', description: 'Filter by segment UUID' },
        campaign_id: { type: 'string', description: 'Filter by campaign UUID' },
        assignee_id: { type: 'string', description: 'Filter by assignee UUID' },
        search: { type: 'string', description: 'Text search in name, email, notes' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: [],
    },
    execute: async (args: GetLeadToolParams) => {
      const filters = {
        ...args,
        site_id: args.site_id || site_id,
        user_id: args.user_id || user_id,
      };
      return getLeadCore(filters);
    },
  };
}
