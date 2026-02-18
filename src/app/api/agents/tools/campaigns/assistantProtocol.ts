/**
 * Assistant Protocol Wrapper for Campaigns Tool
 * Unified tool for managing campaigns (create, list, update)
 */

import { getCampaignCore } from './get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface CampaignsToolParams {
  action: 'create' | 'list' | 'update';
  
  // Common/Create/Update params
  campaign_id?: string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  priority?: string;
  budget?: any;
  revenue?: any;
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
        budget: { type: 'object', description: 'Budget details' },
        revenue: { type: 'object', description: 'Revenue details' },
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
          site_id,
          user_id,
        };
        if (!params.title) {
           throw new Error('Missing required fields for create campaign: title');
        }

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/campaigns/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Create campaign failed');
        }
        return data;
      }

      if (action === 'update') {
        if (!params.campaign_id) {
            throw new Error('Missing required field for update campaign: campaign_id');
        }
        const body = {
          ...params,
          site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/campaigns/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || data.error || 'Update campaign failed');
        }
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
