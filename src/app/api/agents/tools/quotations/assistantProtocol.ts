/**
 * Assistant Protocol Wrapper for Quotations Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface QuotationsToolParams {
  action: 'create' | 'list' | 'get' | 'update' | 'delete';
  
  id?: string;
  site_id?: string;
  deal_id?: string;
  lead_id?: string;
  buyer_user_id?: string;
  price_list_id?: string;
  status?: string;
  valid_until?: string;
  currency?: string;
  notes?: string;
  
  limit?: number;
  offset?: number;
}

export function quotationsTool(current_site_id?: string) {
  return {
    name: 'quotations',
    description:
      'Manage commercial quotations. Use action="create" to start a draft quotation (requires lead_id). Use action="update" to change status (draft, sent, rejected, expired). Use action="list" or "get" to read. Use action="delete" to remove.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete'],
          description: 'Action to perform on quotations.'
        },
        id: { type: 'string', description: 'Quotation UUID (required for get, update, delete)' },
        site_id: { type: 'string', description: 'Site UUID (seller site)' },
        deal_id: { type: 'string', description: 'Deal UUID to attach this quotation to' },
        lead_id: { type: 'string', description: 'Lead UUID (required for create)' },
        buyer_user_id: { type: 'string', description: 'Buyer user UUID' },
        price_list_id: { type: 'string', description: 'Price list UUID to apply' },
        status: { type: 'string', enum: ['draft', 'sent', 'rejected', 'expired'], description: 'Quotation status: draft, sent, rejected, expired. "accepted" is strictly forbidden via this tool.' },
        valid_until: { type: 'string', description: 'Valid until date (ISO string)' },
        currency: { type: 'string', description: 'Currency code (e.g. USD)' },
        notes: { type: 'string', description: 'Notes for the quotation' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: QuotationsToolParams) => {
      const { action, ...params } = args;

      if (action === 'create' && !params.lead_id) {
        throw new Error('Missing required field for create: lead_id');
      }
      
      if ((action === 'update' || action === 'delete' || action === 'get') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        site_id: params.site_id || current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/quotations', body, `Quotations ${action} failed`);
    }
  };
}
