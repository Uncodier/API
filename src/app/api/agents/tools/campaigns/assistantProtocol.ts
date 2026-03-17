/**
 * Assistant Protocol Wrapper for Campaigns Tool
 * Unified tool for managing campaigns (create, list, update)
 */

import { getCampaignCore } from './get/route';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';



export interface CampaignsToolParams {
  action: 'create' | 'list' | 'update';
  
  // Common/Create/Update params
  campaign_id?: string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  priority?: string;
  budget?: string;
  revenue?: string;
  due_date?: string;
  command_id?: string;
  
  // List params
  site_id?: string;
  user_id?: string;
  limit?: number;
  offset?: number;
}

export function campaignsTool(site_id: string, user_id?: string) {
  return {
    name: 'campaigns',
    description:
      'Manage marketing campaigns. Use action="create" to create a new campaign (requires title). Use action="update" to update an existing campaign (requires campaign_id). Use action="list" to get campaigns with filters.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update'],
          description: 'Action to perform on campaigns.'
        },
        campaign_id: { type: 'string', description: 'Campaign UUID (required for update)' },
        title: { type: 'string', description: 'Campaign title' },
        description: { type: 'string', description: 'Campaign description' },
        status: { type: 'string', description: 'Status (e.g. pending, active, completed)' },
        type: { type: 'string', description: 'Campaign type (e.g. email, social, ad)' },
        priority: { type: 'string', description: 'Priority (e.g. low, medium, high)' },
        budget: { type: 'string', description: 'Budget details (JSON string)' },
        revenue: { type: 'string', description: 'Revenue details (JSON string)' },
        due_date: { type: 'string', description: 'Due date (ISO string)' },
        
        // List filters
        site_id: { type: 'string', description: 'Filter by site UUID' },
        user_id: { type: 'string', description: 'Filter by user UUID' },
        limit: { type: 'number', description: 'Max results' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['action'],
    },
    execute: async (args: CampaignsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        const body = {
          ...params,
          budget: params.budget && typeof params.budget === 'string' ? JSON.parse(params.budget) : params.budget,
          revenue: params.revenue && typeof params.revenue === 'string' ? JSON.parse(params.revenue) : params.revenue,
          site_id,
          user_id,
        };
        if (!params.title) {
           throw new Error('Missing required fields for create campaign: title');
        }

        const data = await fetchApiTool('/api/agents/tools/campaigns/create', body, 'Create campaign failed');
        return data;
      }

      if (action === 'update') {
        if (!params.campaign_id) {
            throw new Error('Missing required field for update campaign: campaign_id');
        }
        const body = {
          ...params,
          budget: params.budget && typeof params.budget === 'string' ? JSON.parse(params.budget) : params.budget,
          revenue: params.revenue && typeof params.revenue === 'string' ? JSON.parse(params.revenue) : params.revenue,
          site_id,
        };
        const data = await fetchApiTool('/api/agents/tools/campaigns/update', body, 'Update campaign failed');
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || site_id,
          user_id: params.user_id || user_id,
        };
        // @ts-ignore
        return getCampaignCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
