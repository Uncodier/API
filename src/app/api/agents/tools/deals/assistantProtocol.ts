/**
 * Assistant Protocol Wrapper for Deals Tool
 * Unified tool for managing deals (create, list, update, delete)
 */

import { getDealsCore } from '@/app/api/agents/tools/deals/get/route';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export interface DealsToolParams {
  action: 'create' | 'list' | 'update' | 'delete';
  
  // Create / Update params
  deal_id?: string;
  site_id?: string;
  name?: string;
  description?: string;
  amount?: number;
  currency?: string;
  stage?: 'discovery' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';
  status?: 'open' | 'won' | 'lost' | 'abandoned';
  qualification_tier?: 'unqualified' | 'exploratory' | 'startup' | 'smb' | 'enterprise';
  qualification_score?: number;
  qualification_details?: Record<string, unknown>;
  sales_id?: string;
  expected_close_date?: string;
  lead_ids?: string[];
  owner_ids?: string[];

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
        description: { type: 'string', description: 'Deal description' },
        amount: { type: 'number', description: 'Deal amount' },
        currency: { type: 'string', description: 'Currency code (e.g. USD)' },
        stage: { 
          type: 'string', 
          enum: ['discovery', 'proposal', 'negotiation', 'closed_won', 'closed_lost'],
          description: 'Deal stage in the sales pipeline'
        },
        status: {
          type: 'string',
          enum: ['open', 'won', 'lost', 'abandoned'],
          description: 'Overall deal status'
        },
        qualification_tier: {
          type: 'string',
          enum: ['unqualified', 'exploratory', 'startup', 'smb', 'enterprise'],
          description: 'Tier of qualification'
        },
        qualification_score: { type: 'number', description: 'Score from 0 to 100' },
        qualification_details: { type: 'object', description: 'JSON object with qualification specifics (e.g. BANT)' },
        sales_id: { type: 'string', description: 'Related Sale/Order UUID if closed' },
        expected_close_date: { type: 'string', description: 'ISO Date string for expected close' },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of Lead UUIDs attached to this deal'
        },
        owner_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of User UUIDs who own this deal'
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
          site_id: params.site_id || current_site_id,
        };

        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/deals/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Deal creation failed');
        }
        return data;
      }

      if (action === 'update') {
        if (!params.deal_id) {
          throw new Error('Missing deal_id for update action');
        }
        const body = {
          ...params,
          site_id: params.site_id || current_site_id,
        };
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/deals/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Deal update failed');
        }
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
        const res = await fetch(`${getApiBaseUrl()}/api/agents/tools/deals/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Deal deletion failed');
        }
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
