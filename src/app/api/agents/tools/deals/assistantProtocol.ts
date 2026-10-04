/**
 * Assistant Protocol Wrapper for Deals Tool
 * Unified tool for managing deals (create, list, update, delete)
 */

import { getDealsCore } from '@/app/api/agents/tools/deals/get/core';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';



export interface DealsToolParams {
  action: 'create' | 'list' | 'update' | 'delete';
  
  // Create / Update params
  deal_id?: string;
  site_id?: string;
  name?: string;
  amount?: number;
  currency?: string;
  stage?: string;
  status?: string;
  company_id?: string;
  expected_close_date?: string;
  notes?: string;
  qualification_score?: number;
  qualification_criteria?: Record<string, unknown>;
  sales_order_id?: string;
  lead_ids?: string[] | string;
  owner_ids?: string[] | string;

  // List params
  limit?: number;
  offset?: number;
}

/**
 * Creates a deals tool for OpenAI/assistant compatibility
 */
export function dealsTool(current_site_id?: string) {
  return {
    name: 'deals',
    description:
      'Manage sales deals and opportunities. Use action="create" to record a new deal. Use action="update" to modify a deal. Use action="list" to search deals. Use action="delete" to remove a deal record.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete'],
          description: 'Action to perform on deals.'
        },
        deal_id: { type: 'string', description: 'Deal UUID (required for update/delete)' },
        site_id: { type: 'string', description: 'Site UUID' },
        name: { type: 'string', description: 'Deal name (required for create)' },
        amount: { type: 'number', description: 'Deal amount' },
        currency: { type: 'string', description: 'Currency code (e.g. USD)' },
        stage: { 
          type: 'string', 
          description: 'Deal stage in the sales pipeline (e.g. prospecting, proposal, negotiation, closed_won)'
        },
        status: {
          type: 'string',
          description: 'Overall deal status (e.g. open, won, lost)'
        },
        company_id: { type: 'string', description: 'Company UUID' },
        expected_close_date: { type: 'string', description: 'Date string for expected close (YYYY-MM-DD)' },
        notes: { type: 'string', description: 'Deal notes' },
        qualification_score: { type: 'number', description: 'Qualification score' },
        qualification_criteria: { type: 'string', description: 'JSON object with qualification specifics (as string)' },
        sales_order_id: { type: 'string', description: 'Related Sale/Order UUID if closed' },
        lead_ids: {
          type: 'string',
          description: 'Array of Lead UUIDs attached to this deal (comma-separated string)'
        },
        owner_ids: {
          type: 'string',
          description: 'Array of User UUIDs who own this deal (comma-separated string)'
        },
        limit: { type: 'number', description: 'Limit results' },
        offset: { type: 'number', description: 'Offset results' },
      },
      required: ['action'],
    },
    execute: async (args: DealsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create') {
        if (!params.name) {
           throw new Error('Missing required field for create deal: name');
        }

        const body = {
          ...params,
          qualification_criteria: params.qualification_criteria && typeof params.qualification_criteria === 'string' ? JSON.parse(params.qualification_criteria) : params.qualification_criteria,
          lead_ids: params.lead_ids && typeof params.lead_ids === 'string' ? params.lead_ids.split(',').map(id => id.trim()) : params.lead_ids,
          owner_ids: params.owner_ids && typeof params.owner_ids === 'string' ? params.owner_ids.split(',').map(id => id.trim()) : params.owner_ids,
          site_id: params.site_id || current_site_id,
        };

        const data = await fetchApiTool('/api/agents/tools/deals/create', body, 'Deal creation failed');
        return data;
      }

      if (action === 'update') {
        if (!params.deal_id) {
          throw new Error('Missing deal_id for update action');
        }
        const body = {
          ...params,
          qualification_criteria: params.qualification_criteria && typeof params.qualification_criteria === 'string' ? JSON.parse(params.qualification_criteria) : params.qualification_criteria,
          lead_ids: params.lead_ids && typeof params.lead_ids === 'string' ? params.lead_ids.split(',').map(id => id.trim()) : params.lead_ids,
          owner_ids: params.owner_ids && typeof params.owner_ids === 'string' ? params.owner_ids.split(',').map(id => id.trim()) : params.owner_ids,
          site_id: params.site_id || current_site_id,
        };
        const data = await fetchApiTool('/api/agents/tools/deals/update', body, 'Deal update failed');
        return data;
      }

      if (action === 'delete') {
        if (!params.deal_id) {
          throw new Error('Missing deal_id for delete action');
        }
        const body = {
          deal_id: params.deal_id,
          site_id: params.site_id || current_site_id,
        };
        const data = await fetchApiTool('/api/agents/tools/deals/delete', body, 'Deal deletion failed');
        return data;
      }

      if (action === 'list') {
        const filters = {
          ...params,
          site_id: params.site_id || current_site_id,
        };
        return getDealsCore(filters);
      }

      throw new Error(`Invalid action: ${action}`);
    },
  };
}
