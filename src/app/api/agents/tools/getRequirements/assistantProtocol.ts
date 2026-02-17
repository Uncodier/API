/**
 * Assistant Protocol Wrapper for Get Requirements Tool
 * Retrieve requirements with filters for campaigns and site
 */

import { getRequirementsCore } from './route';

export interface GetRequirementsToolParams {
  site_id?: string;
  user_id?: string;
  campaign_id?: string;
  type?: string;
  status?: string;
  completion_status?: string;
  priority?: string;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function getRequirementsTool(site_id: string, user_id?: string) {
  return {
    name: 'getRequirements',
    description:
      'Get requirements with optional filters. Use for campaign/site requirements. Filters: site_id, campaign_id, user_id, type (content, design, task, develop, etc.), status (backlog, validated, in-progress, done), completion_status (pending, completed, rejected), priority (high, medium, low), limit (default 50). Returns requirements and pagination.',
    parameters: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'Filter by site UUID' },
        campaign_id: { type: 'string', description: 'Filter by campaign UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        type: { type: 'string', description: 'Requirement type: content, design, task, develop, etc.' },
        status: { type: 'string', description: 'backlog, validated, in-progress, on-review, done, canceled' },
        completion_status: { type: 'string', description: 'pending, completed, rejected' },
        priority: { type: 'string', description: 'high, medium, low' },
        search: { type: 'string', description: 'Text search in title/description' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: [],
    },
    execute: async (args: GetRequirementsToolParams) => {
      const filters = {
        ...args,
        site_id: args.site_id || site_id,
        user_id: args.user_id || user_id,
      };
      return getRequirementsCore(filters);
    },
  };
}
