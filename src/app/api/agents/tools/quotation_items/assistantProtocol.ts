/**
 * Assistant Protocol Wrapper for Quotation Items Tool
 */
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

export interface QuotationItemsToolParams {
  action: 'create' | 'list' | 'update' | 'delete';
  
  id?: string;
  quotation_id?: string;
  catalog_item_id?: string;
  name?: string;
  quantity?: number;
  unit_price?: number;
  metadata?: Record<string, any>;
  
  limit?: number;
  offset?: number;
}

export function quotationItemsTool(current_site_id?: string) {
  return {
    name: 'quotation_items',
    description:
      'Manage lines (items) inside a quotation. Use action="create" to add an item. Use action="update" to change quantity/price. Use action="delete" to remove an item. These actions automatically recalculate the quotation totals.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'delete'],
          description: 'Action to perform on quotation items.'
        },
        id: { type: 'string', description: 'Item UUID (required for update, delete)' },
        quotation_id: { type: 'string', description: 'Quotation UUID (required for create, list)' },
        catalog_item_id: { type: 'string', description: 'Catalog Item UUID' },
        name: { type: 'string', description: 'Name of the item (optional if catalog_item_id is provided)' },
        quantity: { type: 'number', description: 'Quantity (defaults to 1)' },
        unit_price: { type: 'number', description: 'Unit price (optional if catalog_item_id is provided)' },
        metadata: { type: 'string', description: 'JSON string of metadata' },
        limit: { type: 'number', description: 'Limit results for list' },
        offset: { type: 'number', description: 'Offset results for list' },
      },
      required: ['action'],
    },
    execute: async (args: QuotationItemsToolParams) => {
      const { action, metadata, ...params } = args;

      if (action === 'create' && (!params.quotation_id || (!params.catalog_item_id && !params.name))) {
        throw new Error('Missing required fields for create: quotation_id, and either catalog_item_id or name');
      }
      
      if ((action === 'update' || action === 'delete') && !params.id) {
        throw new Error(`Missing required field id for action ${action}`);
      }

      const body = {
        action,
        ...params,
        metadata: metadata && typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
        site_id: current_site_id,
      };

      return await fetchApiTool('/api/agents/tools/quotation_items', body, `Quotation Items ${action} failed`);
    }
  };
}
